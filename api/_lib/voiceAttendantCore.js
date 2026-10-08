// Phone assistant ("voice attendant") -- the conversation itself. Pilot in
// 1.7.8; rebuilt in 1.8.0 around the practice's directive for a
// behavioral-health and Washington L&I front desk:
//
//   - Say it's automated, and that the call is transcribed (RCW 9.73.030
//     consent), then ask what the caller needs BEFORE asking who they are.
//   - Public information (hours, address, fax, new patients) needs no
//     verification. Anything about a patient does.
//   - Verification = calling from the number on file AND keying in the date
//     of birth (the patient's, or the client's for an allowed outside office).
//     Caller ID alone is never enough, and nothing -- not even a first name --
//     is said that would confirm someone is a patient before verification.
//   - The AI only decides WHAT the caller is asking for (one word from a
//     list). Every answer is a fixed sentence built from Lemonade's data, so
//     it can't invent a date, a status or a promise.
//   - Safety first: crisis words -> "are you in immediate danger?", then the
//     emergency path; a threat against another person -> immediate human
//     escalation (a duty-to-warn candidate; people decide, not the AI).
//   - Lead with what it CAN do; after two misunderstandings, offer a person.
//   - Medication: take a structured request, never promise a refill.
//   - Rescheduling: offer real open times, then send the request to staff.
//
// Shared with Lemonade (src/server-lib/voiceAttendantCore.js) -- copy changes
// across rather than letting the two drift.
//
// No imports and no Knack/Telnyx code: everything that touches practice data
// comes in as `deps`, so the same conversation runs on a real call
// (api/voice.js), in the "Try it" simulator in Dr. Malik's workspace, and in
// tests. State is
// small and plain because it rides along on the phone call.

export const INTENTS = [
  "next_appt", "last_appt", "case_status", "reschedule", "refill", "message_provider", "message_staff",
  "hours", "location", "fax", "new_patients",
  "human", "repeat", "goodbye", "yes", "no", "unknown",
];
const PHI_INTENTS = new Set(["next_appt", "last_appt", "case_status", "reschedule", "refill", "message_provider"]);
const PUBLIC_INTENTS = new Set(["hours", "location", "fax", "new_patients"]);

const MAX_TRIES = 2;
const MAX_TURNS = 40;
const MAX_MESSAGE = 800;

