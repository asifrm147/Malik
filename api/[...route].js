import { knack, O, F, STAGES, HttpError, raw, connId, connIds, knackDate } from './_lib/knack.js';
import { requireUser, requireRole, signState, readState } from './_lib/auth.js';
import { availableSlots, isBookable, takenStarts, HOLD_MINUTES, SLOT_MINUTES, PRACTICE_TZ } from './_lib/schedule.js';
import { logEvent, notifyCase, receiptNumber, sendReminder } from './_lib/activity.js';
import { idme, sphere, daily } from './_lib/integrations.js';

const STATES = { CA: 'California', ID: 'Idaho', PA: 'Pennsylvania', WA: 'Washington' };
const fee = {
  consult: () => +(process.env.CONSULT_FEE || 495),
  review: (pages) => +(process.env.REVIEW_BASE_FEE || 500) + Math.max(0, (pages || 0) - +(process.env.REVIEW_INCLUDED_PAGES || 500)) * +(process.env.REVIEW_PER_PAGE || 0.75),
  ime: (pages) => +(process.env.IME_FEE || 1300) + fee.review(pages),
};
const CHECKLISTS = {
  patient: [['Telehealth consent', 'Consentimiento de telesalud'], ['Health history', 'Historial de salud'], ['Medication list', 'Lista de medicamentos'], ['Release to your PCP', 'Autorización para su médico de cabecera']],
  org: [['Engagement letter', 'Carta de contratación'], ['Referral questions', 'Preguntas de la referencia'], ['Authorization to release', 'Autorización de entrega']],
};
const MSG = {
  status: (s) => [`Report status: ${s}`, `Estado del informe: ${s}`],
  hold: ['More information is needed for your report', 'Se necesita más información para su informe'],
  clear: ['The information request is complete; your report is moving forward', 'La solicitud de información está completa; su informe avanza'],
  keep: ['Some requested information is still missing', 'Todavía falta parte de la información solicitada'],
  released: ['Your report is ready for download', 'Su informe está listo para descargar'],
  booked: ['Your appointment is confirmed', 'Su cita está confirmada'],
};

// ---------- tiny router ----------
const routes = [];
const on = (method, pattern, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn });

export default async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname.replace(/^\/api/, '') || '/';
  try {
    const r = routes.find(r => r.method === req.method && r.re.test(path));
    if (!r) throw new HttpError(404, 'Not found');
    const params = path.match(r.re).groups || {};
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const out = await r.fn({ req, res, params, query: Object.fromEntries(url.searchParams), body });
    if (out !== undefined && !res.headersSent) res.status(200).json(out);
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500 && status !== 503) console.error(e); // 503 = booking closed (expected)
    if (!res.headersSent) res.status(status).json({ error: e.message || 'Server error', status });
  }
}

// ---------- access helpers ----------
async function orgIdOf(orgUser) { return connId(orgUser, F.orgUser.org); }
async function assertCaseAccess(me, caseRec) {
  if (me.roles.provider) return 'provider';
  if (me.roles.patient && connId(caseRec, F.case.patient) === me.roles.patient.id) return 'patient';
  if (me.roles.org) { const oid = await orgIdOf(me.roles.org); if (oid && connId(caseRec, F.case.org) === oid) return 'org'; }
  throw new HttpError(404, 'Case not found.'); // never reveal that a case exists
}
const stageIndex = (c) => Math.max(0, STAGES.indexOf(raw(c, F.case.stage) || STAGES[0]));
const actorName = (me) => me.name || 'User';

// ---------- launch switch (2026-10-07) ----------
// Payments, ID.me and video are still in test mode, and a test payment is
// confirmed by a URL flag. Until real credentials are set, booking, new paid
// case requests, checkout and payment confirmation are refused. Set
// PORTAL_BOOKING_OPEN=true in Vercel only once Sphere payments are live.
const bookingOpen = () => process.env.PORTAL_BOOKING_OPEN === 'true';
const CLOSED_MSG = 'Online booking opens soon. Until then, please email asif.malik@psychiatrygroup.com (no medical details by email).';
function requireOpen() { if (!bookingOpen()) throw new HttpError(503, CLOSED_MSG); }

// ================= PUBLIC =================
on('GET', '/config', async () => ({
  bookingOpen: bookingOpen(), closedMessage: bookingOpen() ? '' : CLOSED_MSG,
  fees: { consult: fee.consult(), ime: +(process.env.IME_FEE || 1300), reviewBase: +(process.env.REVIEW_BASE_FEE || 500), reviewIncludedPages: +(process.env.REVIEW_INCLUDED_PAGES || 500), reviewPerPage: +(process.env.REVIEW_PER_PAGE || 0.75) },
  states: STATES, timeZone: PRACTICE_TZ, slotMinutes: SLOT_MINUTES, holdMinutes: HOLD_MINUTES, minLeadHours: 14,
  testMode: { idme: idme.testMode(), payments: sphere.testMode(), video: daily.testMode(), email: !process.env.RESEND_API_KEY },
}));

