// Phone assistant (pilot). Run: npm test
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';

process.env.KNACK_APP_ID = 'app';
process.env.KNACK_API_KEY = 'key';
process.env.STATE_SECRET = 'test-secret';

const { makeMalikDeps, pickAppointments, spokenWhen, dobMatches, allowedOrgCallers } = await import('../api/_lib/voiceMalik.js');
const { startConversation, continueConversation } = await import('../api/_lib/voiceAttendantCore.js');
const { default: handler } = await import('../api/voice.js');

// ---- a fake Knack -----------------------------------------------------------------
const PATIENT = { id: 'pat1', field_23_raw: { first: 'Ann', last: 'Lee' }, field_34_raw: { full: '5095550100', formatted: '(509) 555-0100' }, field_35_raw: { date: '03/05/1980' } };
const LAWYER = { id: 'ou1', field_59_raw: { first: 'Lee', full: 'Lee Pratt' }, field_70_raw: { full: '5095550199' }, field_193_raw: [{ id: 'org1', identifier: 'Pratt Law' }] };
const UNLINKED = { id: 'ou2', field_59_raw: { first: 'Sam' }, field_70_raw: { full: '5095550188' }, field_193_raw: [] };
const CASE = { id: 'case1', field_92_raw: 42, field_94_raw: 'Dictated', field_95_raw: 'No', field_109_raw: 'Bo Smith', field_195_raw: [{ id: 'org1' }] };
const OTHER_ORG_CASE = { id: 'case2', field_92_raw: 43, field_195_raw: [{ id: 'org9' }] };
const PATIENT_CASE = { id: 'case3', field_92_raw: 44, field_194_raw: [{ id: 'pat1' }] };
const future = new Date(Date.now() + 5 * 86400000).toISOString();
const APPTS = [{ id: 'a1', field_208_raw: future, field_119_raw: 'Booked', field_197_raw: [{ id: 'pat1' }], field_198_raw: [{ id: 'case1' }] }];
let writes = [];

function filterRecs(recs, filters) {
  if (!filters) return recs;
  return recs.filter(r => filters.rules.every(({ field, operator, value }) => {
    const v = r[`${field}_raw`];
    if (operator === 'contains') return String(v?.full || '').includes(value);
    if (operator === 'is') return Array.isArray(v) ? v.some(x => x.id === value) : String(v) === String(value);
    return true;
  }));
}
const TABLES = { object_3: [PATIENT], object_5: [LAWYER, UNLINKED], object_7: [CASE, OTHER_ORG_CASE, PATIENT_CASE], object_8: APPTS };
beforeEach(() => {
  writes = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const m = /\/objects\/(object_\d+)\/records(?:\/(\w+))?/.exec(u.pathname);
    if (opts.method === 'POST') { writes.push(JSON.parse(opts.body)); return new Response('{"id":"new"}'); }
    const recs = TABLES[m?.[1]] || [];
    if (m?.[2]) return new Response(JSON.stringify(recs.find(r => r.id === m[2]) || {}));
    const f = u.searchParams.get('filters');
    return new Response(JSON.stringify({ records: filterRecs(recs, f ? JSON.parse(f) : null) }));
  };
});

// ---- who may call -------------------------------------------------------------------
test('firms must be on VOICE_ALLOWED_NUMBERS and linked to an organization', async () => {
  process.env.VOICE_ALLOWED_NUMBERS = '';
  assert.equal((await allowedOrgCallers('+15095550199')).length, 0);
  process.env.VOICE_ALLOWED_NUMBERS = '(509) 555-0199, 509-555-0188';
  assert.equal((await allowedOrgCallers('+15095550199')).length, 1);
  assert.equal((await allowedOrgCallers('+15095550188')).length, 0, 'unlinked user stays out even when listed');
});

