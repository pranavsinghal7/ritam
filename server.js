// Baseline backend: serves the website and handles signup.
// Run with: node server.js
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const Database = require('better-sqlite3');
const { dayKey, dailySummaries, computeScore } = require('./lib/score');
const chat = require('./lib/chat');
const notify = require('./lib/notify');

const PORT = process.env.PORT || 3000;

// ---------- Database (one file: baseline.db, created automatically) ----------
const db = new Database(path.join(__dirname, 'baseline.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS profiles (
    user_id        INTEGER PRIMARY KEY REFERENCES users(id),
    age            INTEGER NOT NULL,
    resting_bpm    INTEGER,            -- NULL when the person does not know
    conditions     TEXT NOT NULL,      -- JSON array of option codes
    medications    TEXT NOT NULL,      -- JSON array of {name, last_dose}
    updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS readings (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id  INTEGER NOT NULL REFERENCES users(id),
    taken_ms INTEGER NOT NULL,                 -- when the reading was taken (UTC milliseconds)
    bpm      INTEGER NOT NULL,
    state    TEXT NOT NULL CHECK (state IN ('resting','active')),
    source   TEXT NOT NULL CHECK (source IN ('manual','camera','sample')),
    level    INTEGER NOT NULL DEFAULT 0        -- alert level the app showed at that moment (0, 1 or 2)
  );
  CREATE INDEX IF NOT EXISTS idx_readings_user_time ON readings (user_id, taken_ms);
`);
const readingCols = db.prepare('PRAGMA table_info(readings)').all().map(c => c.name);
if (!readingCols.includes('quality')) db.exec('ALTER TABLE readings ADD COLUMN quality TEXT');   // camera signal quality: good | fair
const insertReading = db.prepare('INSERT INTO readings (user_id, taken_ms, bpm, state, source, level, quality) VALUES (?, ?, ?, ?, ?, ?, ?)');
const readingsSince = db.prepare('SELECT id, taken_ms, bpm, state, source, level, quality FROM readings WHERE user_id = ? AND taken_ms >= ? ORDER BY taken_ms');
const deleteSamples = db.prepare("DELETE FROM readings WHERE user_id = ? AND source = 'sample'");
const deleteReading = db.prepare('DELETE FROM readings WHERE user_id = ? AND id = ?');
const deleteAllReadings = db.prepare('DELETE FROM readings WHERE user_id = ?');

// Older databases made before the emergency contact existed: add the columns once.
const profileCols = db.prepare('PRAGMA table_info(profiles)').all().map(c => c.name);
for (const col of ['contact_name', 'contact_phone', 'contact_relation', 'contact_consent']) {
  if (!profileCols.includes(col)) db.exec('ALTER TABLE profiles ADD COLUMN ' + col + (col === 'contact_consent' ? ' INTEGER NOT NULL DEFAULT 0' : ' TEXT'));
}
db.exec(`
  CREATE TABLE IF NOT EXISTS alerts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL REFERENCES users(id),
    level         INTEGER NOT NULL,            -- 1 = Watch, 2 = Get medical help
    bpm           INTEGER,
    reasons       TEXT NOT NULL DEFAULT '[]',  -- JSON array of short sentences
    status        TEXT NOT NULL,               -- active | acknowledged | sending | escalated | failed | no_contact | logged
    demo          INTEGER NOT NULL DEFAULT 0,  -- 1 = demo episode: contact is never really messaged
    created_ms    INTEGER NOT NULL,
    escalate_at   INTEGER,                     -- when the contact will be messaged if nobody responds
    resolved_ms   INTEGER,
    contact_mode  TEXT,                        -- twilio | simulated
    contact_error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_alerts_user ON alerts (user_id, created_ms);
`);
db.exec("DELETE FROM sessions WHERE created_at < datetime('now', '-8 days')");                    // tidy up old logins
const insertUser = db.prepare(
  'INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)'
);
const findByEmail = db.prepare('SELECT id FROM users WHERE email = ?');
const deleteSession = db.prepare('DELETE FROM sessions WHERE token_hash = ?');
const findLogin = db.prepare('SELECT id, name, email, password_hash FROM users WHERE email = ?');
const insertSession = db.prepare('INSERT INTO sessions (token_hash, user_id) VALUES (?, ?)');
const userBySession = db.prepare(
  "SELECT u.id, u.name, u.email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.created_at > datetime('now', '-7 days')"
);
const getProfile = db.prepare('SELECT age, resting_bpm, conditions, medications, contact_name, contact_phone, contact_relation, contact_consent FROM profiles WHERE user_id = ?');
const saveProfile = db.prepare(`
  INSERT INTO profiles (user_id, age, resting_bpm, conditions, medications, contact_name, contact_phone, contact_relation, contact_consent)
  VALUES (@user_id, @age, @resting_bpm, @conditions, @medications, @contact_name, @contact_phone, @contact_relation, @contact_consent)
  ON CONFLICT(user_id) DO UPDATE SET
    age = excluded.age, resting_bpm = excluded.resting_bpm,
    conditions = excluded.conditions, medications = excluded.medications,
    contact_name = excluded.contact_name, contact_phone = excluded.contact_phone,
    contact_relation = excluded.contact_relation, contact_consent = excluded.contact_consent,
    updated_at = datetime('now')
`);

// ---------- Password hashing (never store the real password) ----------
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return salt.toString('hex') + ':' + hash.toString('hex');
}

function verifyPassword(password, stored) {
  const [saltHex, hashHex] = String(stored).split(':');
  const expected = Buffer.from(hashHex || '', 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex || '', 'hex'), 64);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}
const DUMMY_HASH = hashPassword('not-a-real-password');   // so unknown emails take as long as real ones

// ---------- Sessions (a random token in an httpOnly cookie) ----------
const sha = t => crypto.createHash('sha256').update(t).digest('hex');

function startSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  insertSession.run(sha(token), userId);
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.setHeader('Set-Cookie',
    'sid=' + token + '; HttpOnly; SameSite=Lax; Path=/; Max-Age=' + 7 * 24 * 3600 + secure);
}
const sessionToken = req => { const m = /(?:^|;\s*)sid=([0-9a-f]{64})/.exec(req.headers.cookie || ''); return m && m[1]; };

function requireUser(req, res, next) {
  const tok = sessionToken(req);
  const user = tok && userBySession.get(sha(tok));
  if (!user) return res.status(401).json({ errors: { form: 'Please sign up or log in first.' } });
  req.user = user;
  next();
}

// ---------- Validation ----------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateSignup(body) {
  const name = String(body.name || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const errors = {};
  if (name.length < 2 || name.length > 80) errors.name = 'Enter your name (2 to 80 characters).';
  if (!EMAIL_RE.test(email) || email.length > 254) errors.email = 'Enter a valid email address.';
  if (password.length < 8 || password.length > 128) errors.password = 'Use a password of 8 to 128 characters.';
  return { name, email, password, errors };
}

const CONDITIONS = ['heart_disease', 'previous_heart_attack', 'irregular_heartbeat',
  'high_blood_pressure', 'diabetes', 'thyroid_disorder', 'anemia', 'kidney_disease'];
const EXCLUSIVE = ['none', 'prefer_not_to_say'];

function validateProfile(b) {
  const errors = {};
  const age = Number(b.age);
  if (!Number.isInteger(age) || age < 1 || age > 120) errors.age = 'Enter your age in years (1 to 120).';

  let resting_bpm = null;
  if (!b.restingUnknown) {
    const v = Number(b.restingBpm);
    if (b.restingBpm === '' || b.restingBpm == null || !Number.isInteger(v) || v < 30 || v > 200) {
      errors.restingBpm = 'Enter a pulse between 30 and 200, or tick "I don\'t know".';
    } else resting_bpm = v;
  }

  const raw = Array.isArray(b.conditions) ? [...new Set(b.conditions.map(String))] : [];
  const allowed = [...CONDITIONS, ...EXCLUSIVE];
  let conditions = raw.filter(c => allowed.includes(c));
  if (!conditions.length) errors.conditions = 'Choose at least one option, or "None".';
  else if (conditions.some(c => EXCLUSIVE.includes(c)) && conditions.length > 1) {
    errors.conditions = '"None" and "Prefer not to say" cannot be combined with other options.';
  }

  const medications = [];
  const meds = Array.isArray(b.medications) ? b.medications : [];
  if (meds.length > 10) errors.medications = 'Add up to 10 medicines.';
  for (const m of meds.slice(0, 10)) {
    const name = String((m && m.name) || '').trim();
    const last = String((m && m.lastDose) || '').trim();
    if (!name && !last) continue;                       // blank row, ignore
    if (!name) { errors.medications = 'Each dose needs a medicine name.'; break; }
    if (name.length > 80 || last.length > 40) { errors.medications = 'Medicine details are too long.'; break; }
    if (last && Number.isNaN(Date.parse(last))) { errors.medications = 'Enter the last dose as a valid date and time.'; break; }
    medications.push({ name, last_dose: last || null });
  }
  // Emergency contact: optional, but name and phone go together
  const c = b.contact || {};
  const cName = String(c.name || '').trim();
  const cPhone = String(c.phone || '').trim();
  const cRel = String(c.relation || '').trim();
  let contact = null;
  if (cName || cPhone || cRel) {
    const digits = cPhone.replace(/\D/g, '');
    if (cName.length < 2 || cName.length > 80) errors.contactName = 'Enter your contact\'s name.';
    if (!/^\+?[0-9 ()-]+$/.test(cPhone) || digits.length < 7 || digits.length > 15) {
      errors.contactPhone = 'Enter a phone number with 7 to 15 digits. A leading + is fine.';
    }
    if (cRel.length > 40) errors.contactRelation = 'Keep the relationship short (40 characters).';
    if (b.contactConsent !== true) errors.contactConsent = 'Tick the box to confirm your contact agreed to receive these messages.';
    contact = { name: cName, phone: cPhone.replace(/[^0-9+]/g, ''), relation: cRel, consent: b.contactConsent === true };
  }
  return { errors, value: { age, resting_bpm, conditions, medications, contact } };
}

function profileOut(row) {
  return row && {
    age: row.age,
    restingBpm: row.resting_bpm,
    restingUnknown: row.resting_bpm == null,
    conditions: JSON.parse(row.conditions),
    medications: JSON.parse(row.medications).map(m => ({ name: m.name, lastDose: m.last_dose })),
    contact: row.contact_phone ? { name: row.contact_name, phone: row.contact_phone, relation: row.contact_relation || '', consent: !!row.contact_consent } : null
  };
}

// ---------- Server ----------
const app = express();
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/signup', (req, res) => {
  const { name, email, password, errors } = validateSignup(req.body || {});
  if (Object.keys(errors).length) return res.status(400).json({ errors });

  if (findByEmail.get(email)) {
    return res.status(409).json({ errors: { email: 'An account with this email already exists.' } });
  }
  try {
    const info = insertUser.run(name, email, hashPassword(password));
    startSession(req, res, info.lastInsertRowid);
    res.status(201).json({ ok: true, user: { id: info.lastInsertRowid, name, email } });
  } catch (e) {
    // Two people signing up with the same email at the same instant
    if (String(e.code).startsWith('SQLITE_CONSTRAINT')) {
      return res.status(409).json({ errors: { email: 'An account with this email already exists.' } });
    }
    console.error(e);
    res.status(500).json({ errors: { form: 'Something went wrong. Please try again.' } });
  }
});

// Log in. Wrong email and wrong password give the same message. After 8 failures, wait 10 minutes.
const failures = new Map();
app.post('/api/login', (req, res) => {
  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
  const password = String((req.body && req.body.password) || '');
  const key = req.ip + '|' + email;
  const now = Date.now(), recent = (failures.get(key) || []).filter(t => now - t < 600000);
  if (recent.length >= 8) return res.status(429).json({ errors: { form: 'Too many attempts. Please wait a few minutes and try again.' } });
  if (!EMAIL_RE.test(email) || !password || password.length > 128) {
    return res.status(400).json({ errors: { form: 'Enter your email and password.' } });
  }
  const u = findLogin.get(email);
  const ok = verifyPassword(password, u ? u.password_hash : DUMMY_HASH) && !!u;
  if (!ok) {
    recent.push(now); failures.set(key, recent);
    return res.status(401).json({ errors: { form: 'That email and password do not match.' } });
  }
  failures.delete(key);
  startSession(req, res, u.id);
  res.json({ ok: true, user: { id: u.id, name: u.name, email: u.email } });
});

app.post('/api/logout', (req, res) => {
  const tok = sessionToken(req);
  if (tok) deleteSession.run(sha(tok));
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/me', requireUser, (req, res) => {
  res.json({ user: req.user, profile: profileOut(getProfile.get(req.user.id)) || null, settings: notify.settings() });
});

app.put('/api/profile', requireUser, (req, res) => {
  const { errors, value } = validateProfile(req.body || {});
  if (Object.keys(errors).length) return res.status(400).json({ errors });
  saveProfile.run({
    user_id: req.user.id, age: value.age, resting_bpm: value.resting_bpm,
    conditions: JSON.stringify(value.conditions), medications: JSON.stringify(value.medications),
    contact_name: value.contact && value.contact.name, contact_phone: value.contact && value.contact.phone,
    contact_relation: value.contact && value.contact.relation,
    contact_consent: value.contact && value.contact.consent ? 1 : 0
  });
  res.json({ ok: true });
});

// ---------- Readings, heart score, sample data ----------
const SLOWING_RE = /olol\b|carvedilol|diltiazem|verapamil|digoxin|ivabradine|clonidine/i;

function profileFlags(row) {
  if (!row) return { limit: 100, slowing: false, age: null, conditions: [] };
  const c = JSON.parse(row.conditions), meds = JSON.parse(row.medications);
  const risk = (row.age >= 55 ? 1 : 0) + ['high_blood_pressure', 'diabetes'].filter(x => c.includes(x)).length
    + (['heart_disease', 'previous_heart_attack', 'irregular_heartbeat'].some(x => c.includes(x)) ? 1 : 0);
  return { limit: risk >= 2 ? 95 : 100, slowing: meds.some(m => SLOWING_RE.test(m.name)), age: row.age, conditions: c, restingBpm: row.resting_bpm };
}

const tzOf = q => { const t = Number(q); return Number.isFinite(t) && Math.abs(t) <= 840 ? Math.round(t) : 0; };

function summary(userId, tz) {
  const now = Date.now();
  const rows = readingsSince.all(userId, now - 31 * 86400000);
  const flags = profileFlags(getProfile.get(userId));
  const today = dayKey(now, tz);
  const days = dailySummaries(rows, tz);
  return {
    // earlier days only: today's readings are handled live in the dashboard
    days: days.filter(d => d.date < today).slice(-30),
    // saved readings from the last 6 hours, so the alert rules keep working after a page reload
    live: rows.filter(r => r.taken_ms >= now - 6 * 3600000 && r.source !== 'sample')
      .map(r => ({ t: r.taken_ms, bpm: r.bpm, state: r.state })),
    recent: rows.slice(-25).reverse().map(r => ({ id: r.id, t: r.taken_ms, bpm: r.bpm, state: r.state, source: r.source, level: r.level, quality: r.quality })),
    total: rows.length,
    hasSample: rows.some(r => r.source === 'sample'),
    score: computeScore(rows, tz, now, flags),
    flags
  };
}

app.get('/api/summary', requireUser, (req, res) => res.json(summary(req.user.id, tzOf(req.query.tz))));

app.post('/api/readings', requireUser, (req, res) => {
  const b = req.body || {};
  const bpm = Number(b.bpm), now = Date.now();
  const errors = {};
  if (!Number.isInteger(bpm) || bpm < 20 || bpm > 250) errors.bpm = 'Enter a pulse between 20 and 250 beats per minute.';
  if (b.state !== 'resting' && b.state !== 'active') errors.state = 'State must be resting or active.';
  const source = b.source === 'camera' ? 'camera' : 'manual';
  const level = [0, 1, 2].includes(Number(b.level)) ? Number(b.level) : 0;
  let takenMs = b.takenAt ? Date.parse(b.takenAt) : now;
  if (!Number.isFinite(takenMs) || takenMs > now + 5 * 60000 || takenMs < now - 365 * 86400000) errors.takenAt = 'That time is not valid.';
  if (Object.keys(errors).length) return res.status(400).json({ errors });
  const quality = source === 'camera' && (b.quality === 'good' || b.quality === 'fair') ? b.quality : null;
  insertReading.run(req.user.id, takenMs, bpm, b.state, source, level, quality);
  res.status(201).json({ ok: true });
});

// 14 days of typical-looking readings, clearly marked as sample data, so the heart score can be shown right away
app.post('/api/readings/sample', requireUser, (req, res) => {
  const tz = tzOf(req.body && req.body.tz);
  const flags = profileFlags(getProfile.get(req.user.id));
  const usual = flags.restingBpm || 68;
  const now = Date.now();
  const localMidnight = Math.floor((now - tz * 60000) / 86400000) * 86400000 + tz * 60000;
  let seed = 12345;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const tx = db.transaction(() => {
    deleteSamples.run(req.user.id);
    for (let d = 14; d >= 1; d--) {
      const dayMean = usual + (rnd() - 0.5) * 5;
      for (const hour of [7.5, 12, 18.5, 22]) {
        insertReading.run(req.user.id, Math.round(localMidnight - d * 86400000 + hour * 3600000), Math.round(dayMean + (rnd() - 0.5) * 6), 'resting', 'sample', 0, null);
      }
      insertReading.run(req.user.id, Math.round(localMidnight - d * 86400000 + 16.5 * 3600000), Math.round(usual + 25 + rnd() * 20), 'active', 'sample', 0, null);
    }
  });
  tx();
  res.json({ ok: true });
});

app.delete('/api/readings/sample', requireUser, (req, res) => { deleteSamples.run(req.user.id); res.json({ ok: true }); });

// Delete one reading, or every reading, of the signed-in user. Scores and "your normal" are recalculated from what is left.
app.delete('/api/readings/:id', requireUser, (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid reading.' });
  const info = deleteReading.run(req.user.id, Number(req.params.id));
  if (!info.changes) return res.status(404).json({ error: 'That reading was not found.' });
  res.json({ ok: true });
});
app.delete('/api/readings', requireUser, (req, res) => {
  const info = deleteAllReadings.run(req.user.id);
  res.json({ ok: true, deleted: info.changes });
});

app.get('/api/readings.csv', requireUser, (req, res) => {
  const rows = db.prepare('SELECT taken_ms, bpm, state, source, level, quality FROM readings WHERE user_id = ? ORDER BY taken_ms').all(req.user.id);
  const lines = ['time_utc,bpm,state,source,alert_level,camera_quality'].concat(rows.map(r => [new Date(r.taken_ms).toISOString(), r.bpm, r.state, r.source, r.level, r.quality || ''].join(',')));
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="baseline-readings.csv"' }).send(lines.join('\n') + '\n');
});


// ---------- Alerts: notify the person, then their emergency contact if nobody responds ----------
// Level 2 ("Get medical help") starts a countdown. If the person does not tap "I'm OK" / "I've got help"
// before it ends, the server texts their emergency contact (only if they gave one AND ticked the consent box).
// The countdown runs on the server, so it still works if the browser tab is closed after the alert starts.
const MAX_CONTACT_MESSAGES_PER_DAY = 3;
const COOLDOWN_MS = 30 * 60000;      // no second alert of the same level within 30 minutes of the last one
const getAlert = db.prepare('SELECT * FROM alerts WHERE id = ? AND user_id = ?');
const insertAlert = db.prepare('INSERT INTO alerts (user_id, level, bpm, reasons, status, demo, created_ms, escalate_at, resolved_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
const openAlertFor = db.prepare("SELECT * FROM alerts WHERE user_id = ? AND level = 2 AND status IN ('active','sending') ORDER BY id DESC LIMIT 1");
const lastAlertFor = db.prepare('SELECT * FROM alerts WHERE user_id = ? AND level = ? AND demo = ? ORDER BY id DESC LIMIT 1');
const recentAlerts = db.prepare('SELECT * FROM alerts WHERE user_id = ? ORDER BY id DESC LIMIT 20');
const sentToday = db.prepare("SELECT COUNT(*) n FROM alerts WHERE user_id = ? AND demo = 0 AND status = 'escalated' AND resolved_ms > ?");

const alertOut = a => a && {
  id: a.id, level: a.level, bpm: a.bpm, reasons: JSON.parse(a.reasons), status: a.status, demo: !!a.demo,
  createdAt: a.created_ms, escalateAt: a.escalate_at, resolvedAt: a.resolved_ms,
  contactMode: a.contact_mode, error: a.contact_error, serverNow: Date.now()
};

function contactFor(userId) {
  const p = getProfile.get(userId);
  if (!p || !p.contact_phone) return { ok: false, why: 'no_contact' };
  if (!p.contact_consent) return { ok: false, why: 'no_consent' };
  return { ok: true, name: p.contact_name, phone: p.contact_phone };
}

app.post('/api/alerts', requireUser, (req, res) => {
  const b = req.body || {};
  const level = Number(b.level);
  if (level !== 1 && level !== 2) return res.status(400).json({ error: 'Alert level must be 1 or 2.' });
  const bpm = Number.isInteger(Number(b.bpm)) && Number(b.bpm) >= 20 && Number(b.bpm) <= 250 ? Number(b.bpm) : null;
  const reasons = (Array.isArray(b.reasons) ? b.reasons : []).slice(0, 5).map(r => String(r).slice(0, 200));
  const demo = b.demo === true;
  const now = Date.now();

  // Already counting down? Just return it (stops duplicate texts when the page refreshes).
  const open = level === 2 && openAlertFor.get(req.user.id);
  if (open) return res.json({ alert: alertOut(open), duplicate: true });
  // Cooldown: same level again within 30 minutes is not a new alert
  const last = lastAlertFor.get(req.user.id, level, demo ? 1 : 0);
  if (!demo && last && now - last.created_ms < COOLDOWN_MS) return res.json({ alert: alertOut(last), duplicate: true });

  if (level === 1) {
    const info = insertAlert.run(req.user.id, 1, bpm, JSON.stringify(reasons), 'logged', demo ? 1 : 0, now, null, now);
    return res.status(201).json({ alert: alertOut(getAlert.get(info.lastInsertRowid, req.user.id)) });
  }
  const c = contactFor(req.user.id);
  const wait = (demo ? notify.settings().demoSeconds : notify.settings().escalateSeconds) * 1000;
  const status = c.ok ? 'active' : 'no_contact';
  const info = insertAlert.run(req.user.id, 2, bpm, JSON.stringify(reasons), status === 'active' ? 'active' : 'no_contact', demo ? 1 : 0, now, c.ok ? now + wait : null, c.ok ? null : now);
  const out = alertOut(getAlert.get(info.lastInsertRowid, req.user.id));
  out.contactIssue = c.ok ? null : c.why;
  res.status(201).json({ alert: out });
});

app.get('/api/alerts', requireUser, (req, res) => {
  const all = recentAlerts.all(req.user.id);
  const open = all.find(a => a.level === 2 && (a.status === 'active' || a.status === 'sending'));
  res.json({ active: alertOut(open) || null, history: all.map(alertOut), serverNow: Date.now() });
});

// "I'm OK" / "I've got help": stops the countdown. Too late once the contact has been messaged.
app.post('/api/alerts/:id/ack', requireUser, (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid alert.' });
  const a = getAlert.get(Number(req.params.id), req.user.id);
  if (!a) return res.status(404).json({ error: 'That alert was not found.' });
  const info = db.prepare("UPDATE alerts SET status = 'acknowledged', resolved_ms = ?, escalate_at = NULL WHERE id = ? AND user_id = ? AND status = 'active'").run(Date.now(), a.id, req.user.id);
  res.json({ alert: alertOut(getAlert.get(a.id, req.user.id)), changed: info.changes > 0 });
});

// "Message my contact now": skips the wait.
app.post('/api/alerts/:id/escalate', requireUser, async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid alert.' });
  const a = getAlert.get(Number(req.params.id), req.user.id);
  if (!a) return res.status(404).json({ error: 'That alert was not found.' });
  const c = contactFor(req.user.id);
  if (!c.ok) return res.status(409).json({ error: c.why === 'no_consent' ? 'Confirm your contact agreed to messages in your profile first.' : 'Add an emergency contact in your profile first.' });
  if (a.status === 'active' || a.status === 'no_contact') await escalate(a.id);
  res.json({ alert: alertOut(getAlert.get(a.id, req.user.id)) });
});

async function escalate(alertId) {
  // Claim it first so two timers can never send twice
  const claim = db.prepare("UPDATE alerts SET status = 'sending' WHERE id = ? AND status IN ('active','no_contact')").run(alertId);
  if (!claim.changes) return;
  const a = db.prepare('SELECT * FROM alerts WHERE id = ?').get(alertId);
  const user = db.prepare('SELECT name FROM users WHERE id = ?').get(a.user_id);
  const c = contactFor(a.user_id);
  const finish = (status, mode, err) => db.prepare('UPDATE alerts SET status = ?, resolved_ms = ?, contact_mode = ?, contact_error = ? WHERE id = ?').run(status, Date.now(), mode || null, err || null, alertId);
  if (!c.ok) return finish('no_contact', null, 'No emergency contact with consent.');
  if (!a.demo && sentToday.get(a.user_id, Date.now() - 86400000).n >= MAX_CONTACT_MESSAGES_PER_DAY) return finish('failed', null, 'Daily limit of messages to your contact reached.');
  const reasons = JSON.parse(a.reasons);
  const body = (a.demo ? '[DEMO - not a real emergency] ' : '') +
    'Baseline alert: ' + user.name + ' had an unusual heart-rate pattern' + (a.bpm ? ' (' + a.bpm + ' bpm)' : '') +
    ' and has not responded to the warning. Please call them now. If you cannot reach them or they seem unwell, call emergency services (112 in India). ' +
    'This app cannot diagnose a heart problem.' + (reasons[0] ? ' Reason: ' + reasons[0] : '');
  const r = a.demo ? { ok: true, mode: 'simulated' } : await notify.sendSms(notify.toE164(c.phone), body);
  if (a.demo) console.log('[DEMO - SMS not sent] ' + body);
  finish(r.ok ? 'escalated' : 'failed', r.mode, r.error);
}

// Every 5 seconds: message contacts for alerts whose countdown ended without a response
setInterval(() => {
  const due = db.prepare("SELECT id FROM alerts WHERE status = 'active' AND escalate_at IS NOT NULL AND escalate_at <= ?").all(Date.now());
  for (const d of due) escalate(d.id).catch(e => console.error('escalate error:', e.message));
}, 5000).unref();

// ---------- AI chatbot ----------
app.get('/api/chat/status', requireUser, (req, res) => res.json({ configured: chat.isConfigured() }));

app.post('/api/chat', requireUser, async (req, res) => {
  const messages = chat.cleanMessages(req.body && req.body.messages);
  if (!messages) return res.status(400).json({ error: 'Send a question first.' });
  if (chat.rateLimited(req.user.id)) return res.status(429).json({ error: 'You have asked a lot of questions. Please wait a few minutes and try again.' });

  const last = messages[messages.length - 1].content;
  const emergency = chat.EMERGENCY_RE.test(last);
  const note = emergency ? chat.EMERGENCY_NOTE : '';

  if (!chat.isConfigured()) {
    // Safety text still works without an AI key
    return res.status(503).json({ error: 'The AI assistant is not switched on yet. The site owner needs to add an API key on the server.', emergency, note });
  }
  try {
    const tz = tzOf(req.body.tz);
    const sum = summary(req.user.id, tz);
    const ctx = chat.cleanContext(req.body.context);
    const data = {
      age: sum.flags.age,
      conditions: sum.flags.conditions,
      takesPulseSlowingMedicine: sum.flags.slowing,
      heartScore: sum.score.ready
        ? { score: sum.score.score, band: sum.score.band, basedOn: sum.score.basis, parts: sum.score.components.map(c => ({ part: c.label, points: c.points + ' of ' + c.max, note: c.note })), limits: sum.score.caps }
        : { status: 'not enough records yet' },
      usualRestingRange: ctx.usualRestingRange,
      alertRightNow: ctx.alertLevel, alertFindings: ctx.findings, symptomsNow: ctx.symptomsNow,
      lastReadings: sum.recent.slice(0, 10).map(r => `${new Date(r.t).toISOString()} ${r.bpm} bpm ${r.state} (${r.source})`)
    };
    const reply = await chat.ask(chat.buildSystemPrompt(data), messages);
    if (!reply) throw new Error('empty reply');
    res.json({ reply, emergency, note });
  } catch (e) {
    console.error('chat error:', e.message);
    res.status(502).json({ error: 'The AI assistant could not answer just now. Please try again in a moment.', emergency, note });
  }
});

// If the server stopped in the middle of sending, do not risk a double text: mark it failed
db.exec("UPDATE alerts SET status = 'failed', contact_error = 'Server restarted while sending.' WHERE status = 'sending'");
app.listen(PORT, () => console.log('Baseline running at http://localhost:' + PORT));