on('GET', '/slots', async () => ({ slots: (await availableSlots()).map(d => d.toISOString()) }));

// ================= PATIENT BOOKING =================
on('POST', '/book/hold', async ({ req, body }) => {
  requireOpen();
  const me = await requireUser(req);
  const patient = requireRole(me, 'patient');
  const { start, state } = body;
  if (!STATES[state]) throw new HttpError(400, 'Dr. Malik can only see you while you are in California, Idaho, Pennsylvania or Washington.');
  if (!start || !isBookable(start)) throw new HttpError(409, 'That time is no longer available. Appointments must be booked at least 14 hours ahead.');
  if ((await takenStarts()).has(new Date(start).toISOString())) throw new HttpError(409, 'Someone just booked that time. Please choose another.');
  const startDate = new Date(start);
  const c = await knack.create(O.cases, {
    [F.case.type]: 'Consultation report', [F.case.stage]: STAGES[0], [F.case.onHold]: 'No', [F.case.patient]: [{ id: patient.id }],
    [F.case.jurisdiction]: STATES[state], [F.case.fee]: String(fee.consult()), [F.case.payStatus]: 'Unpaid', [F.case.lastChange]: knackDate(new Date()),
  });
  const holdExp = new Date(Date.now() + HOLD_MINUTES * 60000);
  const a = await knack.create(O.appts, {
    [F.appt.start]: knackDate(startDate), [F.appt.startUtc]: startDate.toISOString(), [F.appt.minutes]: SLOT_MINUTES,
    [F.appt.type]: 'Consultation', [F.appt.status]: 'Held', [F.appt.state]: STATES[state],
    [F.appt.holdExp]: knackDate(holdExp), [F.appt.holdExpUtc]: holdExp.toISOString(),
    [F.appt.fee]: String(fee.consult()), [F.appt.payStatus]: 'Unpaid', [F.appt.patient]: [{ id: patient.id }], [F.appt.case]: [{ id: c.id }],
  });
  for (const [i, [en, es]] of CHECKLISTS.patient.entries()) {
    await knack.create(O.checklist, { [F.item.name]: en, [F.item.nameEs]: es, [F.item.order]: i + 1, [F.item.status]: 'Not started', [F.item.case]: [{ id: c.id }] });
  }
  await logEvent(c.id, 'Appointment booked', `Slot held until ${holdExp.toISOString()} for ${startDate.toISOString()}`, actorName(me));
  return { appointmentId: a.id, caseId: c.id, holdExpiresAt: holdExp.toISOString(), checkoutUrl: sphere.checkoutUrl({ amount: fee.consult(), reference: `A-${a.id}`, returnPath: '/account' }) };
});

// Payment return (both real and test mode land here). Payment is confirmed server-side before anything changes.
on('GET', '/payments/return', async ({ res, query }) => {
  requireOpen();
  const ref = query.ref || '';
  const { paid, transactionId } = await sphere.confirm(ref, query);
  const back = query.return || '/account';
  if (!paid) { res.redirect(302, `${back}?payment=declined`); return; }
  if (ref.startsWith('A-')) {
    const a = await knack.get(O.appts, ref.slice(2));
    const exp = raw(a, F.appt.holdExpUtc);
    const startIso = raw(a, F.appt.startUtc);
    if (raw(a, F.appt.status) === 'Held' && exp && new Date(exp) < new Date() && (await takenStarts()).has(new Date(startIso).toISOString())) {
      res.redirect(302, `${back}?payment=slot-lost`); return; // the hold expired and someone else took the time; refund needed
    }
    const room = `amd-${a.id}`;
    await knack.update(O.appts, a.id, { [F.appt.status]: 'Booked', [F.appt.payStatus]: 'Paid', [F.appt.sphereTx]: transactionId, [F.appt.room]: room });
    const caseId = connId(a, F.appt.case);
    const c = await knack.update(O.cases, caseId, { [F.case.payStatus]: 'Paid', [F.case.sphereTx]: transactionId });
    await logEvent(caseId, 'Appointment booked', `Paid. Transaction ${transactionId}`, 'Payment', true);
    await notifyCase(await knack.get(O.cases, caseId), ...MSG.booked);
  } else if (ref.startsWith('C-')) {
    const caseId = ref.slice(2);
    await knack.update(O.cases, caseId, { [F.case.payStatus]: 'Paid', [F.case.sphereTx]: transactionId });
    await logEvent(caseId, 'Status change', `Paid. Transaction ${transactionId}`, 'Payment', true);
  }
  res.redirect(302, `${back}?payment=ok`);
});