export const CRISIS = /\b(suicid\w*|kill (my|him|her|them)sel(f|ves)|end (it all|my life)|want to die|wish i (was|were) dead|wish i wouldn'?t wake up|don'?t want to (live|be alive|be here)|can'?t (take|do) (this|it) any ?more|overdos\w*|took (all|a bunch of) (my|the) (pills|meds)|hurt(ing)? (my|him|her)self|self[- ]harm|cut(ting)? myself)\b/i;
export const THREAT = /\b(going to|gonna|want to|will|i'?ll|about to)\s+(kill|shoot|stab|hurt|attack|beat up|strangle)\s+(my\s+(boss|supervisor|wife|husband|ex|partner|neighbor|coworker|co-worker|manager|dad|mom|father|mother|brother|sister|son|daughter|kid|kids|family)|him|her|them|someone|somebody|everyone|everybody|people|you|[a-z]+ at work)\b/i;
const END_MESSAGE = /\b(that'?s (all|it)|end (of )?(the )?message|i'?m (done|finished)|done|finished)\W*$/i;
const KEY_INTENTS = { 1: "next_appt", 2: "last_appt", 3: "message_provider", 4: "message_staff", 5: "case_status", 6: "reschedule", 9: "repeat", 0: "human" };

// Keyword fallback for when no AI provider answers.
export function classifyByKeywords(text) {
  const t = ` ${String(text || "").toLowerCase().replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ")} `;
  if (/^ (no|nope|no thanks|no thank you|nothing|nah|neither|none) $/.test(t)) return "no";
  if (/^ (yes|yeah|yep|sure|ok|okay|yes please|correct|right) $/.test(t)) return "yes";
  if (/\b(bye|goodbye|that's all|that is all|nothing else|hang up|no thank you|no thanks)\b/.test(t)) return "goodbye";
  if (/\b(repeat|say that again|again please|didn't hear|did not hear|come again)\b/.test(t)) return "repeat";
  if (/\b(fax number|fax)\b/.test(t)) return "fax";
  if (/\b(hours|open|close|closing|what time do you)\b/.test(t)) return "hours";
  if (/\b(address|located|location|where are you|directions|parking)\b/.test(t)) return "location";
  if (/\b(new patients?|accepting|take my insurance|become a patient|first appointment|intake)\b/.test(t)) return "new_patients";
  if (/\b(refill|out of (my )?(meds|medication|medicine|pills)|ran out|prescription|pharmacy)\b/.test(t)) return "refill";
  if (/\b(reschedule|move my appointment|change my appointment|different time|different day|another time|push (it|my appointment) back)\b/.test(t)) return "reschedule";
  if (/\b(report|case status|status of (the |my )?(case|report)|evaluation status|records review|where is (the|my) (case|report))\b/.test(t)) return "case_status";
  if (/\b(doctor|dr|provider|therapist|counselor|prescriber|psychiatrist|nurse|pa|np|side effect|dizzy|nause\w*|medication)\b/.test(t) && /\b(message|tell|ask|question|talk|speak|leave|call me|let|side effect|dizzy|nause\w*|problem)\b/.test(t)) return "message_provider";
  if (/\b(message|call me|call back|callback|front desk|staff|office|billing|bill|cancel|question|leave|paperwork|form|records|l and i|l&i|claim)\b/.test(t)) return "message_staff";
  if (/\b(person|human|someone|representative|operator|receptionist|real person|agent)\b/.test(t)) return "human";
  if (/\b(last|previous|past|most recent|did (i|he|she|they) (go|attend|show)|attended)\b/.test(t)) return "last_appt";
  if (/\b(next|upcoming|coming up|when is|when's|scheduled|appointment|appt|when do i)\b/.test(t)) return "next_appt";
  return "unknown";
}

// Kept for the Malik portal's copy and older callers: ask Azure OpenAI for
// one intent word. Lemonade 1.8.0 passes its own provider-neutral classifier
// in deps.classify instead.
export async function classifyWithAzure(text, { env = process.env, fetchImpl = fetch, kind = "patient", timeoutMs = 4000 } = {}) {
  const endpoint = String(env.AZURE_OPENAI_ENDPOINT || "").replace(/\/+$/, "");
  const deployment = env.AZURE_OPENAI_DEPLOYMENT;
  const apiKey = env.AZURE_OPENAI_API_KEY;
  if (!endpoint || !deployment || !apiKey || !String(text || "").trim()) return null;
  const base = endpoint.replace(/\/openai\/v1\/?$/, "");
  const url = `${base}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=2024-08-01-preview`;
  const ctl = typeof AbortController === "function" ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "system", content: intentPrompt(kind) }, { role: "user", content: String(text).slice(0, 600) }], temperature: 0, max_tokens: 20, response_format: { type: "json_object" } }),
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

export function intentPrompt(kind = "patient") {
  return [
    "You route phone calls for a behavioral-health practice's automated phone assistant.",
    `The caller is ${kind === "patient" ? "a patient (or someone calling about themselves)" : kind === "party" ? "an authorized outside office (for example an attorney, L&I claim manager or employer) calling about a client" : "not yet identified"}.`,
    `Reply with JSON only: {"intent": one of ${JSON.stringify(INTENTS)}}.`,
    "next_appt = when is the next/upcoming appointment. last_appt = when was the last appointment or whether they attended.",
    "case_status = status of a report, evaluation or records review. reschedule = move or change an appointment.",
    "refill = medication refill or running out of medication. message_provider = a question or message for the doctor/provider (symptoms, side effects).",
    "message_staff = a message for the office (billing, cancelling, paperwork, forms, records, L&I, call back, general questions).",
    "hours, location, fax, new_patients = general practice information.",
    "human = asks for a real person. repeat = hear it again. goodbye = done. yes / no = a bare yes or no. unknown = anything else.",
    "Never answer the caller yourself.",
  ].join(" ");
}

// ---- wording helpers ----------------------------------------------------------
export function spellDigitsHint() {
  return "as eight digits: two for the month, two for the day, and four for the year";
}
const whoseFor = (st) => (st.k === "patient" ? "your" : `${st.sn || "your client"}'s`);
function menuLine(st) {
  if (!st.ok) return "I can tell you our hours, address or fax number, or take a message for the office.";
  const parts = [`You can ask about ${whoseFor(st)} next or last appointment`];
  if (st.k === "patient") parts.push("ask to reschedule, request a refill");
  if (st.cs) parts.push("ask for the report status");
  parts.push(`or leave a message for ${st.k === "patient" ? "your provider or the office" : "the provider or the office"}`);
  return `${parts.join(", ")}.`;
}
function apptSentence(st, which, appt) {
  const who = st.k === "patient" ? "Your" : `${st.sn || "Your client"}'s`;
  const them = st.k === "patient" ? "you" : st.sn || "your client";
  if (!appt) {
    return which === "next"
      ? `I don't see an upcoming appointment on file for ${them}. I can take a message for the office if you'd like to schedule one.`
      : `I don't see a past appointment on file for ${them}.`;
  }
  const withWho = appt.provider ? ` with ${appt.provider}` : "";
  const how = appt.how ? `, ${appt.how}` : "";
  if (which === "next") return `${who} next appointment is ${appt.when}${withWho}${how}.`;
  const status = /no.?show/i.test(appt.status || "") ? " It was marked as missed." : /complete|attended|seen/i.test(appt.status || "") ? " It was completed." : "";
  return `${who} last appointment was ${appt.when}${withWho}.${status}`;
}
const ANYTHING_ELSE = "Is there anything else I can help with?";
const say = (state, text, action = "listen", extra = {}) => ({ state, say: text, action, ...extra });
const done = (st, text) => say({ ...st, s: "end" }, text, "hangup");

// ---- the conversation -----------------------------------------------------------
// Returns { state, say, action, digits?, to? } where action is:
//   "gather"   speak `say`, then collect `digits` keypad digits (ends with #)
//   "listen"   speak `say` (if any), then listen for speech or a key
//   "transfer" speak `say`, then connect the caller to `to`
//   "hangup"   speak `say`, then hang up
export async function startConversation({ from }, deps) {
  const state = { v: 2, s: "start", f: String(from || ""), t: 0, u: 0, n: 0, d: [] };
  const name = deps.practiceName;
  if (deps.enabled && !(await deps.enabled())) {
    return done(state, `Thank you for calling ${name}. Our automated phone assistant isn't available right now. Please call back during office hours. If this is an emergency, hang up and dial 9 1 1. Goodbye.`);
  }
  // Who might this be? Nothing about it is said out loud until verified.
  const caller = await deps.lookupCaller(state.f).catch(() => null);
  const st = { ...state, s: "menu", k: caller ? caller.kind : "unknown", cid: caller?.id || "", vd: caller?.verifyDigits || 8, vp: caller?.verifyPrompt || "", cs: Boolean(deps.caseStatus), ok: false };
  if (!caller) st.d.push("not-on-file");
  return say(st, `Thanks for calling ${name}. I'm Lemonade, the practice's automated assistant. This call may be recorded and securely transcribed so I can help with your request. If this is an emergency, please hang up and dial 9 1 1. What can I help you with today?`);
}

async function askToVerify(st, pendingIntent) {
  if (st.k === "unknown") {
    st.d.push("phi-refused");
    return say({ ...st, s: "menu" }, `I can help with that for patients calling from the phone number we have on file, and for offices we've approved. I'm not able to look anything up on this call, but I can take a message for the office and someone will call you back. Would you like to leave a message? You can also say "hours", "address" or "fax number".`);
  }
  const what = st.k === "patient" ? `your date of birth ${spellDigitsHint()}` : st.vp || `your client's date of birth ${spellDigitsHint()}`;
  return say({ ...st, s: "verify", pi: pendingIntent, t: 0 }, `I can help with that. First, to protect privacy, please enter ${what} on your keypad, then press pound.`, "gather", { digits: st.vd || 8 });
}

function startMessage(st, target, lead = "") {
  const to = target === "provider" ? (st.k === "patient" ? "your provider" : "the provider") : "the office";
  st.s = "message";
  st.mt = target;
  st.m = "";
  const prompt = st.mr
    ? "Please tell me the name of the medication, the pharmacy you use, and about how many days of medication you have left."
    : `Please say your message for ${to} now${st.ok ? "" : ", including your name and the best number to reach you"}.`;
  return say(st, `${lead}${prompt} When you're finished, press pound, or say "that's all".`);
}

async function offerHuman(st, deps, lead) {
  if (deps.transferNumber) {
    st.d.push("transferred");
    return say({ ...st, s: "end" }, `${lead}Let me connect you with the office.`, "transfer", { to: deps.transferNumber });
  }
  st.mr = false;
  return startMessage(st, "staff", `${lead}I'm not able to connect you to a person right now, but I can take a message and someone will call you back. `);
}

async function runIntent(st, intent, deps) {
  st.u = 0;
  if (intent === "next_appt" || intent === "last_appt") {
    const which = intent === "next_appt" ? "next" : "last";
    const appts = await deps.appointments(st).catch(() => null);
    if (!appts) return say(st, `Sorry, I couldn't look up appointments just now. I can take a message for the office instead. ${ANYTHING_ELSE}`);
    st.d.push(`${which}-appt`);
    return say(st, `${apptSentence(st, which, appts[which])} ${ANYTHING_ELSE}`);
  }
  if (intent === "case_status") {
    const line = deps.caseStatus ? await deps.caseStatus(st).catch(() => null) : null;
    st.d.push("case-status");
    return say(st, `${line || "I couldn't find a report status on file. I can take a message for the office."} ${ANYTHING_ELSE}`);
  }
  if (intent === "reschedule") {
    if (st.k !== "patient" || !deps.offerSlots) return startMessage(st, "staff", "I'll pass a rescheduling request to the office. ");
    const offer = await deps.offerSlots(st).catch(() => null);
    if (!offer?.slots?.length) return startMessage(st, "staff", "I don't see open times I can offer right now, so I'll pass your request to the office. ");
    st.s = "resched";
    st.os = offer.slots.slice(0, 2).map((s) => ({ l: s.label, k: s.key }));
    const options = st.os.map((s) => s.l).join(", or ");
    return say(st, `Of course. I have ${options}. Which works better? You can also say "neither".`);
  }
  if (intent === "refill") {
    st.mr = true;
    return startMessage(st, "provider", "I can send a refill request to the prescribing team. ");
  }
  if (intent === "message_provider" || intent === "message_staff") {
    st.mr = false;
    return startMessage(st, intent === "message_provider" ? "provider" : "staff");
  }
  return say(st, `${menuLine(st)} What can I help you with?`);
}

function pickSlot(st, input) {
  const t = String(input?.speech || input?.key || "").toLowerCase();
  if (/\b(neither|none|no|other|different)\b/.test(t)) return "none";
  // "Second" first: "the second one" also contains "one".
  if (/^2$|\b(second|two|2nd|later|the other|last one)\b/.test(t)) return st.os[1] || null;
  if (/^1$|\b(first|one|1st|earlier)\b/.test(t)) return st.os[0];
  return st.os.find((s) => s.l.toLowerCase().split(/[ ,]+/).filter((w) => w.length > 3).some((w) => t.includes(w))) || null;
}

export async function continueConversation(state, input, deps) {
  const st = { ...state, d: [...(state.d || [])], n: (state.n || 0) + 1 };
  if (st.n > MAX_TURNS) return done(st, "We've reached the end of what I can help with on this call. Thank you for calling. Goodbye.");
  const speech = String(input?.speech || "").trim();
  const key = String(input?.key || "");

  // ---- safety comes first, in every state ----
  if (speech && THREAT.test(speech) && st.s !== "crisis_loc") {
    st.d.push("threat");
    if (deps.flagUrgent) await deps.flagUrgent({ state: st, text: speech, kind: "threat" }).catch(() => null);
    if (deps.transferNumber) return say({ ...st, s: "end" }, "I'm getting someone from our clinical team on the line right now. Please stay on the line.", "transfer", { to: deps.transferNumber });
    return say({ ...st, s: "menu" }, `I've sent what you said to our clinical team right away, and someone will follow up. If anyone is in danger right now, please hang up and call 9 1 1. ${ANYTHING_ELSE}`);
  }
  if (speech && CRISIS.test(speech) && !["crisis_q", "crisis_loc"].includes(st.s)) {
    st.d.push("crisis");
    if (deps.flagUrgent) await deps.flagUrgent({ state: st, text: speech, kind: "crisis" }).catch(() => null);
    return say({ ...st, s: "crisis_q" }, "I'm glad you told me. I want to make sure you get the right help. Are you in immediate danger of hurting yourself right now?");
  }
  if (st.s === "crisis_q") {
    const yes = /\b(yes|yeah|yep|i am|maybe|i think so|right now)\b/i.test(speech) || key === "1";
    if (yes) {
      st.d.push("imminent");
      return say({ ...st, s: "crisis_loc" }, "I'm going to focus on keeping you safe. If you can, call 9 1 1 now. Where are you right now?");
    }
    const urgent = deps.transferNumber ? " I can also connect you to our clinical team right now. Would you like that?" : "";
    return say({ ...st, s: urgent ? "crisis_offer" : "menu" }, `Thank you for telling me. You can call or text 9 8 8, the Suicide and Crisis Lifeline, any time, day or night. I've let our care team know you called so someone can follow up.${urgent || ` ${ANYTHING_ELSE}`}`);
  }
  if (st.s === "crisis_loc") {
    if (deps.flagUrgent) await deps.flagUrgent({ state: st, text: speech || "(no location given)", kind: "location" }).catch(() => null);
    if (deps.transferNumber) return say({ ...st, s: "end" }, "Thank you. I'm connecting you to our clinical team now. If the call drops, please call 9 1 1.", "transfer", { to: deps.transferNumber });
    return done(st, "Thank you. I've alerted our care team with what you told me. Please call 9 1 1 now, or call or text 9 8 8. You don't have to go through this alone.");
  }
  if (st.s === "crisis_offer") {
    if (/\b(yes|yeah|please|ok|okay|sure)\b/i.test(speech) || key === "1") return say({ ...st, s: "end" }, "Connecting you now.", "transfer", { to: deps.transferNumber });
    return say({ ...st, s: "menu" }, ANYTHING_ELSE);
  }

  // ---- verification ----
  if (st.s === "verify") {
    const digits = String(input?.digits || "").replace(/\D/g, "");
    const result = digits ? await deps.verify(st, digits).catch(() => null) : null;
    if (!result?.ok) {
      st.t = (st.t || 0) + 1;
      if (st.t >= MAX_TRIES) {
        st.d.push("verify-failed");
        st.s = "menu";
        return offerHuman(st, deps, "Sorry, I wasn't able to verify that, so I can't share details on this call. ");
      }
      return say(st, "Sorry, that didn't match our records. Please try once more, then press pound.", "gather", { digits: st.vd || 8 });
    }
    st.ok = true;
    st.s = "menu";
    st.t = 0;
    st.sid = result.subjectId;
    st.sn = result.subjectFirstName || "";
    st.d.push("verified");
    const pending = st.pi;
    delete st.pi;
    const thanks = st.k === "patient" ? "Thank you, you're verified." : `Thank you. I found ${st.sn ? `${st.sn}'s record` : "the record"}.`;
    if (pending) {
      const out = await runIntent(st, pending, deps);
      return { ...out, say: `${thanks} ${out.say}` };
    }
    return say(st, `${thanks} ${menuLine(st)} What can I help you with?`);
  }

  // ---- taking a message ----
  if (st.s === "message") {
    let text = speech;
    let finish = key === "#";
    if (text && END_MESSAGE.test(text)) {
      finish = true;
      text = text.replace(END_MESSAGE, "").trim();
    }
    if (text) st.m = `${st.m ? `${st.m} ` : ""}${text}`.slice(0, MAX_MESSAGE);
    if (!finish && (st.m || "").length < MAX_MESSAGE) return say(st, "", "listen");
    const message = String(st.m || "").trim();
    const target = st.mt;
    const refill = Boolean(st.mr);
    delete st.m; delete st.mt; delete st.mr;
    st.s = "menu";
    if (!message) return say(st, `I didn't catch a message. ${ANYTHING_ELSE}`);
    const sent = await deps.leaveMessage({ state: st, target, text: message, refill, verified: Boolean(st.ok) }).catch(() => null);
    if (!sent?.ok) return say(st, `Sorry, I couldn't save your message just now. Please call the office during business hours. ${ANYTHING_ELSE}`);
    st.d.push(refill ? "refill-request" : `message-${target}`);
    const outcome = refill
      ? `Thank you. I've sent the refill request to ${sent.to || "the prescribing team"}. They'll review it and the office will let you know.`
      : `Thank you. Your message has been sent to ${sent.to || (target === "provider" ? "the provider" : "the office")}, and someone will follow up with you.`;
    return say(st, `${outcome} ${ANYTHING_ELSE}`);
  }

  // ---- choosing a new time ----
  if (st.s === "resched") {
    const pick = pickSlot(st, input);
    if (pick === "none") {
      delete st.os;
      return startMessage(st, "staff", "No problem. I'll pass your request to the office so they can find a time that works. ");
    }
    if (!pick) {
      st.t = (st.t || 0) + 1;
      if (st.t >= MAX_TRIES) { delete st.os; st.t = 0; return startMessage(st, "staff", "I'll pass your request to the office instead. "); }
      return say(st, `Sorry, which one? ${st.os.map((s, i) => `Say ${i === 0 ? "first" : "second"} for ${s.l}`).join(", or ")}.`);
    }
    const sent = await deps.requestReschedule({ state: st, slot: { label: pick.l, key: pick.k } }).catch(() => null);
    delete st.os;
    st.s = "menu";
    st.t = 0;
    if (!sent?.ok) return say(st, `Sorry, I couldn't send that just now. Please call the office during business hours. ${ANYTHING_ELSE}`);
    st.d.push("reschedule-request");
    return say(st, `Thank you. I've asked the office to move your appointment to ${pick.l}. They'll confirm it with you by text. ${ANYTHING_ELSE}`);
  }

  if (st.s !== "menu") return done(st, "Goodbye.");

  // ---- the menu: what does the caller want? ----
  let intent = KEY_INTENTS[key] || null;
  if (!intent && speech) intent = (deps.classify ? await deps.classify(speech, st).catch(() => null) : null) || classifyByKeywords(speech);
  if (!intent) intent = "unknown";
  if (intent === "case_status" && !deps.caseStatus) intent = "message_staff";

  if (intent === "goodbye" || intent === "no") return done(st, `Thank you for calling ${deps.practiceName}. Goodbye.`);
  if (intent === "repeat") return say(st, `${menuLine(st)} What can I help you with?`);
  if (intent === "yes") {
    // "Would you like to leave a message?" -> yes
    if (!st.ok) return startMessage(st, "staff");
    return say(st, "What can I help you with?");
  }
  if (PUBLIC_INTENTS.has(intent)) {
    st.u = 0;
    const info = deps.publicInfo || {};
    const answer = {
      hours: info.hours ? `Our office hours are ${info.hours}.` : "",
      location: info.address ? `We're located at ${info.address}.` : "",
      fax: info.fax ? `Our fax number is ${info.fax}.` : "",
      new_patients: info.newPatients || "",
    }[intent];
    st.d.push(`info-${intent}`);
    return say(st, `${answer || "I don't have that information in front of me, but I can take a message and the office will call you back."} ${ANYTHING_ELSE}`);
  }
  if (intent === "human") return offerHuman(st, deps, "");
  if (intent === "message_staff") { st.mr = false; return startMessage(st, "staff"); }
  if (PHI_INTENTS.has(intent)) {
    if (!st.ok) return askToVerify(st, intent);
    return runIntent(st, intent, deps);
  }

  st.u = (st.u || 0) + 1;
  if (st.u >= MAX_TRIES) {
    st.u = 0;
    return offerHuman(st, deps, "I'm having trouble understanding, and I don't want to waste your time. ");
  }
  return say(st, `Sorry, I didn't catch that. ${menuLine(st)}`);
}

// One line for the call log: what happened (no chart data).
export function callOutcome(state) {
  const did = new Set(state?.d || []);
  const bits = [];
  const add = (k, text) => { if (did.has(k)) bits.push(text); };
  add("not-on-file", "number not on file or allowed list");
  add("phi-refused", "asked for patient details -- not shared (unverified)");
  add("verify-failed", "could not verify -- nothing shared");
  add("verified", "verified");
  add("next-appt", "heard next appointment");
  add("last-appt", "heard last appointment");
  add("case-status", "heard report status");
  for (const k of ["hours", "location", "fax", "new_patients"]) add(`info-${k}`, `asked for ${k.replace("_", " ")}`);
  add("reschedule-request", "asked to reschedule (sent to staff)");
  add("refill-request", "requested a refill (sent to the prescribing team)");
  add("message-provider", "left a message for the provider");
  add("message-staff", "left a message for the office");
  add("crisis", "crisis words -- given 911/988 and staff alerted");
  add("imminent", "said they were in immediate danger");
  add("threat", "threat toward another person -- staff alerted");
  add("transferred", "transferred to the office");
  return bits.join("; ") || "hung up before anything happened";
}

// ---- compact state for Telnyx client_state --------------------------------------
export const encodeVoiceState = (state) => Buffer.from(JSON.stringify(state)).toString("base64");
export const decodeVoiceState = (s) => {
  try {
    const o = JSON.parse(Buffer.from(String(s || ""), "base64").toString("utf8"));
    return o && typeof o === "object" && (o.v === 1 || o.v === 2) ? o : null;
  } catch {
    return null;
  }
};
