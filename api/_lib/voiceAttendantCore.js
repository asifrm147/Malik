// Phone assistant ("voice attendant") -- the conversation itself (pilot,
// 2026-10-07). Shared with Lemonade (src/server-lib/voiceAttendantCore.js);
// copy changes across rather than letting the two drift.
//
// Patients call the practice number and can hear their
// next or last appointment and leave a message for their provider or the
// front desk. Lawyers, claim managers and other offices can do the same for
// a client, but ONLY when their phone number is on the allowed-callers list
// for that client.
//
// This file has no imports and no Knack/Telnyx code: everything that reads
// or writes practice data comes in as `deps`, so the same conversation runs
// on a real phone call (api/voice.js), in the "Try it" simulator in
// Dr. Malik's workspace, and in tests.
//
// Safety rules built into the flow:
//   - Nobody hears anything until the caller is matched by phone number AND
//     verified: a patient keys in their date of birth; an allowed outside
//     caller keys in their client's date of birth (or case number).
//   - Appointment facts are read from the database and spoken from fixed
//     sentences. The AI only decides WHAT the caller is asking for (one word
//     from a short list); it never writes the answer, so it can't invent a
//     date or share anything else from the chart.
//   - Crisis words always get the 911 / 988 message, before anything else.
//
// State is small and plain (it rides along on the phone call), so keep it
// that way: no chart data in it beyond the verified person's id and first
// name.

export const INTENTS = ["next_appt", "last_appt", "case_status", "message_provider", "message_staff", "repeat", "human", "goodbye", "yes", "unknown"];

const MAX_TRIES = 3;
const MAX_TURNS = 30;
const MAX_MESSAGE = 800;