// ================= ORGANIZATION REQUESTS =================
on('POST', '/org/cases', async ({ req, body }) => {
  requireOpen();
  const me = await requireUser(req);
  const ou = requireRole(me, 'org');
  const orgId = await orgIdOf(ou);
  if (!orgId) throw new HttpError(403, 'Your account is not linked to an organization yet. Dr. Malik’s office will link it after approval.');
  const type = body.type === 'IME' ? 'IME' : 'Records review';
  const pages = Math.max(0, parseInt(body.pages || 0, 10));
  const amount = type === 'IME' ? fee.ime(pages) : fee.review(pages);
  const c = await knack.create(O.cases, {
    [F.case.type]: type, [F.case.stage]: STAGES[0], [F.case.onHold]: 'No', [F.case.org]: [{ id: orgId }], [F.case.requestedBy]: [{ id: ou.id }],
    [F.case.examinee]: String(body.examinee || '').slice(0, 200), [F.case.claim]: String(body.claim || '').slice(0, 100),
    [F.case.jurisdiction]: STATES[body.state] || 'Other', [F.case.questions]: String(body.questions || '').slice(0, 5000),
    [F.case.pages]: pages, [F.case.fee]: String(amount), [F.case.payStatus]: 'Unpaid', [F.case.lastChange]: knackDate(new Date()),
  });
  for (const [i, [en, es]] of CHECKLISTS.org.entries()) {
    await knack.create(O.checklist, { [F.item.name]: en, [F.item.nameEs]: es, [F.item.order]: i + 1, [F.item.status]: en === 'Referral questions' && body.questions ? 'Submitted' : 'Not started', [F.item.case]: [{ id: c.id }] });
  }
  await logEvent(c.id, 'Status change', `Request submitted: ${type}, ${pages} pages, quoted $${amount.toFixed(2)}`, actorName(me), true);
  return { caseId: c.id, quotedFee: amount, checkoutUrl: sphere.checkoutUrl({ amount, reference: `C-${c.id}`, returnPath: '/account' }) };
});

on('POST', '/cases/:id/checkout', async ({ req, params }) => {
  requireOpen();
  const me = await requireUser(req);
  const c = await knack.get(O.cases, params.id);
  await assertCaseAccess(me, c);
  if (raw(c, F.case.payStatus) === 'Paid') throw new HttpError(409, 'This case is already paid.');
  return { checkoutUrl: sphere.checkoutUrl({ amount: +raw(c, F.case.fee), reference: `C-${c.id}`, returnPath: '/account' }) };
});

// ================= DASHBOARD DATA (patient & organization) =================
async function caseBundle(c, viewer) {
  const byCase = (field) => ({ match: 'and', rules: [{ field, operator: 'is', value: c.id }] });
  const [items, docs, events, versions, appts] = await Promise.all([
    knack.list(O.checklist, { filters: byCase(F.item.case), sortField: F.item.order, sortOrder: 'asc' }),
    knack.list(O.docs, { filters: byCase(F.doc.case), sortField: F.doc.at }),
    knack.list(O.events, { filters: { match: 'and', rules: [{ field: F.ev.case, operator: 'is', value: c.id }, { field: F.ev.visible, operator: 'is', value: 'Yes' }] }, sortField: F.ev.at }),
    knack.list(O.versions, { filters: { match: 'and', rules: [{ field: F.ver.case, operator: 'is', value: c.id }, { field: F.ver.current, operator: 'is', value: 'Yes' }, { field: F.ver.approved, operator: 'is', value: 'Yes' }] } }),
    knack.list(O.appts, { filters: byCase(F.appt.case) }),
  ]);
  // A released version is only shown to people named as recipients.
  const released = versions.filter(v => (viewer.kind === 'patient' && connIds(v, F.ver.toPatients).includes(viewer.id)) || (viewer.kind === 'org' && connIds(v, F.ver.toOrgUsers).includes(viewer.id)));
  return {
    id: c.id, number: raw(c, F.case.number), type: raw(c, F.case.type), stage: stageIndex(c),
    hold: raw(c, F.case.onHold) === 'Yes' ? { what: raw(c, F.case.holdWhat), who: raw(c, F.case.holdWho), how: raw(c, F.case.holdHow), receivedAt: raw(c, F.case.holdRecv)?.iso_timestamp || null } : null,
    examinee: raw(c, F.case.examinee), claim: raw(c, F.case.claim), fee: +raw(c, F.case.fee) || 0, paid: raw(c, F.case.payStatus) === 'Paid',
    lastChange: raw(c, F.case.lastChange)?.iso_timestamp || null,
    checklist: items.map(i => ({ id: i.id, name: raw(i, F.item.name), nameEs: raw(i, F.item.nameEs), status: raw(i, F.item.status), at: raw(i, F.item.at)?.iso_timestamp || null, data: viewer.kind === 'patient' || viewer.kind === 'org' ? raw(i, F.item.data) : undefined })),
    documents: docs.map(d => ({ id: d.id, name: raw(d, F.doc.fileName), receipt: raw(d, F.doc.receipt), at: raw(d, F.doc.at)?.iso_timestamp || null })),
    timeline: events.map(e => ({ type: raw(e, F.ev.type), detail: raw(e, F.ev.detail), at: raw(e, F.ev.at)?.iso_timestamp || null })),
    report: released[0] ? { versionId: released[0].id, version: raw(released[0], F.ver.number), releasedAt: raw(released[0], F.ver.at)?.iso_timestamp || null } : null,
    appointments: appts.filter(a => raw(a, F.appt.status) === 'Booked' || raw(a, F.appt.status) === 'Completed').map(a => ({ id: a.id, start: raw(a, F.appt.startUtc), status: raw(a, F.appt.status), minutes: raw(a, F.appt.minutes) })),
  };
}