test('a patient asks first, then verifies by birth date, then hears the answer', async () => {
  const deps = await makeMalikDeps({ dryRun: true, ignoreEnabled: true }).ready();
  const a = await startConversation({ from: '+15095550100' }, deps);
  assert.match(a.say, /automated assistant/);
  assert.match(a.say, /transcribed/);
  assert.doesNotMatch(a.say, /Ann/, 'no name before verification');
  const ask = await continueConversation(a.state, { speech: 'when is my next appointment' }, deps);
  assert.equal(ask.action, 'gather');
  const bad = await continueConversation(ask.state, { digits: '01011970' }, deps);
  assert.equal(bad.state.s, 'verify');
  const v = await continueConversation(ask.state, { digits: '03051980' }, deps);
  assert.match(v.say, /you're verified\. Your next appointment is .* with Dr\. Malik, by video\./);
});

test('an allowed firm verifies by case number, only for its own organization', async () => {
  process.env.VOICE_ALLOWED_NUMBERS = '5095550199';
  const deps = await makeMalikDeps({ dryRun: true, ignoreEnabled: true }).ready();
  const a = await startConversation({ from: '+15095550199' }, deps);
  assert.doesNotMatch(a.say, /Pratt/);
  const ask = await continueConversation(a.state, { speech: 'what is the status of the report' }, deps);
  assert.match(ask.say, /the case number/);
  assert.equal(ask.digits, 10);
  const other = await continueConversation(ask.state, { digits: '43' }, deps);
  assert.equal(other.state.s, 'verify', "another firm's case is not found");
  const v = await continueConversation(ask.state, { digits: '42' }, deps);
  assert.match(v.say, /I found Bo's record\. Case 42 is at the stage: Dictated\./);
  const msg = await continueConversation(v.state, { key: '3' }, deps);
  const done = await continueConversation(msg.state, { speech: "Please send the report. That's all" }, deps);
  assert.match(done.say, /sent to Dr\. Malik's office/);
  assert.equal(deps.wouldSend[0].kind, 'Case event');
  assert.match(deps.wouldSend[0].detail, /Lee Pratt, Pratt Law \(allowed caller\).*"Please send the report\."/);
  assert.equal(deps.wouldSend[1].detail, '(no details in the email)');
  assert.equal(writes.length, 0, 'dry run writes nothing');
});

test('unknown numbers: office info and a message, nothing about any patient; off means off', async () => {
  process.env.VOICE_HOURS = 'Mondays 9 to noon';
  const deps = await makeMalikDeps({ dryRun: true, ignoreEnabled: true }).ready();
  const a = await startConversation({ from: '+12065550000' }, deps);
  const hours = await continueConversation(a.state, { speech: 'what are your hours' }, deps);
  assert.match(hours.say, /Mondays 9 to noon/);
  const ask = await continueConversation(hours.state, { speech: 'when is my appointment' }, deps);
  assert.match(ask.say, /not able to look anything up/);
  const yes = await continueConversation(ask.state, { speech: 'yes' }, deps);
  await continueConversation(yes.state, { speech: "This is Jo, call me at 509 555 0123. That's all" }, deps);
  assert.equal(deps.wouldSend[0].kind, 'Phone message (no case)');
  assert.match(deps.wouldSend[0].detail, /NOT verified/);
  process.env.VOICE_ATTENDANT_ON = '';
  const off = await startConversation({ from: '+15095550100' }, await makeMalikDeps().ready());
  assert.match(off.say, /isn't available right now/);
});

test('reschedule offers two real Monday times; a crisis gets the danger question', async () => {
  const deps = await makeMalikDeps({ dryRun: true, ignoreEnabled: true }).ready();
  let out = await continueConversation((await startConversation({ from: '+15095550100' }, deps)).state, { speech: 'I need to reschedule' }, deps);
  out = await continueConversation(out.state, { digits: '03051980' }, deps);
  assert.match(out.say, /Monday, .* at (9|10|11) AM, or Monday/);
  out = await continueConversation(out.state, { speech: 'the first one' }, deps);
  assert.match(out.say, /asked the office to move your appointment/);
  assert.match(deps.wouldSend.at(-2).detail, /asked to move their appointment/);
  const c = await continueConversation((await startConversation({ from: '+12065550000' }, deps)).state, { speech: "I don't want to be alive anymore" }, deps);
  assert.match(c.say, /immediate danger/);
  assert.equal(deps.wouldSend.at(-2).title, 'Urgent phone call');
});

test('a phone event falls back to "Status change" while the Knack choice is missing', async () => {
  const { saveEvent } = await import('../api/_lib/voiceMalik.js');
  const real = globalThis.fetch;
  const posts = [];
  globalThis.fetch = async (url, opts = {}) => {
    if (opts.method === 'POST') {
      const body = JSON.parse(opts.body);
      posts.push(body);
      if (body.field_171 === 'Phone message') return new Response('{"errors":[{"message":"invalid option"}]}', { status: 400 });
      return new Response('{"id":"e1"}');
    }
    return real(url, opts);
  };
  try {
    await saveEvent(null, 'Phone message', 'hello');
  } finally {
    globalThis.fetch = real;
  }
  assert.equal(posts.length, 2);
  assert.equal(posts[1].field_171, 'Status change');
  assert.equal(posts[1].field_172, '[Phone message] hello');
  assert.equal(posts[1].field_204, undefined, 'no case for an unverified caller');
});

test('helpers', () => {
  assert.equal(dobMatches('3/5/1980', '03051980'), true);
  assert.equal(spokenWhen('2026-10-12T16:00:00.000Z'), 'Monday, October 12 at 9 AM');
  const now = Date.parse('2026-10-07T12:00:00Z');
  const rec = (start, status) => ({ field_208_raw: start, field_119_raw: status });
  const out = pickAppointments([rec('2026-10-12T16:00:00Z', 'Booked'), rec('2026-10-05T16:00:00Z', 'No-show'), rec('2026-10-19T16:00:00Z', 'Cancelled'), rec('2026-09-28T16:00:00Z', 'Completed')], now);
  assert.equal(out.next.when, 'Monday, October 12 at 9 AM');
  assert.equal(out.last.status, 'No-show');
});

// ---- the endpoint --------------------------------------------------------------------
function fakeReqRes({ method = 'POST', url, body = '', headers = {} }) {
  const req = { method, url, headers, async *[Symbol.asyncIterator]() { yield Buffer.from(body); } };
  const res = { statusCode: 0, body: null, headersSent: false, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; this.headersSent = true; return this; } };
  return { req, res };
}

test('webhook: ignored without signature keys, 401 when unsigned, runs when signed', async () => {
  delete process.env.TELNYX_PUBLIC_KEY;
  process.env.TELNYX_API_KEY = 'k';
  const body = JSON.stringify({ data: { event_type: 'call.initiated', payload: { call_control_id: 'cc', direction: 'outgoing' } } });
  let { req, res } = fakeReqRes({ url: '/api/voice?action=telnyx', body });
  await handler(req, res);
  assert.equal(res.body.ignored, 'Telnyx not configured');

  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  process.env.TELNYX_PUBLIC_KEY = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
  ({ req, res } = fakeReqRes({ url: '/api/voice?action=telnyx', body, headers: { 'telnyx-signature-ed25519': 'bad', 'telnyx-timestamp': String(Math.floor(Date.now() / 1000)) } }));
  await handler(req, res);
  assert.equal(res.statusCode, 401);

  const ts = String(Math.floor(Date.now() / 1000));
  const sig = sign(null, Buffer.from(`${ts}|${body}`), privateKey).toString('base64');
  ({ req, res } = fakeReqRes({ url: '/api/voice?action=telnyx', body, headers: { 'telnyx-signature-ed25519': sig, 'telnyx-timestamp': ts } }));
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ignored, 'outgoing');
});

test('simulator needs Dr. Malik signed in', async () => {
  const { req, res } = fakeReqRes({ url: '/api/voice?action=simulate', body: '{"from":"5095550100"}' });
  await handler(req, res);
  assert.equal(res.statusCode, 401);
});
