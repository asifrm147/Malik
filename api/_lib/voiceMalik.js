// Phone assistant -- the portal's data for the conversation in
// voiceAttendantCore.js (pilot 2026-10-07; rebuilt like Lemonade 1.8.0 the
// same day, to the practice's behavioral-health / L&I directive).
//
// Who may hear anything about a case:
//   - Patients calling from the phone number on their account, after keying
//     in their date of birth.
//   - Attorneys, claim managers and other offices ONLY when BOTH are true:
//     their number is on the allowed list (VOICE_ALLOWED_NUMBERS in Vercel,
//     comma-separated), and it is the phone of an organization user Dr. Malik
//     has linked to an organization. They key in the case number, and only
//     their own organization's cases are found.
// Anyone may hear the office information (VOICE_HOURS, VOICE_ADDRESS,
// VOICE_FAX, VOICE_NEW_PATIENTS) and leave a message; nothing is said that
// would confirm someone is a patient.
// The assistant is off until VOICE_ATTENDANT_ON=true. VOICE_TRANSFER_NUMBER
// (optional) is where "a person" and emergencies are transferred.
//
// What it writes: every message is a Case Event (the audit trail, never shown
// to clients) -- on the case when the caller was verified, on no case when
// not -- and Dr. Malik sees them all under Workspace -> Phone assistant ->
// Phone messages. With email set up he also gets an email that says only that
// there is a new phone message.
import { knack, O, F, STAGES, raw, connId, knackDate } from './knack.js';
import { classifyWithAzure } from './voiceAttendantCore.js';
import { availableSlots } from './schedule.js';

export const PRACTICE_NAME = 'the office of Dr. Asif Malik';
const TZ = 'America/Los_Angeles';
const ACTOR = 'Phone assistant';
// Event types for phone activity. Until they are added to the Event Type
// choices in Knack, events are saved as "Status change" with the kind in the
// detail (see saveEvent).
export const PHONE_EVENTS = { message: 'Phone message', call: 'Phone call', urgent: 'Urgent phone call' };
const ten = (v) => String(v || '').replace(/\D/g, '').slice(-10);
const phoneOf = (rec, key) => { const r = raw(rec, key); return ten(r?.full || r?.formatted || r?.number || rec?.[key]); };
const firstName = (rec, key) => { const r = raw(rec, key); return r?.first || String(r?.full || rec?.[key] || '').trim().split(/\s+/)[0] || ''; };
const display = (n) => { const d = ten(n); return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : String(n || 'an unknown number'); };
const e164 = (n) => { const d = ten(n); return d.length === 10 ? `+1${d}` : ''; };

export const voiceEnabled = () => process.env.VOICE_ATTENDANT_ON === 'true';
export const allowedNumbers = () => new Set(String(process.env.VOICE_ALLOWED_NUMBERS || '').split(',').map(ten).filter(n => n.length === 10));
export const publicInfo = (env = process.env) => ({
  hours: String(env.VOICE_HOURS || '').slice(0, 200),
  address: String(env.VOICE_ADDRESS || '').slice(0, 200),
  fax: String(env.VOICE_FAX || '').slice(0, 40),
  newPatients: String(env.VOICE_NEW_PATIENTS || '').slice(0, 300),
});
export const transferNumber = (env = process.env) => e164(env.VOICE_TRANSFER_NUMBER);

// "10/05/1980" (Knack) vs "10051980" (keypad).
export function dobMatches(knackDob, digits) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(String(knackDob || ''));
  return Boolean(m) && `${m[1].padStart(2, '0')}${m[2].padStart(2, '0')}${m[3]}` === String(digits || '').replace(/\D/g, '');
}

async function byPhone(obj, field, number) {
  const n = ten(number);
  if (n.length !== 10) return [];
  const recs = await knack.list(obj, { filters: { match: 'and', rules: [{ field, operator: 'contains', value: n.slice(-4) }] }, rows: 50 });
  return recs.filter(r => phoneOf(r, field) === n);
}