on('GET', '/me', async ({ req }) => {
  const me = await requireUser(req);
  const out = { name: me.name, roles: Object.keys(me.roles), profileKeys: me.profileKeys };
  if (me.roles.patient) {
    const p = me.roles.patient;
    const cases = await knack.list(O.cases, { filters: { match: 'and', rules: [{ field: F.case.patient, operator: 'is', value: p.id }] }, sortField: F.case.number });
    const notes = await knack.list(O.notes, { filters: { match: 'and', rules: [{ field: F.note.patient, operator: 'is', value: p.id }] }, sortField: F.note.at, rows: 30 });
    out.patient = {
      id: p.id, idStatus: raw(p, F.patient.idStatus) || 'Not started', emailOn: raw(p, F.patient.emailOn) !== 'Off', reminders: raw(p, F.patient.reminders) !== 'Off', lang: raw(p, F.patient.lang) === 'Spanish' ? 'es' : 'en',
      cases: await Promise.all(cases.map(c => caseBundle(c, { kind: 'patient', id: p.id }))),
      notifications: notes.map(n => ({ id: n.id, en: raw(n, F.note.msg), es: raw(n, F.note.msgEs), at: raw(n, F.note.at)?.iso_timestamp, read: raw(n, F.note.read) === 'Yes' })),
    };
  }
  if (me.roles.org) {
    const u = me.roles.org; const orgId = await orgIdOf(u);
    const cases = orgId ? await knack.list(O.cases, { filters: { match: 'and', rules: [{ field: F.case.org, operator: 'is', value: orgId }] }, sortField: F.case.number }) : [];
    const notes = await knack.list(O.notes, { filters: { match: 'and', rules: [{ field: F.note.orgUser, operator: 'is', value: u.id }] }, sortField: F.note.at, rows: 30 });
    out.org = {
      id: u.id, linked: !!orgId, orgName: (raw(u, F.orgUser.org) || [])[0]?.identifier || null, idStatus: raw(u, F.orgUser.idStatus) || 'Not started',
      emailOn: raw(u, F.orgUser.emailOn) !== 'Off', lang: raw(u, F.orgUser.lang) === 'Spanish' ? 'es' : 'en',
      cases: await Promise.all(cases.map(c => caseBundle(c, { kind: 'org', id: u.id }))),
      notifications: notes.map(n => ({ id: n.id, en: raw(n, F.note.msg), es: raw(n, F.note.msgEs), at: raw(n, F.note.at)?.iso_timestamp, read: raw(n, F.note.read) === 'Yes' })),
    };
  }
  return out;
});

on('POST', '/prefs', async ({ req, body }) => {
  const me = await requireUser(req);
  if (me.roles.patient) await knack.update(O.patients, me.roles.patient.id, { [F.patient.emailOn]: body.emailOn ? 'On' : 'Off', [F.patient.reminders]: body.reminders ? 'On' : 'Off', [F.patient.lang]: body.lang === 'es' ? 'Spanish' : 'English' });
  if (me.roles.org) await knack.update(O.orgUsers, me.roles.org.id, { [F.orgUser.emailOn]: body.emailOn ? 'On' : 'Off', [F.orgUser.lang]: body.lang === 'es' ? 'Spanish' : 'English' });
  return { ok: true };
});

on('POST', '/notifications/read', async ({ req, body }) => {
  const me = await requireUser(req);
  for (const id of (body.ids || []).slice(0, 50)) {
    const n = await knack.get(O.notes, id);
    const mine = (me.roles.patient && connId(n, F.note.patient) === me.roles.patient.id) || (me.roles.org && connId(n, F.note.orgUser) === me.roles.org.id);
    if (mine) await knack.update(O.notes, id, { [F.note.read]: 'Yes' });
  }
  return { ok: true };
});

// Paperwork: save a draft or submit. Submitted items are locked so nothing is sent twice.
on('POST', '/checklist/:id', async ({ req, params, body }) => {
  const me = await requireUser(req);
  const item = await knack.get(O.checklist, params.id);
  const c = await knack.get(O.cases, connId(item, F.item.case));
  await assertCaseAccess(me, c);
  if (raw(item, F.item.status) === 'Submitted') throw new HttpError(409, 'Already submitted. You do not need to send this again.');
  const submit = body.action === 'submit';
  await knack.update(O.checklist, item.id, { [F.item.status]: submit ? 'Submitted' : 'Saved', [F.item.data]: JSON.stringify(body.data || {}).slice(0, 20000), ...(submit ? { [F.item.at]: knackDate(new Date()) } : {}) });
  if (submit) await logEvent(c.id, 'Checklist submitted', raw(item, F.item.name), actorName(me), true);
  return { ok: true, status: submit ? 'Submitted' : 'Saved' };
});

