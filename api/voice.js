// Phone assistant (pilot, 2026-10-07). Its own function so the Telnyx
// signature can be checked against the exact raw body.
//   POST /api/voice/telnyx    Telnyx Call Control webhook (incoming calls)
//   GET  /api/voice/status    Dr. Malik: setup and who may call
//   POST /api/voice/simulate  Dr. Malik: one turn of a pretend call; saves nothing
//   GET  /api/voice/messages  Dr. Malik: phone messages, last 60 days (1.8.0)
// See api/_lib/voiceMalik.js for who may use it and what it writes.
import { HttpError, knack, O, F, raw, connId } from './_lib/knack.js';
import { requireUser, requireRole, signState, readState } from './_lib/auth.js';
import { verifyTelnyxSignature } from './_lib/telnyxSignature.js';
import { handleTelnyxEvent, makeTelnyxActions } from './_lib/voiceTelnyx.js';
import { startConversation, continueConversation } from './_lib/voiceAttendantCore.js';
import { makeMalikDeps, logVoiceCall, voiceEnabled, allowedNumbers, publicInfo, transferNumber, phoneMessages } from './_lib/voiceMalik.js';

export const config = { api: { bodyParser: false } };

async function rawBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(typeof c === 'string' ? Buffer.from(c) : c);
  return Buffer.concat(chunks).toString('utf8');
}

async function telnyx(req, res) {
  const body = await rawBody(req);
  // This line can speak appointment details, so it never runs unsigned.
  const publicKey = process.env.TELNYX_PUBLIC_KEY;
  if (!process.env.TELNYX_API_KEY || !publicKey) return res.status(200).json({ ignored: 'Telnyx not configured' });
  const ok = verifyTelnyxSignature({ rawBody: body, signature: req.headers['telnyx-signature-ed25519'], timestamp: req.headers['telnyx-timestamp'], publicKey });
  if (!ok) return res.status(401).json({ error: 'invalid signature' });
  let event;
  try { event = JSON.parse(body); } catch { return res.status(200).json({ ignored: 'bad json' }); }
  try {
    const out = await handleTelnyxEvent(event, { deps: await makeMalikDeps().ready(), tx: makeTelnyxActions(), onEnd: logVoiceCall });
    return res.status(200).json(out);
  } catch (e) {
    console.error('voice:', event?.data?.event_type || '?', e.message); // never caller details
    return res.status(200).json({ error: 'handled' });
  }
}

async function provider(req) { const me = await requireUser(req); requireRole(me, 'provider'); return me; }

async function status(req, res) {
  await provider(req);
  const allowed = allowedNumbers();
  const users = await knack.list(O.orgUsers, { rows: 200 });
  const callers = users.filter(u => connId(u, F.orgUser.org)).map(u => {
    const p = raw(u, F.orgUser.phone);
    const digits = String(p?.full || p?.formatted || u[F.orgUser.phone] || '').replace(/\D/g, '').slice(-10);
    return { name: raw(u, F.orgUser.name)?.full || raw(u, F.orgUser.email)?.email || '', org: (raw(u, F.orgUser.org) || [])[0]?.identifier || '', phone: p?.formatted || digits, allowed: digits.length === 10 && allowed.has(digits) };
  });
  const base = process.env.APP_BASE_URL || 'https://app.asifmalikmd.com';
  return res.status(200).json({
    enabled: voiceEnabled(),
    info: publicInfo(),
    transferNumber: transferNumber(),
    setup: { telnyx: !!process.env.TELNYX_API_KEY, signatures: !!process.env.TELNYX_PUBLIC_KEY, ai: !!(process.env.AZURE_OPENAI_ENDPOINT && process.env.AZURE_OPENAI_DEPLOYMENT && process.env.AZURE_OPENAI_API_KEY), email: !!(process.env.RESEND_API_KEY && (process.env.VOICE_ALERT_EMAIL || process.env.PROVIDER_EMAIL)), webhookUrl: `${base}/api/voice/telnyx` },
    callers,
  });
}

async function simulate(req, res) {
  await provider(req);
  let body = {};
  try { body = JSON.parse((await rawBody(req)) || '{}'); } catch { throw new HttpError(400, 'Bad request.'); }
  const deps = await makeMalikDeps({ dryRun: true, ignoreEnabled: true }).ready();
  let out;
  if (!body.token) {
    if (!String(body.from || '').trim()) throw new HttpError(400, 'Enter the phone number to call from.');
    out = await startConversation({ from: String(body.from).trim() }, deps);
  } else {
    let state;
    try { state = readState(body.token); } catch { throw new HttpError(400, 'This test call expired. Start a new one.'); }
    delete state.exp;
    const i = body.input || {};
    out = await continueConversation(state, { digits: String(i.digits || '').slice(0, 12), speech: String(i.speech || '').slice(0, 800), key: String(i.key || '').slice(0, 1) }, deps);
  }
  // The state is signed so the browser can't skip the verification step.
  const state = { ...out.state, a: out.action };
  return res.status(200).json({ say: out.say, action: out.action, digits: out.digits || 0, to: out.to || '', step: state.s, token: signState(state, 1800), wouldSend: deps.wouldSend });
}

export default async function handler(req, res) {
  const action = new URL(req.url, 'http://x').searchParams.get('action') || '';
  try {
    if (req.method === 'POST' && action === 'telnyx') return await telnyx(req, res);
    if (req.method === 'GET' && action === 'status') return await status(req, res);
    if (req.method === 'POST' && action === 'simulate') return await simulate(req, res);
    if (req.method === 'GET' && action === 'messages') { await provider(req); return res.status(200).json({ messages: await phoneMessages() }); }
    throw new HttpError(404, 'Not found');
  } catch (e) {
    const code = e.status || 500;
    if (code >= 500) console.error('voice:', e.message);
    if (!res.headersSent) res.status(code).json({ error: e.message || 'Server error', status: code });
  }
}
