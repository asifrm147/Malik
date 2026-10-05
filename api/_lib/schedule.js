import { knack, O, F, raw, rule } from './knack.js';

export const PRACTICE_TZ = 'America/Los_Angeles';
export const SLOT_HOURS = [9, 10, 11];
export const SLOT_MINUTES = 50;
export const MIN_LEAD_HOURS = 14;
export const HOLD_MINUTES = 15;
export const WEEKS_AHEAD = 8;

// Returns the UTC Date for a wall-clock time in a time zone (handles daylight saving).
export function zoned(y, m, d, h, tz = PRACTICE_TZ) {
  const guess = new Date(Date.UTC(y, m - 1, d, h));
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric' }).formatToParts(guess).map(p => [p.type, +p.value || p.value]));
  const asIfUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour);
  return new Date(guess.getTime() - (asIfUtc - guess.getTime()));
}

export function mondaySlots(now = new Date()) {
  const out = [];
  const pt = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: PRACTICE_TZ, year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short' }).formatToParts(now).map(p => [p.type, p.value]));
  const base = new Date(Date.UTC(+pt.year, +pt.month - 1, +pt.day));
  for (let i = 0; i < WEEKS_AHEAD * 7; i++) {
    const day = new Date(base.getTime() + i * 86400000);
    if (day.getUTCDay() !== 1) continue; // Monday
    for (const h of SLOT_HOURS) {
      const start = zoned(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), h);
      if (start.getTime() - now.getTime() >= MIN_LEAD_HOURS * 3600000) out.push(start);
    }
  }
  return out;
}

// Appointments that block a slot: Booked, or Held with an unexpired hold.
export async function takenStarts(now = new Date()) {
  const today = new Intl.DateTimeFormat('en-US', { timeZone: process.env.KNACK_APP_TZ || 'America/New_York', month: '2-digit', day: '2-digit', year: 'numeric' }).format(now);
  const recs = await knack.list(O.appts, {
    filters: { match: 'and', rules: [rule(F.appt.start, 'is after', today), { field: F.appt.status, operator: 'is not', value: 'Cancelled' }, { field: F.appt.status, operator: 'is not', value: 'No-show' }] },
    rows: 200,
  });
  const taken = new Set();
  for (const r of recs) {
    const status = raw(r, F.appt.status);
    const exp = raw(r, F.appt.holdExpUtc);
    if (status === 'Held' && (!exp || new Date(exp) < now)) continue;
    const s = raw(r, F.appt.startUtc);
    if (s) taken.add(new Date(s).toISOString());
  }
  return taken;
}

export async function availableSlots(now = new Date()) {
  const taken = await takenStarts(now);
  return mondaySlots(now).filter(s => !taken.has(s.toISOString()));
}

export function isBookable(startIso, now = new Date()) {
  return mondaySlots(now).some(s => s.toISOString() === new Date(startIso).toISOString());
}
