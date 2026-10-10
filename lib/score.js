// Heart score and daily summaries, calculated from a person's saved readings.
// Everything here is plain arithmetic so it can be explained on screen.
// The score is a summary of pulse records. It is NOT a medical measure.

const MIN_READINGS = 6;
const MIN_DAYS = 2;
const WINDOW_DAYS = 14;

const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const sd = a => { const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) ** 2))); };
const round1 = x => Math.round(x * 10) / 10;
const lerp = (x, x0, x1, y0, y1) => y0 + (y1 - y0) * Math.min(1, Math.max(0, (x - x0) / (x1 - x0)));

// Local calendar day (YYYY-MM-DD). tz is the browser's getTimezoneOffset(): minutes, negative east of UTC.
function dayKey(ms, tz) { return new Date(ms - tz * 60000).toISOString().slice(0, 10); }

// rows: [{ taken_ms, bpm, state, source, level }]
function dailySummaries(rows, tz) {
  const byDay = new Map();
  for (const r of rows) {
    const k = dayKey(r.taken_ms, tz);
    if (!byDay.has(k)) byDay.set(k, { date: k, rest: [], all: 0, flagged: false, max: 0, min: 999 });
    const d = byDay.get(k);
    d.all++; d.max = Math.max(d.max, r.bpm); d.min = Math.min(d.min, r.bpm);
    if (r.state === 'resting') d.rest.push(r.bpm);
    if (r.level >= 1 && r.source !== 'sample') d.flagged = true;
  }
  return [...byDay.values()].sort((a, b) => a.date < b.date ? -1 : 1).map(d => ({
    date: d.date,
    restMean: d.rest.length ? round1(mean(d.rest)) : null,
    nResting: d.rest.length, nAll: d.all, max: d.max, min: d.min, flagged: d.flagged
  }));
}

function slopePerDay(days) {            // least-squares slope of daily means, in bpm per day
  const n = days.length, xs = days.map((_, i) => i), ys = days.map(d => d.restMean);
  const mx = mean(xs), my = mean(ys);
  let num = 0, den = 0;
  xs.forEach((x, i) => { num += (x - mx) * (ys[i] - my); den += (x - mx) ** 2; });
  return den ? num / den : 0;
}

// flags: { limit (fast-pulse limit at rest: 100, or 95 with 2+ risk factors), slowing (takes a pulse-slowing medicine) }
function computeScore(rows, tz, nowMs, flags) {
  const since = nowMs - WINDOW_DAYS * 86400000;
  const win = rows.filter(r => r.taken_ms >= since);
  const rest = win.filter(r => r.state === 'resting');
  const days = dailySummaries(win, tz).filter(d => d.restMean != null);
  if (rest.length < MIN_READINGS || days.length < MIN_DAYS) {
    return { ready: false, have: { readings: rest.length, days: days.length }, need: { readings: MIN_READINGS, days: MIN_DAYS } };
  }

  const comps = [];
  const m = mean(rest.map(r => r.bpm));

  // 1. Resting level (35 points)
  let pts, note;
  if (m >= 50 && m <= 75) { pts = 35; note = 'In a typical resting range.'; }
  else if (m > 75) { pts = m <= 90 ? lerp(m, 75, 90, 35, 15) : lerp(m, 90, 110, 15, 0); note = m <= 90 ? 'A little above the typical range.' : 'Above 90 beats per minute at rest.'; }
  else if (flags.slowing) { pts = 35; note = 'Low, which is expected with a pulse-slowing medicine.'; }
  else { pts = lerp(m, 50, 30, 35, 0); note = 'Below 50 beats per minute at rest.'; }
  comps.push({ key: 'level', label: 'Resting pulse', max: 35, points: Math.round(pts), note: `Average ${Math.round(m)} bpm. ${note}` });

  // 2. Day-to-day steadiness (20 points)
  const s = days.length >= 2 ? sd(days.map(d => d.restMean)) : 0;
  comps.push({ key: 'stability', label: 'Steadiness', max: 20, points: Math.round(lerp(s, 3, 10, 20, 0)),
    note: `Daily resting averages vary by about ${round1(s)} bpm.` });

  // 3. How often the resting pulse was high (25 points)
  const high = rest.filter(r => r.bpm > flags.limit).length / rest.length;
  comps.push({ key: 'high', label: 'High resting readings', max: 25, points: Math.round(25 * (1 - Math.min(1, high / 0.2))),
    note: `${Math.round(high * 100)}% of resting readings were above ${flags.limit} bpm.` });

  // 4. Direction over the days (20 points)
  let tPts = 20, tNote = 'Needs 3 days of records to show a direction.';
  if (days.length >= 3) {
    const sl = slopePerDay(days);
    const pen = (sl < 0 && flags.slowing) ? 0 : Math.abs(sl);
    tPts = lerp(pen, 0.3, 1.5, 20, 0);
    tNote = `Daily averages are ${Math.abs(sl) < 0.3 ? 'steady' : sl > 0 ? 'rising' : 'falling'} (${sl >= 0 ? '+' : ''}${round1(sl)} bpm a day).`;
  }
  comps.push({ key: 'trend', label: 'Direction', max: 20, points: Math.round(tPts), note: tNote });

  let score = comps.reduce((t, c) => t + c.points, 0);
  const caps = [];
  const real = win.filter(r => r.source !== 'sample');
  if (real.some(r => r.level === 2)) { if (score > 59) score = 59; caps.push('A serious alert in the last 14 days limits the score to 59.'); }
  else if (real.some(r => r.level === 1)) { if (score > 79) score = 79; caps.push('A "watch closely" alert in the last 14 days limits the score to 79.'); }

  const band = score >= 80 ? 'Steady' : score >= 60 ? 'Some variation' : 'Worth discussing with a doctor';
  return {
    ready: true, score, band, components: comps, caps,
    basis: { readings: rest.length, days: days.length, includesSample: win.some(r => r.source === 'sample'), averageResting: Math.round(m) }
  };
}

module.exports = { dayKey, dailySummaries, computeScore, MIN_READINGS, MIN_DAYS };
