// Phone assistant -- the portal's data for the conversation in
// voiceAttendantCore.js (pilot, 2026-10-07).
//
// Who may use it:
//   - Patients, calling from the phone number on their account, after keying
//     in their date of birth.
//   - Attorneys, claim managers and other offices ONLY when BOTH are true:
//     their number is on the allowed list (VOICE_ALLOWED_NUMBERS in Vercel,
//     comma-separated), and it is the phone of an organization user Dr. Malik
//     has linked to an organization. They key in the case number, and only
//     their own organization's cases are found.
//   Anyone else is told to call the office; nothing is looked up.
// The assistant is off until VOICE_ATTENDANT_ON=true is set in Vercel.
//
// What it writes: a message is a Case Event (the audit trail, not shown to
// clients) plus, when email is set up, an email to Dr. Malik that says only
// that there is a new phone message. Each finished call adds one Case Event.
import { knack, O, F, STAGES, raw, connId } from './knack.js';
import { logEvent } from './activity.js';
import { classifyWithAzure } from './voiceAttendantCore.js';

export const PRACTICE_NAME = 'the office of Dr. Asif Malik';
const TZ = 'America/Los_Angeles';
const ACTOR = 'Phone assistant';
const ten = (v) => String(v || '').replace(/\D/g, '').slice(-10);
const phoneOf = (rec, key) => { const r = raw(rec, key); return ten(r?.full || r?.formatted || r?.number || rec?.[key]); };
const firstName = (rec, key) => { const r = raw(rec, key); return r?.first || String(r?.full || rec?.[key] || '').trim().split(/\s+/)[0] || ''; };

export const voiceEnabled = () => process.env.VOICE_ATTENDANT_ON === 'true';
export const allowedNumbers = () => new Set(String(process.env.VOICE_ALLOWED_NUMBERS || '').split(',').map(ten).filter(n => n.length === 10));

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
  if (!state.sid) return null;
  if (state.k === 'party') return knack.get(O.cases, state.sid);
  return latestCaseOf(state.sid);
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
export function makeMalikDeps({ dryRun = false, ignoreEnabled = false } = {}) {
  const wouldSend = [];
  const callerLabel = async (state) => {
    if (state.k !== 'party') return 'the patient (verified by date of birth)';
    const u = state.cid ? await knack.get(O.orgUsers, state.cid).catch(() => null) : null;
    const org = (raw(u, F.orgUser.org) || [])[0]?.identifier || '';
    return `${raw(u, F.orgUser.name)?.full || 'allowed caller'}${org ? `, ${org}` : ''} (allowed caller)`;
  };
  const record = async (caseId, type, detail) => {
    if (dryRun) { wouldSend.push({ kind: 'Case event', title: type, detail }); return true; }
    await logEvent(caseId, type, detail, ACTOR, false);
    return true;
  };
  const alert = async (subject) => {
    if (dryRun) { wouldSend.push({ kind: 'Email to Dr. Malik', title: subject, detail: '(no details in the email)' }); return true; }
    return alertDrMalik(subject);
  };

  return {
    practiceName: PRACTICE_NAME,
    wouldSend,
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
    classify: (text, state) => classifyWithAzure(text, { kind: state.k === 'party' ? 'party' : 'patient' }),
    async leaveMessage({ state, target, text, urgent }) {
      const c = await caseFor(state).catch(() => null);
      if (!c) return { ok: false };
      const from = await callerLabel(state);
      const detail = `${stamp()} Pacific, from ${from}, calling from ${state.f}, for ${target === 'provider' ? 'Dr. Malik' : 'the office'}: "${text}"${urgent ? ' -- the caller used crisis words and was told to call 911 or 988.' : ''}`;
      await record(c.id, urgent ? 'URGENT phone message' : 'Phone message', detail);
      await alert(urgent ? 'URGENT: new phone message' : 'New phone message');
      return { ok: true, to: "Dr. Malik's office" };
    },
    async flagUrgent({ state, text }) {
      const c = await caseFor(state).catch(() => null);
      if (c) await record(c.id, 'URGENT phone call', `${stamp()} Pacific. ${await callerLabel(state)} (${state.f}) said: "${text}". Told to call 911 or 988. Please call back now.`);
      await alert('URGENT: a caller used crisis words on the phone assistant');
      return true;
    },
  };
}

// One Case Event per finished call, when we know which case it was about.
export async function logVoiceCall(state, outcome) {
  if (!state?.sid) return;
  const c = await caseFor(state).catch(() => null);
  if (c) await logEvent(c.id, 'Phone call', `Phone assistant call ${stamp()} Pacific -- ${outcome}.`, ACTOR, false);
}