const CRISIS = /\b(suicid\w*|kill (my|him|her|them)sel(f|ves)|end (my|it all|my life)|want to die|don'?t want to (live|be alive)|overdos\w*|hurt (my|him|her)self|self[- ]harm|emergency)\b/i;
const END_MESSAGE = /\b(that'?s (all|it)|end (of )?(the )?message|i'?m (done|finished)|done|finished)\W*$/i;

const KEY_INTENTS = { 1: "next_appt", 2: "last_appt", 3: "message_provider", 4: "message_staff", 5: "case_status", 9: "repeat", 0: "message_staff" };

// Keyword fallback for when the AI isn't set up or doesn't answer.
export function classifyByKeywords(text) {
  const t = ` ${String(text || "").toLowerCase().replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ")} `;
  if (/^ (no|nope|no thanks|no thank you|nothing|nah) $/.test(t)) return "goodbye";
  if (/^ (yes|yeah|yep|sure|ok|okay|yes please) $/.test(t)) return "yes";
  if (/\b(bye|goodbye|that's all|that is all|nothing else|hang up|no thank you|no thanks)\b/.test(t)) return "goodbye";
  if (/\b(repeat|say that again|again please|didn't hear|did not hear|come again)\b/.test(t)) return "repeat";
  if (/\b(report|case status|status of (the |my )?(case|report)|evaluation status|records review|where is (the|my) (case|report))\b/.test(t)) return "case_status";
  if (/\b(doctor|dr|provider|therapist|counselor|prescriber|psychiatrist|nurse|refill|medication|prescription|pa|np)\b/.test(t) && /\b(message|tell|ask|question|talk|speak|refill|leave|call me|let)\b/.test(t)) return "message_provider";
  if (/\b(message|call me|call back|callback|front desk|staff|office|billing|bill|reschedule|cancel|change my appointment|question|leave)\b/.test(t)) return "message_staff";
  if (/\b(person|human|someone|representative|operator|receptionist|real person|agent)\b/.test(t)) return "human";
  if (/\b(last|previous|past|most recent|did (i|he|she|they) (go|attend|show)|attended)\b/.test(t)) return "last_appt";
  if (/\b(next|upcoming|coming up|when is|when's|scheduled|appointment|appt|when do i)\b/.test(t)) return "next_appt";
  return "unknown";
}

// Ask the practice's Azure OpenAI deployment for ONE intent word. Returns
// null (and the keyword fallback is used) when it isn't configured or fails.
export async function classifyWithAzure(text, { env = process.env, fetchImpl = fetch, kind = "patient", timeoutMs = 4000 } = {}) {
  const endpoint = String(env.AZURE_OPENAI_ENDPOINT || "").replace(/\/+$/, "");
  const deployment = env.AZURE_OPENAI_DEPLOYMENT;
  const apiKey = env.AZURE_OPENAI_API_KEY;
  if (!endpoint || !deployment || !apiKey || !String(text || "").trim()) return null;
  const base = endpoint.replace(/\/openai\/v1\/?$/, "");
  const url = `${base}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=2024-08-01-preview`;
  const system = [
    "You route phone calls for a psychiatry practice's automated phone assistant.",
    `The caller is ${kind === "patient" ? "a patient" : "an authorized outside office (for example an attorney or claim manager) calling about a client"}.`,
    `Reply with JSON only: {"intent": one of ${JSON.stringify(INTENTS)}}.`,
    "next_appt = when is the next/upcoming appointment. last_appt = when was the last/previous appointment or whether they attended.",
    "case_status = status of a report, evaluation or records review. message_provider = wants to leave a message or question for the doctor/provider (including refills).",
    "message_staff = wants to leave a message for the office/front desk (billing, rescheduling, cancelling, call back, general questions).",
    "human = asks for a real person. repeat = asks to hear it again. goodbye = done / no more questions. yes = a bare yes. unknown = anything else.",
    "Never answer the caller's question yourself.",
  ].join(" ");
  const ctl = typeof AbortController === "function" ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "system", content: system }, { role: "user", content: String(text).slice(0, 600) }], temperature: 0, max_tokens: 20, response_format: { type: "json_object" } }),
      signal: ctl?.signal,
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    const intent = JSON.parse(data?.choices?.[0]?.message?.content || "{}")?.intent;
    return INTENTS.includes(intent) ? intent : null;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---- Spoken wording -----------------------------------------------------------
export function spellDigitsHint(n) {
  return n === 8 ? "as eight digits: two for the month, two for the day, and four for the year. For example, March fifth, nineteen eighty would be zero three, zero five, one nine eight zero" : `followed by the pound key`;
}

function menuLine(state) {
  const whose = state.k === "patient" ? "your" : `${state.sn || "your client"}'s`;
  const parts = [`You can ask about ${whose} next appointment or last appointment`];
  if (state.cs) parts.push(`the status of the ${state.k === "patient" ? "" : "case or "}report`);
  parts.push(`or leave a message for ${state.k === "patient" ? "your provider or the office" : "the provider or the office"}`);
  return `${parts.join(", ")}.`;
}

function apptSentence(state, which, appt) {
  const who = state.k === "patient" ? "Your" : `${state.sn || "Your client"}'s`;
  if (!appt) {
    return which === "next"
      ? `I don't see an upcoming appointment on file for ${state.k === "patient" ? "you" : state.sn || "your client"}. If you'd like to schedule one, you can leave a message for the office.`
      : `I don't see a past appointment on file for ${state.k === "patient" ? "you" : state.sn || "your client"}.`;
  }
  const withWho = appt.provider ? ` with ${appt.provider}` : "";
  const how = appt.how ? `, ${appt.how}` : "";
  if (which === "next") return `${who} next appointment is ${appt.when}${withWho}${how}.`;
  const status = /no.?show/i.test(appt.status || "") ? " It was marked as missed." : /complete|attended|seen/i.test(appt.status || "") ? " It was completed." : "";
  return `${who} last appointment was ${appt.when}${withWho}.${status}`;
}

const say = (state, text, action = "listen", extra = {}) => ({ state, say: text, action, ...extra });

// ---- The conversation ---------------------------------------------------------
// Returns { state, say, action, digits? } where action is one of:
//   "gather"  -- speak `say`, then collect `digits` keypad digits (ends with #)
//   "listen"  -- speak `say` (if any), then listen for speech or a key
//   "hangup"  -- speak `say`, then hang up
export async function startConversation({ from }, deps) {
  const state = { v: 1, s: "start", f: String(from || ""), t: 0, u: 0, n: 0, d: [] };
  if (deps.enabled && !(await deps.enabled())) {
    return say({ ...state, s: "end" }, `Thank you for calling ${deps.practiceName}. Our automated phone assistant is not available right now. Please call back during office hours. Goodbye.`, "hangup");
  }
  const caller = await deps.lookupCaller(state.f).catch(() => null);
  if (!caller) {
    state.d.push("not-allowed");
    return say({ ...state, s: "end" }, `Thank you for calling ${deps.practiceName}. This automated line can only help patients and approved offices calling from a phone number we have on file. Please call the office during business hours. If this is an emergency, hang up and dial 9 1 1. Goodbye.`, "hangup");
  }
  const next = { ...state, s: "verify", k: caller.kind, cn: caller.firstName || "", cid: caller.id || "", cs: Boolean(deps.caseStatus) };
  const digits = caller.verifyDigits || 8;
  next.vd = digits;
  if (caller.kind === "patient") {
    const hi = caller.firstName && !caller.shared ? `Hi ${caller.firstName}. ` : "Hi. ";
    return say(next, `Thank you for calling ${deps.practiceName}. ${hi}This call is with our automated assistant. To protect your privacy, please enter your date of birth ${spellDigitsHint(8)}. Then press pound.`, "gather", { digits });
  }
  const org = caller.org ? ` from ${caller.org}` : "";
  const what = caller.verifyPrompt || `your client's date of birth ${spellDigitsHint(8)}`;
  return say(next, `Thank you for calling ${deps.practiceName}. Hello${caller.firstName ? ` ${caller.firstName}` : ""}${org}. This call is with our automated assistant. To look up your client, please enter ${what}. Then press pound.`, "gather", { digits });
}

export async function continueConversation(state, input, deps) {
  const st = { ...state, d: [...(state.d || [])], n: (state.n || 0) + 1 };
  if (st.n > MAX_TURNS) return say({ ...st, s: "end" }, "We've reached the end of what I can help with on this call. Thank you for calling. Goodbye.", "hangup");

  if (st.s === "verify") {
    const digits = String(input?.digits || "").replace(/\D/g, "");
    const result = digits ? await deps.verify(st, digits).catch(() => null) : null;
    if (!result?.ok) {
      st.t = (st.t || 0) + 1;
      if (st.t >= MAX_TRIES) {
        st.d.push("verify-failed");
        return say({ ...st, s: "end" }, "Sorry, I wasn't able to verify that. For your privacy I can't share any information on this call. Please call the office during business hours. Goodbye.", "hangup");
      }
      const again = st.k === "patient" ? "your date of birth" : "that again";
      return say(st, `Sorry, that didn't match our records. Please enter ${again}, then press pound.`, "gather", { digits: st.vd || 8 });
    }
    st.s = "menu";
    st.t = 0;
    st.sid = result.subjectId;
    st.sn = result.subjectFirstName || "";
    st.d.push("verified");
    const welcome = st.k === "patient" ? `Thank you${st.sn ? `, ${st.sn}` : ""}.` : `Thank you. I found ${st.sn ? `${st.sn}'s record` : "the record"}.`;
    return say(st, `${welcome} ${menuLine(st)} What can I help you with?`);
  }

  if (st.s === "message") {
    const key = String(input?.key || "");
    let text = String(input?.speech || "").trim();
    let finish = key === "#";
    if (text && END_MESSAGE.test(text)) {
      finish = true;
      text = text.replace(END_MESSAGE, "").trim();
    }
    if (text) st.m = `${st.m ? `${st.m} ` : ""}${text}`.slice(0, MAX_MESSAGE);
    if (!finish && (st.m || "").length < MAX_MESSAGE) return say(st, "", "listen");
    const message = String(st.m || "").trim();
    const target = st.mt;
    delete st.m;
    delete st.mt;
    st.s = "menu";
    if (!message) return say(st, "I didn't catch a message. Is there anything else I can help with?");
    const urgent = CRISIS.test(message);
    if (urgent) st.d.push("crisis");
    const sent = await deps.leaveMessage({ state: st, target, text: message, urgent }).catch(() => null);
    if (!sent?.ok) return say(st, "Sorry, I couldn't save your message just now. Please call the office during business hours. Is there anything else I can help with?");
    st.d.push(`message-${target}`);
    const safety = urgent ? " If you are in danger or this is an emergency, please hang up and call 9 1 1, or call or text 9 8 8." : "";
    return say(st, `Thank you. Your message has been sent to ${sent.to || (target === "provider" ? "the provider" : "the office")}, and someone will follow up with you.${safety} Is there anything else I can help with?`);
  }

  if (st.s !== "menu") return say({ ...st, s: "end" }, "Goodbye.", "hangup");

  const speech = String(input?.speech || "").trim();
  const key = String(input?.key || "");
  if (speech && CRISIS.test(speech)) {
    st.d.push("crisis");
    if (deps.flagUrgent) await deps.flagUrgent({ state: st, text: speech }).catch(() => null);
    return say(st, "If you are in danger or this is an emergency, please hang up and call 9 1 1 now. You can also call or text 9 8 8, the Suicide and Crisis Lifeline, any time, day or night. I've also let the care team know you called. Is there anything else I can help with?");
  }

  let intent = KEY_INTENTS[key] || null;
  if (!intent && speech) intent = (deps.classify ? await deps.classify(speech, st).catch(() => null) : null) || classifyByKeywords(speech);
  if (!intent) intent = "unknown";
  if (intent === "case_status" && !deps.caseStatus) intent = "unknown";

  if (intent === "goodbye") return say({ ...st, s: "end" }, `Thank you for calling ${deps.practiceName}. Goodbye.`, "hangup");
  if (intent === "repeat" || intent === "yes") return say(st, `${menuLine(st)} What can I help you with?`);
  if (intent === "next_appt" || intent === "last_appt") {
    st.u = 0;
    const which = intent === "next_appt" ? "next" : "last";
    const appts = await deps.appointments(st).catch(() => null);
    if (!appts) return say(st, "Sorry, I couldn't look up appointments just now. You can leave a message for the office instead. Is there anything else I can help with?");
    st.d.push(`${which}-appt`);
    return say(st, `${apptSentence(st, which, appts[which])} Is there anything else I can help with?`);
  }
  if (intent === "case_status") {
    st.u = 0;
    const line = await deps.caseStatus(st).catch(() => null);
    st.d.push("case-status");
    return say(st, `${line || "I couldn't find a report status on file."} Is there anything else I can help with?`);
  }
  if (intent === "message_provider" || intent === "message_staff" || intent === "human") {
    st.u = 0;
    st.s = "message";
    st.mt = intent === "message_provider" ? "provider" : "staff";
    st.m = "";
    const to = st.mt === "provider" ? (st.k === "patient" ? "your provider" : "the provider") : "the office staff";
    const lead = intent === "human" ? "I'm not able to transfer calls yet, but I can take a message and someone will call you back. " : "";
    return say(st, `${lead}Please say your message for ${to} now, including the best number to reach you. Please don't share anything urgent this way. When you're finished, press pound, or say "that's all".`);
  }
  st.u = (st.u || 0) + 1;
  if (st.u >= MAX_TRIES) {
    st.s = "message";
    st.mt = "staff";
    st.m = "";
    return say(st, "I'm sorry I'm having trouble understanding. Let me take a message for the office instead. Please say your message now, and press pound when you're done.");
  }
  return say(st, `Sorry, I didn't catch that. ${menuLine(st)} You can also press 1 for the next appointment, 2 for the last appointment, 3 to message ${st.k === "patient" ? "your" : "the"} provider, or 4 to message the office${st.cs ? ", or 5 for the report status" : ""}.`);
}

// One line for the call log: who called and what happened (no chart data).
export function callOutcome(state) {
  const did = new Set(state?.d || []);
  const bits = [];
  if (did.has("not-allowed")) bits.push("number not on file or allowed list -- told to call the office");
  if (did.has("verify-failed")) bits.push("could not verify -- nothing shared");
  if (did.has("verified")) bits.push("verified");
  if (did.has("next-appt")) bits.push("heard next appointment");
  if (did.has("last-appt")) bits.push("heard last appointment");
  if (did.has("case-status")) bits.push("heard report status");
  if (did.has("message-provider")) bits.push("left a message for the provider");
  if (did.has("message-staff")) bits.push("left a message for the office");
  if (did.has("crisis")) bits.push("crisis words -- given 911/988 and staff alerted");
  return bits.join("; ") || "hung up before anything happened";
}

// ---- Compact state for Telnyx client_state ------------------------------------
export const encodeVoiceState = (state) => Buffer.from(JSON.stringify(state)).toString("base64");
export const decodeVoiceState = (s) => {
  try {
    const o = JSON.parse(Buffer.from(String(s || ""), "base64").toString("utf8"));
    return o && typeof o === "object" && o.v === 1 ? o : null;
  } catch {
    return null;
  }
};