// Documents: the browser uploads the file to Knack's asset store with the user's own token,
// then registers it here. The server checks case access before linking it.
on('POST', '/documents', async ({ req, body }) => {
  const me = await requireUser(req);
  const c = await knack.get(O.cases, body.caseId);
  const role = await assertCaseAccess(me, c);
  if (!body.assetId) throw new HttpError(400, 'Missing uploaded file.');
  const receipt = receiptNumber();
  const answersHold = !!body.answersHold && raw(c, F.case.onHold) === 'Yes';
  await knack.create(O.docs, {
    [F.doc.file]: body.assetId, [F.doc.fileName]: String(body.fileName || 'Document').slice(0, 200), [F.doc.receipt]: receipt, [F.doc.at]: knackDate(new Date()),
    [F.doc.byRole]: role === 'patient' ? 'Patient' : role === 'org' ? 'Organization' : 'Provider', [F.doc.scan]: 'Pending', [F.doc.reviewed]: 'No', [F.doc.answersHold]: answersHold ? 'Yes' : 'No', [F.doc.case]: [{ id: c.id }],
  });
  await logEvent(c.id, 'Document uploaded', `${body.fileName} (${receipt})`, actorName(me), true);
  if (answersHold) {
    // Mark the request received. The hold stays on until Dr. Malik confirms it is complete.
    await knack.update(O.cases, c.id, { [F.case.holdRecv]: knackDate(new Date()) });
    await logEvent(c.id, 'Hold information received', receipt, actorName(me), true);
  }
  return { receipt };
});

