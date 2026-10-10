// Sends the text message to the emergency contact.
// With Twilio keys in .env it sends a real SMS. Without them it only "simulates":
// the message is written to the server log and the app says clearly that nothing was sent.
const E = process.env;

const settings = () => ({
  escalateSeconds: clamp(parseInt(E.ESCALATE_AFTER_SECONDS, 10), 30, 1800, 120),
  demoSeconds: clamp(parseInt(E.DEMO_ESCALATE_SECONDS, 10), 5, 600, 20),
  smsMode: isTwilio() ? 'twilio' : 'simulated'
});

function clamp(v, lo, hi, dflt) { return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt; }
function isTwilio() { return !!(E.TWILIO_ACCOUNT_SID && E.TWILIO_AUTH_TOKEN && E.TWILIO_FROM && (E.SMS_PROVIDER || 'twilio') === 'twilio'); }

// "98765 43210" -> "+919876543210" using DEFAULT_COUNTRY_CODE (default +91). Numbers already starting with + are kept.
function toE164(phone) {
  const raw = String(phone || '').trim();
  const digits = raw.replace(/\D/g, '');
  if (raw.startsWith('+')) return digits.length >= 7 && digits.length <= 15 ? '+' + digits : null;
  const cc = String(E.DEFAULT_COUNTRY_CODE || '+91').replace(/\D/g, '');
  let local = digits.replace(/^0+/, '');
  if (cc && local.startsWith(cc) && local.length > 10) local = local.slice(cc.length);
  const full = cc + local;
  return full.length >= 8 && full.length <= 15 ? '+' + full : null;
}

async function sendSms(to, body) {
  if (!to) return { ok: false, mode: 'none', error: 'The contact phone number is not valid.' };
  if (!isTwilio()) {
    console.log('[SIMULATED SMS to ' + to + '] ' + body);
    return { ok: true, mode: 'simulated' };
  }
  const base = (E.TWILIO_BASE_URL || 'https://api.twilio.com').replace(/\/$/, '');
  const url = base + '/2010-04-01/Accounts/' + encodeURIComponent(E.TWILIO_ACCOUNT_SID) + '/Messages.json';
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(E.TWILIO_ACCOUNT_SID + ':' + E.TWILIO_AUTH_TOKEN).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({ To: to, From: E.TWILIO_FROM, Body: body }),
      signal: AbortSignal.timeout(15000)
    });
    if (r.ok) return { ok: true, mode: 'twilio' };
    let msg = 'SMS service refused the message (' + r.status + ').';
    try { const j = await r.json(); if (j && j.message) msg = String(j.message).slice(0, 200); } catch (_) {}
    return { ok: false, mode: 'twilio', error: msg };
  } catch (e) {
    return { ok: false, mode: 'twilio', error: 'Could not reach the SMS service.' };
  }
}

module.exports = { settings, toE164, sendSms };