// Organization users who may call: on the allowed list and linked to an organization.
export async function allowedOrgCallers(number) {
  if (!allowedNumbers().has(ten(number))) return [];
  return (await byPhone(O.orgUsers, F.orgUser.phone, number)).filter(u => connId(u, F.orgUser.org));
}

export const spokenWhen = (iso) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso)).replace(':00', '');

// Next Booked visit still to come; the most recent past one that was booked, completed or missed.
export function pickAppointments(appts, now = Date.now()) {
  const rows = appts.map(a => ({ start: raw(a, F.appt.startUtc), status: raw(a, F.appt.status) || '' })).filter(a => a.start && !Number.isNaN(Date.parse(a.start)));
  const next = rows.filter(a => a.status === 'Booked' && Date.parse(a.start) >= now).sort((a, b) => Date.parse(a.start) - Date.parse(b.start))[0];
  const last = rows.filter(a => ['Booked', 'Completed', 'No-show'].includes(a.status) && Date.parse(a.start) < now).sort((a, b) => Date.parse(b.start) - Date.parse(a.start))[0];
  const speak = (a) => a ? { when: spokenWhen(a.start), provider: 'Dr. Malik', how: 'by video', status: a.status === 'No-show' ? 'No-show' : a.status === 'Completed' ? 'Completed' : '' } : null;
  return { next: speak(next), last: speak(last) };
}

async function latestCaseOf(patientId) {
  const cases = await knack.list(O.cases, { filters: { match: 'and', rules: [{ field: F.case.patient, operator: 'is', value: patientId }] }, sortField: F.case.number, rows: 20 });
  return cases[0] || null;
}

// The case a call is about: the allowed caller's case, or the patient's most recent one.
async function caseFor(state) {
  if (!state.ok || !state.sid) return null;
  if (state.k === 'party') return knack.get(O.cases, state.sid);
  return latestCaseOf(state.sid);
}

// A Case Event (caseId may be null for an unverified caller). Falls back to
// "Status change" while the phone event types aren't Knack choices yet.
export async function saveEvent(caseId, type, detail) {
  const body = (t, d) => ({ ...(caseId ? { [F.ev.case]: [{ id: caseId }] } : {}), [F.ev.type]: t, [F.ev.detail]: d, [F.ev.at]: knackDate(new Date()), [F.ev.visible]: 'No', [F.ev.actor]: ACTOR });
  try {
    return await knack.create(O.events, body(type, detail));
  } catch {
    return knack.create(O.events, body('Status change', `[${type}] ${detail}`));
  }
}

async function alertDrMalik(subject) {
  const to = process.env.VOICE_ALERT_EMAIL || process.env.PROVIDER_EMAIL;
  if (!process.env.RESEND_API_KEY || !to) return false;
  const url = process.env.APP_BASE_URL || 'https://app.asifmalikmd.com';
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    // No caller or case details by email -- they're behind sign-in.
    body: JSON.stringify({ from: process.env.EMAIL_FROM, to, subject, text: `${subject}. Sign in to your workspace to read it: ${url}/provider` }),
  }).catch(() => null);
  return Boolean(res?.ok);
}

