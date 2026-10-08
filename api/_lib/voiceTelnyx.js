// Phone assistant on a real phone line through Telnyx Call Control. Shared
// with Lemonade (src/server-lib/voiceTelnyx.js).
// Turns Telnyx call events into turns of the conversation in
// voiceAttendantCore.js and speaks the replies.
//
//   call.initiated (incoming)  -> answer
//   call.answered              -> greet; ask for the date of birth (keypad)
//   call.gather.ended          -> check the digits
//   call.transcription (final) -> a spoken request or part of a message
//   call.dtmf.received         -> a menu key, or # to finish a message
//   call.speak.ended           -> start listening again, transfer, or hang up
//   call.hangup                -> one line in the call log
//
// While the assistant is talking, live transcription is stopped so it
// doesn't hear itself. The conversation state rides along on the call as
// Telnyx client_state (kept small on purpose), so no database or Blob write
// is needed per turn.
//
// No imports: the Malik portal has a copy (api/_lib/voiceTelnyx.js).
import { startConversation, continueConversation, encodeVoiceState, decodeVoiceState, callOutcome } from "./voiceAttendantCore.js";

const TELNYX = "https://api.telnyx.com/v2";
// The conversation states that take speech or menu keys (1.8.0).
const LISTENING = new Set(["menu", "message", "resched", "crisis_q", "crisis_loc", "crisis_offer"]);

export function makeTelnyxActions({ apiKey = process.env.TELNYX_API_KEY, fetchImpl = fetch, voice, language = "en-US" } = {}) {
  const ttsVoice = voice || process.env.VOICE_ATTENDANT_TTS_VOICE || "female";
  async function action(callId, name, body = {}) {
    const res = await fetchImpl(`${TELNYX}/calls/${encodeURIComponent(callId)}/actions/${name}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      const err = new Error(data?.errors?.[0]?.detail || `Telnyx ${name} returned ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return true;
  }
  const quiet = (p) => p.catch(() => false);
  return {
    answer: (id, state) => action(id, "answer", { client_state: encodeVoiceState(state) }),
    hangup: (id) => quiet(action(id, "hangup", {})),
    speak: (id, text, state) => action(id, "speak", { payload: text, voice: ttsVoice, language, client_state: encodeVoiceState(state) }),
    gather: (id, text, digits, state) => action(id, "gather_using_speak", {
      payload: text, voice: ttsVoice, language,
      minimum_digits: 1, maximum_digits: digits, terminating_digit: "#", valid_digits: "0123456789",
      timeout_millis: 20000, inter_digit_timeout_millis: 8000,
      client_state: encodeVoiceState(state),
    }),
    listen: (id, state) => action(id, "transcription_start", { language: "en", transcription_engine: "B", interim_results: false, client_state: encodeVoiceState(state) }),
    stopListening: (id) => quiet(action(id, "transcription_stop", {})),
    saveState: (id, state) => quiet(action(id, "client_state_update", { client_state: encodeVoiceState(state) })),
    // 1.8.0: hand the caller to a person (the office / on-call line).
    transfer: (id, to) => action(id, "transfer", { to }),
  };
}

// Carry out one reply from the conversation.
export async function perform(tx, callId, out) {
  const state = { ...out.state, a: out.action, ...(out.action === "transfer" ? { tt: out.to } : {}) };
  if (out.action === "gather") {
    await tx.stopListening(callId);
    return tx.gather(callId, out.say, out.digits || 8, state);
  }
  if (!out.say) {
    // Mid-message: keep listening, just remember what was said so far.
    return tx.saveState(callId, state);
  }
  await tx.stopListening(callId);
  return tx.speak(callId, out.say, state);
}

// Handle one Telnyx webhook body. `deps` are the practice-data hooks the
// conversation needs (see voiceAttendantCore.js); `onEnd(state, from)` logs
// the call.
export async function handleTelnyxEvent(body, { deps, tx, onEnd }) {
  const type = body?.data?.event_type || "";
  const p = body?.data?.payload || {};
  const callId = p.call_control_id;
  if (!callId) return { ignored: "no call" };
  const state = decodeVoiceState(p.client_state);

  if (type === "call.initiated") {
    if (p.direction !== "incoming") return { ignored: "outgoing" };
    await tx.answer(callId, { v: 2, s: "new", f: String(p.from || ""), d: [] });
    return { ok: "answered" };
  }
  if (!state) return { ignored: "not a phone-assistant call" };

  if (type === "call.answered" && state.s === "new") {
    const out = await startConversation({ from: state.f }, deps);
    await perform(tx, callId, out);
    return { ok: "greeted" };
  }
  if (type === "call.gather.ended" && state.s === "verify") {
    if (p.status === "call_hangup") return { ignored: "hung up" };
    const out = await continueConversation(state, { digits: p.digits || "" }, deps);
    await perform(tx, callId, out);
    return { ok: "verify" };
  }
  if (type === "call.speak.ended") {
    if (state.a === "hangup") await tx.hangup(callId);
    else if (state.a === "transfer" && state.tt) {
      try { await tx.transfer(callId, state.tt); } catch { await tx.hangup(callId); }
    } else if (state.a === "listen") await tx.listen(callId, state);
    return { ok: "spoke" };
  }
  if (type === "call.transcription") {
    const t = p.transcription_data || {};
    const text = String(t.transcript || "").trim();
    if (t.is_final === false || !text) return { ignored: "partial" };
    if (!LISTENING.has(state.s)) return { ignored: "not listening" };
    if (state.a !== "listen") return { ignored: "talking" };
    const out = await continueConversation(state, { speech: text }, deps);
    await perform(tx, callId, out);
    return { ok: "heard" };
  }
  if (type === "call.dtmf.received") {
    if (!LISTENING.has(state.s)) return { ignored: "not a menu key" };
    const out = await continueConversation(state, { key: String(p.digit || "") }, deps);
    await perform(tx, callId, out);
    return { ok: "key" };
  }
  if (type === "call.hangup") {
    if (onEnd) await onEnd(state, callOutcome(state)).catch(() => null);
    return { ok: "ended" };
  }
  return { ignored: type };
}
