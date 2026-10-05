import { knack, O, F, raw, connId, knackDate } from './knack.js';

// Every change is written to Case Events (the audit trail). visible=true also shows it on the client timeline.
export async function logEvent(caseId, type, detail, actor, visible = false) {
  return knack.create(O.events, {
    [F.ev.case]: [{ id: caseId }], [F.ev.type]: type, [F.ev.detail]: detail || '',
    [F.ev.at]: knackDate(new Date()), [F.ev.visible]: visible ? 'Yes' : 'No', [F.ev.actor]: actor || 'System',
  });
}

const GENERIC_EN = 'There is an update available in your secure account.';
const GENERIC_ES = 'Hay una actualización disponible en su cuenta segura.';

// Creates an in-portal notification for everyone who should see this case,
// and emails only those who opted in. Emails never contain clinical or case details.
export async function notifyCase(caseRec, msgEn, msgEs) {
  const patientId = connId(caseRec, F.case.patient);
  const orgId = connId(caseRec, F.case.org);
  const targets = [];
  if (patientId) {
    const p = await knack.get(O.patients, patientId);
    targets.push({ field: F.note.patient, id: patientId, emailOn: raw(p, F.patient.emailOn) !== 'Off', email: raw(p, F.patient.email)?.email });
  }
  if (orgId) {
    const users = await knack.list(O.orgUsers, { filters: { match: 'and', rules: [{ field: F.orgUser.org, operator: 'is', value: orgId }] } });
    for (const u of users) targets.push({ field: F.note.orgUser, id: u.id, emailOn: raw(u, F.orgUser.emailOn) !== 'Off', email: raw(u, F.orgUser.email)?.email });
  }
  for (const t of targets) {
    let emailStatus = t.emailOn ? 'Not sent' : 'Opted out';
    if (t.emailOn && t.email) emailStatus = (await sendEmail(t.email)) ? 'Sent' : 'Not sent';
    await knack.create(O.notes, {
      [F.note.case]: [{ id: caseRec.id }], [t.field]: [{ id: t.id }], [F.note.msg]: msgEn, [F.note.msgEs]: msgEs || msgEn,
      [F.note.at]: knackDate(new Date()), [F.note.read]: 'No', [F.note.email]: emailStatus,
    });
  }
}

const REMINDER = {
  subject: 'Appointment reminder',
  text: (url) => `You have an upcoming video appointment with Asif Malik, MD.\nTiene una próxima cita por video con el Dr. Asif Malik.\n\nSign in for the time, to finish paperwork and to join / Inicie sesión para ver la hora, completar formularios y entrar: ${url}\n\nEmergencies: 911. Crisis: call or text 988.`,
};

// Reminder email: says only that an appointment is coming up; details stay behind sign-in.
export async function sendReminder(to) {
  if (!process.env.RESEND_API_KEY || !to) return false;
  const url = process.env.APP_BASE_URL || 'https://app.asifmalikmd.com';
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: process.env.EMAIL_FROM, to, subject: REMINDER.subject, text: REMINDER.text(url) }),
  });
  return res.ok;
}

async function sendEmail(to) {
  if (!process.env.RESEND_API_KEY) return false;
  const url = process.env.APP_BASE_URL || 'https://app.asifmalikmd.com';
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM, to, subject: 'Update in your secure account',
      text: `${GENERIC_EN}\n${GENERIC_ES}\n\nSign in / Iniciar sesión: ${url}\n\nAsif Malik, MD`,
    }),
  });
  return res.ok;
}

export function receiptNumber() { return 'RCV-' + Math.random().toString(36).slice(2, 8).toUpperCase(); }