const stamp = () => new Date().toLocaleString('en-US', { timeZone: TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

// dryRun (the workspace simulator): reads real data, writes nothing, and
// reports what WOULD have been saved in `wouldSend`.
export function makeMalikDeps({ dryRun = false, ignoreEnabled = false, env = process.env } = {}) {
  const wouldSend = [];
  const callerLabel = async (state) => {
    if (!state.ok) return 'a caller who was NOT verified';
    if (state.k !== 'party') return 'the patient (verified by date of birth)';
    const u = state.cid ? await knack.get(O.orgUsers, state.cid).catch(() => null) : null;
    const org = (raw(u, F.orgUser.org) || [])[0]?.identifier || '';
    return `${raw(u, F.orgUser.name)?.full || 'allowed caller'}${org ? `, ${org}` : ''} (allowed caller)`;
  };
  const record = async (caseId, type, detail) => {
    if (dryRun) { wouldSend.push({ kind: caseId ? 'Case event' : 'Phone message (no case)', title: type, detail }); return true; }
    await saveEvent(caseId, type, detail);
    return true;
  };
  const alert = async (subject) => {
    if (dryRun) { wouldSend.push({ kind: 'Email to Dr. Malik', title: subject, detail: '(no details in the email)' }); return true; }
    return alertDrMalik(subject);
  };

  const deps = {
    practiceName: PRACTICE_NAME,
    wouldSend,
    publicInfo: publicInfo(env),
    transferNumber: transferNumber(env),
    async ready() { return deps; },
    enabled: async () => ignoreEnabled || voiceEnabled(),
    async lookupCaller(from) {
      const org = await allowedOrgCallers(from);
      if (org.length === 1) {
        const u = org[0];
        return { kind: 'party', id: u.id, firstName: firstName(u, F.orgUser.name), org: (raw(u, F.orgUser.org) || [])[0]?.identifier || '', verifyDigits: 10, verifyPrompt: 'the case number' };
      }
      const patients = await byPhone(O.patients, F.patient.phone, from);
      if (!patients.length) return null;
      return { kind: 'patient', firstName: patients.length === 1 ? firstName(patients[0], F.patient.name) : '', shared: patients.length > 1 };
    },
    async verify(state, digits) {
      if (state.k === 'party') {
        const [u] = (await allowedOrgCallers(state.f)).filter(x => x.id === state.cid);
        const orgId = u && connId(u, F.orgUser.org);
        if (!orgId) return { ok: false };
        const [c] = await knack.list(O.cases, { filters: { match: 'and', rules: [{ field: F.case.number, operator: 'is', value: String(Number(digits)) }, { field: F.case.org, operator: 'is', value: orgId }] }, rows: 2 });
        if (!c) return { ok: false };
        const examinee = raw(c, F.case.examinee) || (raw(c, F.case.patient) || [])[0]?.identifier || '';
        return { ok: true, subjectId: c.id, subjectFirstName: String(examinee).trim().split(/\s+/)[0] || '' };
      }
      if (digits.length !== 8) return { ok: false };
      const found = (await byPhone(O.patients, F.patient.phone, state.f)).filter(p => dobMatches(raw(p, F.patient.dob)?.date, digits));
      return found.length === 1 ? { ok: true, subjectId: found[0].id, subjectFirstName: firstName(found[0], F.patient.name) } : { ok: false };
    },
    async appointments(state) {
      if (!state.sid) return null;
      const field = state.k === 'party' ? F.appt.case : F.appt.patient;
      const appts = await knack.list(O.appts, { filters: { match: 'and', rules: [{ field, operator: 'is', value: state.sid }] }, rows: 50 });
      return pickAppointments(appts);
    },
    async caseStatus(state) {
      const c = await caseFor(state);
      if (!c) return null;
      const stage = raw(c, F.case.stage) || STAGES[0];
      const whose = state.k === 'party' ? `Case ${raw(c, F.case.number)}` : 'Your report';
      const hold = raw(c, F.case.onHold) === 'Yes' ? ` It is on hold until more information is received: ${raw(c, F.case.holdWhat) || 'details are in the portal'}.` : '';
      return `${whose} is at the stage: ${stage}.${hold}`;
    },
    classify: (text, state) => classifyWithAzure(text, { kind: state.ok ? (state.k === 'party' ? 'party' : 'patient') : 'unknown', env }),
    async leaveMessage({ state, target, text, urgent, refill }) {
      const c = await caseFor(state).catch(() => null);
      const from = await callerLabel(state);
      const kind = refill ? 'Refill request (as the caller described it -- nothing was promised)' : `Message for ${target === 'provider' ? 'Dr. Malik' : 'the office'}`;
      const detail = `${stamp()} Pacific, from ${from}, calling from ${display(state.f)}. ${kind}: "${text}"${urgent ? ' -- the caller used crisis words and was told to call 911 or 988.' : ''}${state.ok ? '' : ' Nothing about any patient was shared on this call; check who this is before discussing anything.'}`;
      await record(c?.id || null, urgent ? PHONE_EVENTS.urgent : PHONE_EVENTS.message, detail);
      await alert(urgent ? 'URGENT: new phone message' : 'New phone message');
      return { ok: true, to: refill ? 'Dr. Malik' : "Dr. Malik's office" };
    },
    async flagUrgent({ state, text, kind = 'crisis' }) {
      const c = await caseFor(state).catch(() => null);
      const who = `${await callerLabel(state)}, ${display(state.f)}`;
      const T = {
        crisis: `The caller (${who}) said: "${text}". They were asked whether they are in immediate danger and given 911/988. Please call them back now.`,
        location: `The caller (${who}) said they are in immediate danger. Asked where they are, they said: "${text}". They were told to call 911. Call them back now.`,
        threat: `The caller (${who}) said: "${text}" -- the exact statement. A threat toward another person: review now (duty to warn, RCW 71.05.120, is a clinical and legal decision, not the assistant's).`,
      }[kind] || `"${text}"`;
      await record(c?.id || null, PHONE_EVENTS.urgent, `${stamp()} Pacific. ${T}`);
      await alert(kind === 'threat' ? 'URGENT: a caller made a threat toward another person' : 'URGENT: a caller may be in crisis');
      return true;
    },
    // Two real open consultation times (Mondays 9-11, booked 14+ hours ahead).
    async offerSlots(state) {
      if (state.k !== 'patient') return null;
      const slots = (await availableSlots()).filter((d) => d.getTime() - Date.now() > 24 * 3600000).slice(0, 2);
      return { slots: slots.map((d) => ({ label: spokenWhen(d.toISOString()), key: d.toISOString() })) };
    },
    async requestReschedule({ state, slot }) {
      const c = await caseFor(state).catch(() => null);
      if (!c) return { ok: false };
      await record(c.id, PHONE_EVENTS.message, `${stamp()} Pacific, by phone (patient verified by date of birth): asked to move their appointment to ${slot.label} (${slot.key}). Nothing has been changed -- move it in the portal and let the patient know.`);
      await alert('New phone message: reschedule request');
      return { ok: true };
    },
  };
  return deps;
}

// One Case Event per finished call, when it was about a verified case.
export async function logVoiceCall(state, outcome) {
  if (!state?.ok || !state?.sid) return;
  const c = await caseFor(state).catch(() => null);
  if (c) await saveEvent(c.id, PHONE_EVENTS.call, `Phone assistant call ${stamp()} Pacific -- ${outcome}.`);
}

// Workspace -> Phone assistant -> Phone messages: the last 60 days of phone
// messages and urgent calls, case or no case, newest first.
export async function phoneMessages() {
  const since = new Date(Date.now() - 60 * 86400000);
  const recs = await knack.list(O.events, { filters: { match: 'and', rules: [{ field: F.ev.actor, operator: 'is', value: ACTOR }, { field: F.ev.at, operator: 'is after', value: knackDate(since).date }] }, sortField: F.ev.at, rows: 200 });
  return recs
    .filter((e) => raw(e, F.ev.type) !== PHONE_EVENTS.call && !String(raw(e, F.ev.detail) || '').startsWith('[Phone call]'))
    .map((e) => ({
      id: e.id,
      at: raw(e, F.ev.at)?.iso_timestamp || null,
      type: raw(e, F.ev.type) === 'Status change' ? (/^\[([^\]]+)\]/.exec(raw(e, F.ev.detail) || '')?.[1] || 'Phone message') : raw(e, F.ev.type),
      detail: String(raw(e, F.ev.detail) || '').replace(/^\[[^\]]+\]\s*/, ''),
      caseNumber: (raw(e, F.ev.case) || [])[0]?.identifier || null,
    }));
}