// Report download: only named recipients of the current approved version. Streams through this server; no public links.
on('GET', '/reports/:versionId/download', async ({ req, res, params }) => {
  const me = await requireUser(req);
  const v = await knack.get(O.versions, params.versionId);
  const ok = raw(v, F.ver.approved) === 'Yes' && (
    me.roles.provider ||
    (me.roles.patient && connIds(v, F.ver.toPatients).includes(me.roles.patient.id)) ||
    (me.roles.org && connIds(v, F.ver.toOrgUsers).includes(me.roles.org.id)));
  if (!ok) throw new HttpError(404, 'Report not found.');
  const file = raw(v, F.ver.file);
  if (!file?.id) throw new HttpError(404, 'Report file missing.');
  const upstream = await knack.downloadStream(file.id, file.filename || 'report.pdf');
  if (!upstream.ok) throw new HttpError(502, `Could not retrieve report (${upstream.status}).`);
  await logEvent(connId(v, F.ver.case), 'Report downloaded', `Version ${raw(v, F.ver.number)} by ${actorName(me)}`, actorName(me), false);
  res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="report-v${raw(v, F.ver.number)}.pdf"`);
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).send(Buffer.from(await upstream.arrayBuffer()));
});

// ================= ID.me =================
on('GET', '/idme/start', async ({ req }) => {
  const me = await requireUser(req);
  const kind = me.roles.patient ? 'patient' : me.roles.org ? 'org' : null;
  if (!kind) throw new HttpError(403, 'Verification is for patient and organization accounts.');
  const recId = me.roles[kind].id;
  if (idme.testMode()) return { url: `/verify/test?state=${encodeURIComponent(signState({ kind, recId }))}`, testMode: true };
  await knack.update(kind === 'patient' ? O.patients : O.orgUsers, recId, { [kind === 'patient' ? F.patient.idStatus : F.orgUser.idStatus]: 'Pending' });
  return { url: idme.authorizeUrl(signState({ kind, recId })) };
});

async function markVerified(kind, recId, reference, how) {
  const obj = kind === 'patient' ? O.patients : O.orgUsers;
  const f = kind === 'patient' ? F.patient : F.orgUser;
  await knack.update(obj, recId, { [f.idStatus]: 'Verified', [f.idRef]: reference || how, [f.idAt]: knackDate(new Date()) });
}

on('GET', '/idme/callback', async ({ res, query }) => {
  const { kind, recId } = readState(query.state);
  if (query.error) { res.redirect(302, '/account?verified=cancelled'); return; }
  const result = await idme.exchange(query.code);
  if (!result.verified) {
    await knack.update(kind === 'patient' ? O.patients : O.orgUsers, recId, { [kind === 'patient' ? F.patient.idStatus : F.orgUser.idStatus]: 'Requires input' });
    res.redirect(302, '/account?verified=incomplete'); return;
  }
  await markVerified(kind, recId, result.reference, 'ID.me');
  res.redirect(302, '/account?verified=1');
});

on('POST', '/idme/test-complete', async ({ req, body }) => {
  if (!idme.testMode()) throw new HttpError(403, 'Test verification is disabled once ID.me is configured.');
  const me = await requireUser(req);
  const { kind, recId } = readState(body.state);
  if (me.roles[kind]?.id !== recId) throw new HttpError(403, 'State does not match this account.');
  await markVerified(kind, recId, 'TEST-MODE', 'Test');
  return { ok: true };
});

// ================= VIDEO =================
on('GET', '/video/:apptId', async ({ req, params }) => {
  const me = await requireUser(req);
  const a = await knack.get(O.appts, params.apptId);
  const isProvider = !!me.roles.provider;
  if (!isProvider) {
    const p = requireRole(me, 'patient');
    if (connId(a, F.appt.patient) !== p.id) throw new HttpError(404, 'Appointment not found.');
    if ((raw(p, F.patient.idStatus) || '') !== 'Verified') throw new HttpError(403, 'Please verify your identity with ID.me before joining. If you cannot, Dr. Malik can check your photo ID at the start of the visit.');
  }
  if (raw(a, F.appt.status) !== 'Booked') throw new HttpError(409, 'This appointment is not active.');
  const start = new Date(raw(a, F.appt.startUtc));
  const now = Date.now();
  if (now < start.getTime() - 15 * 60000) throw new HttpError(409, 'The waiting room opens 15 minutes before your appointment.');
  if (now > start.getTime() + 2 * 3600000) throw new HttpError(409, 'This appointment has ended.');
  const name = raw(a, F.appt.room) || `amd-${a.id}`;
  if (daily.testMode()) return { testMode: true, room: name };
  const room = await daily.room(name, start.toISOString());
  const token = await daily.token(name, { owner: isProvider, userName: isProvider ? 'Dr. Malik' : 'Patient', startIso: start.toISOString() });
  return { url: room.url, token };
});

// ================= PROVIDER =================
async function provider(req) { const me = await requireUser(req); requireRole(me, 'provider'); return me; }

on('GET', '/provider/cases', async ({ req }) => {
  await provider(req);
  const cases = await knack.list(O.cases, { sortField: F.case.lastChange, rows: 100 });
  return { cases: cases.map(c => ({ id: c.id, number: raw(c, F.case.number), type: raw(c, F.case.type), stage: stageIndex(c), onHold: raw(c, F.case.onHold) === 'Yes', holdReceived: !!raw(c, F.case.holdRecv), patient: (raw(c, F.case.patient) || [])[0]?.identifier || null, org: (raw(c, F.case.org) || [])[0]?.identifier || null, examinee: raw(c, F.case.examinee), paid: raw(c, F.case.payStatus) === 'Paid', lastChange: raw(c, F.case.lastChange)?.iso_timestamp || null })) };
});

on('GET', '/provider/cases/:id', async ({ req, params }) => {
  await provider(req);
  const c = await knack.get(O.cases, params.id);
  const byCase = (field) => ({ match: 'and', rules: [{ field, operator: 'is', value: c.id }] });
  const [events, docs, versions, items, appts] = await Promise.all([
    knack.list(O.events, { filters: byCase(F.ev.case), sortField: F.ev.at, rows: 200 }),
    knack.list(O.docs, { filters: byCase(F.doc.case), sortField: F.doc.at }),
    knack.list(O.versions, { filters: byCase(F.ver.case), sortField: F.ver.number }),
    knack.list(O.checklist, { filters: byCase(F.item.case), sortField: F.item.order, sortOrder: 'asc' }),
    knack.list(O.appts, { filters: byCase(F.appt.case) }),
  ]);
  const orgId = connId(c, F.case.org);
  const orgUsers = orgId ? await knack.list(O.orgUsers, { filters: { match: 'and', rules: [{ field: F.orgUser.org, operator: 'is', value: orgId }] } }) : [];
  return {
    id: c.id, number: raw(c, F.case.number), type: raw(c, F.case.type), stage: stageIndex(c), stages: STAGES,
    hold: raw(c, F.case.onHold) === 'Yes' ? { what: raw(c, F.case.holdWhat), who: raw(c, F.case.holdWho), how: raw(c, F.case.holdHow), receivedAt: raw(c, F.case.holdRecv)?.iso_timestamp || null } : null,
    patient: (raw(c, F.case.patient) || [])[0] || null, org: (raw(c, F.case.org) || [])[0] || null,
    orgUsers: orgUsers.map(u => ({ id: u.id, name: raw(u, F.orgUser.name)?.full || raw(u, F.orgUser.email)?.email })),
    examinee: raw(c, F.case.examinee), claim: raw(c, F.case.claim), questions: raw(c, F.case.questions), pages: raw(c, F.case.pages), fee: raw(c, F.case.fee), paid: raw(c, F.case.payStatus) === 'Paid',
    audit: events.map(e => ({ type: raw(e, F.ev.type), detail: raw(e, F.ev.detail), at: raw(e, F.ev.at)?.iso_timestamp, actor: raw(e, F.ev.actor), visible: raw(e, F.ev.visible) === 'Yes' })),
    documents: docs.map(d => ({ id: d.id, name: raw(d, F.doc.fileName), receipt: raw(d, F.doc.receipt), at: raw(d, F.doc.at)?.iso_timestamp, by: raw(d, F.doc.byRole), reviewed: raw(d, F.doc.reviewed) === 'Yes', scan: raw(d, F.doc.scan), url: raw(d, F.doc.file)?.signed_url_inline || null })),
    versions: versions.map(v => ({ id: v.id, number: raw(v, F.ver.number), at: raw(v, F.ver.at)?.iso_timestamp, current: raw(v, F.ver.current) === 'Yes', toPatients: (raw(v, F.ver.toPatients) || []).map(x => x.identifier), toOrgUsers: (raw(v, F.ver.toOrgUsers) || []).map(x => x.identifier) })),
    checklist: items.map(i => ({ name: raw(i, F.item.name), status: raw(i, F.item.status), data: raw(i, F.item.data) })),
    appointments: appts.map(a => ({ id: a.id, start: raw(a, F.appt.startUtc), status: raw(a, F.appt.status), state: raw(a, F.appt.state), paid: raw(a, F.appt.payStatus) === 'Paid' })),
  };
});

on('POST', '/provider/cases/:id/stage', async ({ req, params, body }) => {
  const me = await provider(req);
  const i = +body.stage;
  if (!(i >= 0 && i <= 4)) throw new HttpError(400, 'Ready for download is set only by releasing an approved report.');
  const c = await knack.get(O.cases, params.id);
  if (stageIndex(c) === i) return { ok: true, unchanged: true };
  await knack.update(O.cases, c.id, { [F.case.stage]: STAGES[i], [F.case.lastChange]: knackDate(new Date()) });
  await logEvent(c.id, 'Status change', STAGES[i], actorName(me), true);
  await notifyCase(c, ...MSG.status(STAGES[i]));
  return { ok: true };
});

on('POST', '/provider/cases/:id/hold', async ({ req, params, body }) => {
  const me = await provider(req);
  if (!body.what || !body.who || !body.how) throw new HttpError(400, 'Say what is needed, who provides it and how to submit it.');
  const c = await knack.get(O.cases, params.id);
  await knack.update(O.cases, c.id, { [F.case.onHold]: 'Yes', [F.case.holdWhat]: body.what, [F.case.holdWho]: body.who, [F.case.holdHow]: body.how, [F.case.holdRecv]: '', [F.case.lastChange]: knackDate(new Date()) });
  await logEvent(c.id, 'Hold placed', body.what, actorName(me), true);
  await notifyCase(c, ...MSG.hold);
  return { ok: true };
});

on('POST', '/provider/cases/:id/hold/clear', async ({ req, params }) => {
  const me = await provider(req);
  const c = await knack.get(O.cases, params.id);
  await knack.update(O.cases, c.id, { [F.case.onHold]: 'No', [F.case.holdWhat]: '', [F.case.holdWho]: '', [F.case.holdHow]: '', [F.case.holdRecv]: '', [F.case.lastChange]: knackDate(new Date()) });
  await logEvent(c.id, 'Hold cleared', '', actorName(me), true);
  await notifyCase(c, ...MSG.clear);
  return { ok: true };
});

on('POST', '/provider/cases/:id/hold/keep', async ({ req, params }) => {
  const me = await provider(req);
  const c = await knack.get(O.cases, params.id);
  await knack.update(O.cases, c.id, { [F.case.holdRecv]: '' });
  await logEvent(c.id, 'Hold kept', 'Upload reviewed; information still incomplete', actorName(me), true);
  await notifyCase(c, ...MSG.keep);
  return { ok: true };
});

on('POST', '/provider/documents/:id/reviewed', async ({ req, params }) => {
  const me = await provider(req);
  const d = await knack.get(O.docs, params.id);
  await knack.update(O.docs, d.id, { [F.doc.reviewed]: 'Yes' });
  await logEvent(connId(d, F.doc.case), 'Document reviewed', raw(d, F.doc.fileName), actorName(me), false);
  return { ok: true };
});

// Release: requires quality control stage, no hold, explicit approval and at least one recipient.
on('POST', '/provider/cases/:id/release', async ({ req, params, body }) => {
  const me = await provider(req);
  const c = await knack.get(O.cases, params.id);
  if (stageIndex(c) !== 4) throw new HttpError(409, 'Move the report to In quality control before releasing.');
  if (raw(c, F.case.onHold) === 'Yes') throw new HttpError(409, 'Clear the information hold before releasing.');
  if (body.approve !== true) throw new HttpError(400, 'Confirm that you approve this final version.');
  if (!body.assetId) throw new HttpError(400, 'Attach the signed report PDF.');
  const patientId = connId(c, F.case.patient);
  const toPatients = body.includePatient && patientId ? [{ id: patientId }] : [];
  const orgId = connId(c, F.case.org);
  let toOrgUsers = [];
  if (orgId && Array.isArray(body.orgUserIds)) {
    const allowed = (await knack.list(O.orgUsers, { filters: { match: 'and', rules: [{ field: F.orgUser.org, operator: 'is', value: orgId }] } })).map(u => u.id);
    toOrgUsers = body.orgUserIds.filter(id => allowed.includes(id)).map(id => ({ id }));
  }
  if (!toPatients.length && !toOrgUsers.length) throw new HttpError(400, 'Choose at least one recipient.');
  const prior = await knack.list(O.versions, { filters: { match: 'and', rules: [{ field: F.ver.case, operator: 'is', value: c.id }] } });
  for (const v of prior) if (raw(v, F.ver.current) === 'Yes') await knack.update(O.versions, v.id, { [F.ver.current]: 'No' });
  const number = prior.length + 1;
  await knack.create(O.versions, {
    [F.ver.number]: number, [F.ver.file]: body.assetId, [F.ver.at]: knackDate(new Date()), [F.ver.approved]: 'Yes', [F.ver.current]: 'Yes',
    [F.ver.note]: String(body.note || '').slice(0, 2000), [F.ver.case]: [{ id: c.id }], [F.ver.toPatients]: toPatients, [F.ver.toOrgUsers]: toOrgUsers,
  });
  await knack.update(O.cases, c.id, { [F.case.stage]: STAGES[5], [F.case.lastChange]: knackDate(new Date()) });
  await logEvent(c.id, 'Report released', `Version ${number} approved and released`, actorName(me), true);
  await notifyCase(c, ...MSG.released);
  return { ok: true, version: number };
});

// Fallback when a patient cannot complete ID.me: Dr. Malik checks photo ID on camera.
on('POST', '/provider/patients/:id/verify-manual', async ({ req, params }) => {
  const me = await provider(req);
  await knack.update(O.patients, params.id, { [F.patient.idStatus]: 'Verified', [F.patient.idRef]: `Manual check by ${actorName(me)}`, [F.patient.idAt]: knackDate(new Date()) });
  return { ok: true };
});

// Linking an approved organization user to their organization (creates the organization if new).
on('GET', '/provider/org-users', async ({ req }) => {
  await provider(req);
  const users = await knack.list(O.orgUsers, { rows: 100 });
  const orgs = await knack.list(O.orgs, { rows: 200 });
  return {
    users: users.map(u => ({ id: u.id, name: raw(u, F.orgUser.name)?.full, email: raw(u, F.orgUser.email)?.email, org: (raw(u, F.orgUser.org) || [])[0]?.identifier || null })),
    orgs: orgs.map(o => ({ id: o.id, name: raw(o, F.org.name) })),
  };
});
on('POST', '/provider/org-users/:id/link', async ({ req, params, body }) => {
  await provider(req);
  let orgId = body.orgId;
  if (!orgId && body.newOrgName) orgId = (await knack.create(O.orgs, { [F.org.name]: String(body.newOrgName).slice(0, 200), [F.org.status]: 'Active', [F.org.type]: body.orgType || 'Other' })).id;
  if (!orgId) throw new HttpError(400, 'Choose or name an organization.');
  await knack.update(O.orgUsers, params.id, { [F.orgUser.org]: [{ id: orgId }], [F.orgUser.role]: body.admin ? 'Organization admin' : 'Member' });
  return { ok: true };
});

// ================= SCHEDULED JOBS =================
// Daily (see vercel.json). Emails a reminder for Booked appointments starting in 12–36 hours,
// to patients who left reminders on. Each appointment is reminded once.
on('GET', '/cron/reminders', async ({ req }) => {
  if (!process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) throw new HttpError(401, 'Unauthorized');
  const now = Date.now();
  const appts = await knack.list(O.appts, { filters: { match: 'and', rules: [{ field: F.appt.status, operator: 'is', value: 'Booked' }, { field: F.appt.reminded, operator: 'is not', value: 'Yes' }] }, rows: 200 });
  let sent = 0, skipped = 0;
  for (const a of appts) {
    const start = new Date(raw(a, F.appt.startUtc) || 0).getTime();
    if (!(start - now >= 12 * 3600000 && start - now <= 36 * 3600000)) continue;
    const pid = connId(a, F.appt.patient);
    const p = pid ? await knack.get(O.patients, pid) : null;
    const wants = p && raw(p, F.patient.reminders) !== 'Off';
    const ok = wants ? await sendReminder(raw(p, F.patient.email)?.email) : false;
    await knack.update(O.appts, a.id, { [F.appt.reminded]: 'Yes' });
    const caseId = connId(a, F.appt.case);
    if (caseId) await logEvent(caseId, 'Appointment changed', ok ? 'Reminder email sent' : wants ? 'Reminder email not sent (email not configured)' : 'Reminder skipped (patient turned reminders off)', 'Reminder job', false);
    ok ? sent++ : skipped++;
  }
  return { checked: appts.length, sent, skipped };
});
