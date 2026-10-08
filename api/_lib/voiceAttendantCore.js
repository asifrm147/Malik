// Phone assistant ("voice attendant") -- the conversation itself. SHARED with
// Lemonade (src/server-lib/voiceAttendantCore.js, 1.8.6): keep the two
// copies identical; practice-specific data comes in through deps
// (api/_lib/voiceMalik.js here).
// Pilot in
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
// No imports and no Knack/Telnyx code: everything that touches practice data
// comes in as `deps`, so the same conversation runs on a real call
// (api/voice-webhook.js), in the "Try it" simulator, and in tests. State is
// small and plain because it rides along on the phone call.
//
// 1.8.2 (the practice's crisis-response requirements and operational
// training layer):
//   - Crisis: engage, don't go cold. Short, calm sentences; the clinic's
//     crisis-response staff are alerted (a banner in Lemonade) in parallel
//     with emergency guidance -- never "wait for a callback" when danger
//     looks immediate. After hours: 911 / emergency department for immediate
//     danger, 988 otherwise; the alert still goes out. The caller can ask for
//     a person at any time, and the assistant stays on the line otherwise.
//   - Spanish: press 8 (or say "español") and the whole call is in Spanish.
//   - More reasons for calling are understood (cancel, running late,
//     paperwork, records, billing, L&I, pharmacy). Anything that changes the
//     schedule is a REQUEST staff carry out -- the assistant confirms first
//     ("Just to confirm...") and never says it's done when it isn't.
//   - "Don't cancel Tuesday" never cancels. Mass cancellations are refused.
//   - Several requests in one breath are remembered and offered in turn; the
//     goodbye sums up what was done.
//   - Information safety: repeated failed birth dates or repeated requests
//     for patient details without verification are reported to staff.

//
// 1.8.6 (the practice's "Phone Attendant Fix Directive"): the pipeline is
//   GLOBAL COMMANDS -> SAFETY/CRISIS -> LANGUAGE -> CALLER -> VERIFICATION
//   -> INTENT -> ACTION -> CONFIRMATION -> DOCUMENTATION
// - Global commands work anywhere: English / Spanish / "switch languages",
//   "what languages do you speak?", repeat, slower, start over, never mind,
//   help / what can you do, "are you a person?", and a person (operator,
//   representative, office, talk to someone). Unsupported languages get an
//   honest answer.
// - Scheduling is understood ("Can you schedule an appointment?").
// - Never give up after two misses: guess the likely topic, then ask a
//   targeted question, then offer own-words / representative / a message.
// - "I understand, but I can't share that" is not "I didn't understand".
// - State keeps the last thing said (repeat), clarification attempts, the
//   last intent and how it was understood (for the simulator).

export const INTENTS = [
  "next_appt", "last_appt", "case_status", "schedule", "reschedule", "cancel", "refill", "message_provider", "message_staff", "clinical_info",
  "running_late", "paperwork", "records", "billing", "lni", "pharmacy",
  "hours", "location", "fax", "new_patients",
  "human", "repeat", "goodbye", "yes", "no", "unknown",
];
const PHI_INTENTS = new Set(["next_appt", "last_appt", "case_status", "schedule", "reschedule", "cancel", "refill", "message_provider"]);
const PUBLIC_INTENTS = new Set(["hours", "location", "fax", "new_patients"]);
// Messages for the office, with the reason in the task title.
const STAFF_TOPICS = {
  message_staff: { en: "", es: "" },
  running_late: { en: "Running late", es: "Va a llegar tarde" },
  paperwork: { en: "Paperwork / forms", es: "Formularios" },
  records: { en: "Records request", es: "Solicitud de expedientes" },
  billing: { en: "Billing question", es: "Pregunta de facturación" },
  lni: { en: "L&I question", es: "Pregunta sobre L&I" },
  pharmacy: { en: "Pharmacy change", es: "Cambio de farmacia" },
};
const TOPIC_LABEL = {
  next_appt: "your next appointment", last_appt: "your last appointment", case_status: "the report status", schedule: "a new appointment", reschedule: "rescheduling", clinical_info: "information from your chart",
  cancel: "cancelling", refill: "your refill", message_provider: "a message for your provider", message_staff: "a message for the office",
  running_late: "running late", paperwork: "your paperwork", records: "records", billing: "billing", lni: "your L&I question", pharmacy: "your pharmacy",
  hours: "our hours", location: "our address", fax: "our fax number", new_patients: "new patients",
};
const TOPIC_LABEL_ES = {
  next_appt: "su próxima cita", last_appt: "su última cita", case_status: "el estado del informe", schedule: "una cita nueva", reschedule: "cambiar su cita", clinical_info: "información de su expediente",
  cancel: "cancelar su cita", refill: "su receta", message_provider: "un mensaje para su proveedor", message_staff: "un mensaje para la oficina",
  running_late: "que va a llegar tarde", paperwork: "sus formularios", records: "expedientes", billing: "facturación", lni: "su pregunta de L&I", pharmacy: "su farmacia",
  hours: "nuestro horario", location: "nuestra dirección", fax: "nuestro número de fax", new_patients: "pacientes nuevos",
};

const MAX_TRIES = 2;
const MAX_TURNS = 40;
const MAX_MESSAGE = 800;

export const CRISIS = /\b(suicid\w*|kill (my|him|her|them)sel(f|ves)|end (it all|my life)|want to die|wish i (was|were) dead|wish i wouldn'?t wake up|don'?t want to (live|be alive|be here)|can'?t (take|do) (this|it) any ?more|overdos\w*|took (all|a bunch of) (my|the) (pills|meds)|hurt(ing)? (my|him|her)self|self[- ]harm|cut(ting)? myself|quiero morir(me)?|me quiero matar|matarme|quitarme la vida|no quiero vivir|hacerme da[nñ]o|sobredosis)\b/i;
export const THREAT = /\b(going to|gonna|want to|will|i'?ll|about to)\s+(kill|shoot|stab|hurt|attack|beat up|strangle)\s+(my\s+(boss|supervisor|wife|husband|ex|partner|neighbor|coworker|co-worker|manager|dad|mom|father|mother|brother|sister|son|daughter|kid|kids|family)|him|her|them|someone|somebody|everyone|everybody|people|you|[a-z]+ at work)\b|(?<!\bme )\b(voy a|quiero|lo voy a|la voy a)\s+(matar(l[aeo]s?)?|lastimar(l[aeo]s?)?|disparar(l[aeo]s?)?)\s+(a\s+(mi|alguien|todos|[a-záéíóúñ]+)|él|ella)\b|\b(voy a|quiero)\s+(matarl[aeo]s?|lastimarl[aeo]s?|dispararl[aeo]s?)\b/i;
const END_MESSAGE = /\b(that'?s (all|it)|end (of )?(the )?message|i'?m (done|finished)|done|finished|eso es todo|es todo|termin[eé])\W*$/i;
// "Don't cancel Tuesday" must never cancel (regression case, directive 52).
export const NEGATED_CANCEL = /\b(don'?t|do not|never|not|no)\s+(want to\s+|need to\s+|go(ing)? to\s+)?(cancel|take me off)\b|\bno\s+(quiero\s+)?cancel/i;
const MASS_CANCEL_ALL_MINE = /\bcancel\s+(all|every one of|each of)\s+(my|of my)\b/i;
const MASS_CANCEL_OTHERS = /\bcancel\s+(everybody|everyone|all (the )?(patients|appointments)( for| on)?|the whole (day|schedule))\b/i;
const CANT_MAKE_IT = /\b(can'?t|cannot|won'?t|ain'?t (gonna|going to)) (make|come|be there|come in)\b|\bsomething came up\b|\bno (puedo|voy a poder) (ir|llegar)\b/i;
const SPANISH = /\b(espa[nñ]ol|spanish|hola|necesito|quiero|cita|por favor|ayuda|hablar)\b/i;
const KEY_INTENTS = { 1: "next_appt", 2: "last_appt", 3: "message_provider", 4: "message_staff", 5: "case_status", 6: "reschedule", 9: "repeat", 0: "human" };

// Keyword rules, in priority order. Used when no AI provider answers, and to
// spot the extra requests in one sentence.
const RULES = [
  ["fax", /\b(fax number|fax)\b/],
  ["human", /\b(representative|operator|receptionist|real person|human|robot|talk to (a |an )?(person|someone|somebody|staff|front desk)|speak (to|with) (a |an )?(person|someone|somebody|staff|front desk)|front desk please|una persona|recepcionista|hablar con alguien)\b/],
  ["hours", /\b(hours|open|close|closing|what time do you|horario|a qu[eé] hora)\b/],
  ["location", /\b(address|located|location|where are you|directions|parking|direcci[oó]n|d[oó]nde est[aá]n)\b/],
  ["new_patients", /\b(new patients?|accepting|take my insurance|become a patient|first appointment|intake|paciente nuevo)\b/],
  ["running_late", /\b(running late|be late|i'?m late|gonna be late|going to be late|stuck in traffic|llegar tarde|voy tarde)\b/],
  ["pharmacy", /\b(change (my )?pharmac\w*|new pharmac\w*|different pharmac\w*|switch pharmac\w*|cambiar (de )?farmacia)\b/],
  // 1.8.6: never answered by phone -- understood, then politely declined.
  ["clinical_info", /\b(diagnos\w*|what (medications?|meds) (am i|is (he|she)|are (they|we)|does (he|she)) (on|taking)|test results?|lab results?|what did (the )?(doctor|dr\.?|provider) (write|say about)|what('?s| is) in (my|his|her) (chart|file|records?)|(his|her|my) (chart|records?) says?)\b/],
  ["refill", /\b(refill\w*|out of (my )?(meds|medication|medicine|pills)|ran out|almost out|prescription|pharmacy|receta|medicamento|medicina)\b/],
  ["cancel", /\b(cancel\w*|take me off the schedule|cancelar)\b/],
  ["cancel_day", /\bcancel (today|tomorrow|monday|tuesday|wednesday|thursday|friday)\b/],
  ["reschedule", /\b(reschedule|move my appointment|move me|move it|change my appointment|different time|different day|another time|push (it|my appointment) (back|out)|bump it|cambiar (mi |la )?cita|otro d[ií]a|otra hora|reprogramar)\b/],
  // 1.8.6: a NEW appointment (after cancel / reschedule, before next_appt).
  ["schedule", /\b(schedul(e|ing) (an |a |my )?(new |follow[- ]?up )?(appointment|appt|visit)|make (an |a )?(new )?(appointment|appt)|book (an |a )?(appointment|appt|visit)|set up (an |a )?(appointment|appt|visit)|need (an |a )?(new )?(appointment|appt)|need to (see|come in)|want to (see|come in)|(i|we) need to be seen|see (the |a )?(doctor|dr\.?|provider|psychiatrist|therapist)|can i see (dr\.?|doctor)?|(next|any|soonest|earliest) (opening|availability|available)|(anything|something) (available|open)|do you have anything|get (me )?in (sooner|soon|this week|next week)|come in (this|next)|sacar (una )?cita|hacer (una )?cita|necesito (una )?cita|quiero (una )?cita|programar (una )?cita)\b/],
  ["case_status", /\b(report status|case status|status of (the |my )?(case|report)|evaluation status|records review|where is (the|my) (case|report)|report (isn'?t|is not) done)\b/],
  ["records", /\b(records|medical records|chart notes|copy of my (chart|notes|file)|expediente)\b/],
  ["billing", /\b(bill|billing|invoice|statement|payment|copay|balance|insurance|factura|pago|seguro)\b/],
  ["paperwork", /\b(paperwork|form|forms|fmla|disability form|employer needs|formulario|papeles)\b/],
  ["lni", /\b(l and i|l&i|lni|labor and industries|claim manager|claim number|vocational|work restrictions|job analysis|ime|time loss|workers'? comp)\b/],
];

// Accents off ("sí" -> "si") so \b works on Spanish words.
const fold = (text) => String(text || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");

// Keyword fallback for when no AI provider answers.
export function classifyByKeywords(text) {
  const t = ` ${fold(text).toLowerCase().replace(/[^a-z0-9'&ñáéíóú ]+/g, " ").replace(/\s+/g, " ")} `;
  if (/^ (no|nope|no thanks|no thank you|nothing|nah|neither|none|no gracias|nada) $/.test(t)) return "no";
  if (/^ (yes|yeah|yep|sure|ok|okay|yes please|correct|right|s[ií]|claro|correcto|por favor) $/.test(t)) return "yes";
  if (/\b(bye|goodbye|that's all|that is all|nothing else|hang up|no thank you|no thanks|adi[oó]s|eso es todo)\b/.test(t)) return "goodbye";
  if (/\b(repeat|say that again|again please|didn't hear|did not hear|come again|repita|otra vez)\b/.test(t)) return "repeat";
  for (const [intent, re] of RULES) {
    if ((intent === "cancel" || intent === "cancel_day") && NEGATED_CANCEL.test(t)) continue;
    if (re.test(t)) {
      if (intent === "refill" && /\b(side effect|dizzy|nause\w*|rash|reaction)\b/.test(t)) return "message_provider";
      if (intent === "paperwork" && /\b(l and i|l&i|lni|claim)\b/.test(t)) return "message_staff";
      return intent;
    }
  }
  if (/\b(doctor|dr|provider|therapist|counselor|prescriber|psychiatrist|nurse|pa|np|side effect|dizzy|nause\w*|medication|m[eé]dico|doctora?)\b/.test(t) && /\b(message|tell|ask|question|talk|speak|leave|call me|let|side effect|dizzy|nause\w*|problem|mensaje|pregunta)\b/.test(t)) return "message_provider";
  if (/\b(message|call me|call back|callback|staff|office|question|leave|mensaje|oficina|pregunta)\b/.test(t)) return "message_staff";
  if (/\b(person|someone|agent)\b/.test(t)) return "human";
  if (/\b(last|previous|past|most recent|did (i|he|she|they) (go|attend|show)|attended|[uú]ltima cita)\b/.test(t)) return "last_appt";
  if (/\b(next|upcoming|coming up|when is|when's|scheduled|appointment|appt|when do i|when am i|forgot when|what time am i|pr[oó]xima|cita)\b/.test(t)) return "next_appt";
  return "unknown";
}

// Every request in one sentence, in the order mentioned ("move my
// appointment, I'm almost out of Lexapro, and did you get the paperwork?").
export function classifyAll(text) {
  const t = ` ${fold(text).toLowerCase()} `;
  const found = [];
  for (const [intent, re] of RULES) {
    if ((intent === "cancel" || intent === "cancel_day") && NEGATED_CANCEL.test(t)) continue;
    const m = re.exec(t);
    if (m) found.push([m.index, intent === "cancel_day" ? "cancel" : intent]);
  }
  const ordered = found.sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  // "almost out of my Lexapro" is a refill, not a pharmacy change.
  return [...new Set(ordered)].filter((i) => !(i === "pharmacy" && ordered.includes("refill") && !/change|new|different|switch|cambiar/.test(t)));
}

// Kept for the Malik portal's copy and older callers: ask Azure OpenAI for
// one intent word. Lemonade passes its own provider-neutral classifier in
// deps.classify instead.
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
    "You route phone calls for a behavioral-health practice's automated phone assistant. The caller may speak English or Spanish.",
    `The caller is ${kind === "patient" ? "a patient (or someone calling about themselves)" : kind === "party" ? "an authorized outside office (for example an attorney, L&I claim manager or employer) calling about a client" : "not yet identified"}.`,
    `Reply with JSON only: {"intent": one of ${JSON.stringify(INTENTS)}}.`,
    "next_appt = when is the next/upcoming appointment (also 'I forgot when I'm coming in'). last_appt = when was the last appointment or whether they attended.",
    "case_status = status of a report, evaluation or records review. schedule = a NEW appointment ('can you schedule an appointment', 'I need to see the doctor', 'any openings Monday'). reschedule = move or change an existing appointment ('push it out', 'something came up Thursday').",
    "clinical_info = asks for a diagnosis, medication list, test results or what the chart says (it is never given by phone).",
    "cancel = cancel an appointment. NEVER cancel when the caller says not to ('don't cancel Tuesday' is not cancel).",
    "refill = medication refill or running out of medication. message_provider = a question or message for the doctor/provider (symptoms, side effects).",
    "running_late = they will be late today. paperwork = forms (employer, disability, FMLA). records = copies of records. billing = bills, payments, insurance. lni = Washington L&I / workers' comp claim questions. pharmacy = change of pharmacy.",
    "message_staff = any other message for the office or a call back.",
    "hours, location, fax, new_patients = general practice information.",
    "human = asks for a real person, representative, front desk, or says they don't want a robot. repeat = hear it again. goodbye = done. yes / no = a bare yes or no. unknown = anything else.",
    "Never answer the caller yourself.",
  ].join(" ");
}

// ---- wording helpers ----------------------------------------------------------
const L = (st, en, es) => (st.lg === "es" ? es : en);
export function spellDigitsHint(st = {}) {
  return L(st, "as eight digits: two for the month, two for the day, and four for the year", "con ocho dígitos: dos para el mes, dos para el día y cuatro para el año");
}
const whoseFor = (st) => (st.k === "patient" ? L(st, "your", "su") : L(st, `${st.sn || "your client"}'s`, `de ${st.sn || "su cliente"}`));
function menuLine(st) {
  if (!st.ok) return L(st, "I can tell you our hours, address or fax number, or take a message for the office.", "Puedo darle nuestro horario, dirección o número de fax, o tomar un mensaje para la oficina.");
  if (st.lg === "es") {
    const parts = [st.k === "patient" ? "Puede preguntar por su próxima o última cita" : `Puede preguntar por la próxima o última cita ${whoseFor(st)}`];
    if (st.k === "patient") parts.push("pedir un cambio de cita, una receta");
    if (st.cs) parts.push("preguntar por el estado del informe");
    parts.push("o dejar un mensaje para su proveedor o la oficina");
    return `${parts.join(", ")}.`;
  }
  const parts = [`You can ask about ${whoseFor(st)} next or last appointment`];
  if (st.k === "patient") parts.push("ask to reschedule or cancel, request a refill");
  if (st.cs) parts.push("ask for the report status");
  parts.push(`or leave a message for ${st.k === "patient" ? "your provider or the office" : "the provider or the office"}`);
  return `${parts.join(", ")}.`;
}
function apptSentence(st, which, appt) {
  if (st.lg === "es") {
    const them = st.k === "patient" ? "usted" : st.sn || "su cliente";
    if (!appt) return which === "next" ? `No veo una próxima cita para ${them}. Puedo tomar un mensaje para la oficina si quiere programar una.` : `No veo una cita anterior para ${them}.`;
    const withWho = appt.provider ? ` con ${appt.provider}` : "";
    if (which === "next") return `La próxima cita ${st.k === "patient" ? "suya" : `de ${them}`} es ${appt.when}${withWho}.`;
    const status = /no.?show/i.test(appt.status || "") ? " Se marcó como no asistida." : /complete|attended|seen/i.test(appt.status || "") ? " Se completó." : "";
    return `La última cita ${st.k === "patient" ? "suya" : `de ${them}`} fue ${appt.when}${withWho}.${status}`;
  }
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
const anythingElse = (st) => L(st, "Is there anything else I can help with?", "¿Hay algo más en que pueda ayudarle?");
const say = (state, text, action = "listen", extra = {}) => ({ state: text ? { ...state, lt: String(text).slice(0, 300) } : state, say: text, action, ...extra });
const done = (st, text) => say({ ...st, s: "end" }, text, "hangup");
const alertOk = (r) => Boolean(r === true || r?.ok);

// What's still waiting from earlier in the call ("you also mentioned...").
function nextOrAnythingElse(st) {
  const q = (st.q || []).filter((i) => !(st.d || []).includes(`did-${i}`));
  if (q.length) {
    st.pq = q[0];
    st.q = q.slice(1);
    const label = L(st, TOPIC_LABEL[st.pq] || "something else", TOPIC_LABEL_ES[st.pq] || "otra cosa");
    return L(st, `You also mentioned ${label}. Would you like to do that now?`, `También mencionó ${label}. ¿Quiere hacerlo ahora?`);
  }
  delete st.pq;
  return anythingElse(st);
}

// Before goodbye: what this call got done (directive 39/40).
export function callSummary(st) {
  const did = new Set(st.d || []);
  const en = [];
  const es = [];
  const add = (k, a, b) => { if (did.has(k)) { en.push(a); es.push(b); } };
  add("schedule-request", "asked the office to book your new appointment", "pedimos a la oficina que reserve su cita nueva");
  add("reschedule-request", "asked the office to move your appointment", "pedimos a la oficina que cambie su cita");
  add("cancel-request", "sent your cancellation request to the office", "enviamos su solicitud de cancelación a la oficina");
  add("refill-request", "sent your refill request", "enviamos su solicitud de receta");
  add("message-provider", "sent your message to your provider", "enviamos su mensaje a su proveedor");
  add("message-staff", "sent your message to the office", "enviamos su mensaje a la oficina");
  if (!en.length) return "";
  const join = (arr, and) => (arr.length === 1 ? arr[0] : `${arr.slice(0, -1).join(", ")} ${and} ${arr.at(-1)}`);
  return L(st, `Today we ${join(en, "and")}. `, `Hoy ${join(es, "y")}. `);
}
const goodbye = (st, deps) => done(st, `${callSummary(st)}${L(st, `Thank you for calling ${deps.practiceName}. Goodbye.`, `Gracias por llamar a ${deps.practiceName}. Adiós.`)}`);

// ---- the conversation -----------------------------------------------------------
// Returns { state, say, action, digits?, to? } where action is:
//   "gather"   speak `say`, then collect `digits` keypad digits (ends with #)
//   "listen"   speak `say` (if any), then listen for speech or a key
//   "transfer" speak `say`, then connect the caller to `to`
//   "hangup"   speak `say`, then hang up
// The state's `lg` ("en" / "es") is the language to speak and listen in.
export async function startConversation({ from }, deps) {
  const state = { v: 2, s: "start", f: String(from || ""), t: 0, u: 0, n: 0, d: [], lg: "en" };
  const name = deps.practiceName;
  if (deps.enabled && !(await deps.enabled())) {
    return done(state, `Thank you for calling ${name}. Our automated phone assistant isn't available right now. Please call back during office hours. If this is an emergency, hang up and dial 9 1 1. Goodbye.`);
  }
  // Who might this be? Nothing about it is said out loud until verified.
  const caller = await deps.lookupCaller(state.f).catch(() => null);
  const ah = deps.afterHours ? Boolean(await deps.afterHours().catch(() => false)) : false;
  const st = { ...state, s: "menu", k: caller ? caller.kind : "unknown", cid: caller?.id || "", vd: caller?.verifyDigits || 8, vp: caller?.verifyPrompt || "", cs: Boolean(deps.caseStatus), ok: false, ah };
  if (!caller) st.d.push("not-on-file");
  st.t0 = Date.now();
  // 1.8.6: short greeting (crisis detection runs on every sentence instead
  // of a long emergency script), the owner's announcement if there is one.
  const note = deps.announcement?.en ? ` ${deps.announcement.en}` : "";
  return say(st, `Thanks for calling ${name}. I'm Lemonade, the practice's automated assistant. This call may be recorded and securely transcribed.${note} How can I help you? Para español, puede hablarme en español o decir "Spanish".`);
}

// ---- 1.8.6: global commands -------------------------------------------------
export const SUPPORTED_LANGUAGES = { en: "English", es: "Spanish" };
const OTHER_LANGUAGES = /\b(punjabi|hindi|urdu|russian|ukrainian|vietnamese|arabic|chinese|mandarin|cantonese|tagalog|korean|japanese|somali|french|portuguese|german|farsi|persian|amharic|tigrinya|marshallese|romanian|polish)\b/i;
const repromptFor = (st) => ({
  message: L(st, "Please go ahead with your message.", "Por favor diga su mensaje."),
  resched: L(st, `I have ${(st.os || []).map((x) => x.l).join(", or ")}. Which works better?`, `Tengo ${(st.os || []).map((x) => x.l).join(", o ")}. ¿Cuál le conviene?`),
  cancel_confirm: L(st, `Do you want me to send the cancellation for ${st.cw || "that appointment"}? Please say yes or no.`, `¿Quiere que envíe la cancelación del ${st.cw || "esa cita"}? Diga sí o no.`),
  cant_make: L(st, "Would you like to reschedule it, or just cancel it?", "¿Quiere cambiar la cita o solo cancelarla?"),
}[st.s] || L(st, "How can I help?", "¿En qué le puedo ayudar?"));
function capabilities(st) {
  return L(st, "I can help with appointments -- scheduling, changing or cancelling -- refill requests, messages for your provider or the office, paperwork questions, and office hours, address and fax.", "Puedo ayudar con citas -- programar, cambiar o cancelar --, solicitudes de receta, mensajes para su proveedor o la oficina, preguntas sobre formularios y el horario, la dirección y el fax de la oficina.");
}

export async function globalCommand(st, speech, key, deps) {
  const t = String(speech || "").toLowerCase().replace(/[.,!?¿¡]+/g, " ").replace(/\s+/g, " ").trim();
  if (!t) return null;
  const short = t.split(" ").length <= 8;
  // In the middle of a message only an exact command counts (the message
  // itself may well say "I need a person to call me").
  const exact = (re) => (st.s === "message" ? new RegExp(`^(?:${re.source})$`, "i").test(t) : re.test(t));
  // ---- language ----
  if (short && exact(/(?:(?:can|could) you )?(?:please )?(?:switch|change|go back|speak|talk)?\s*(?:to |in )?(?:english|ingl[eé]s)(?: please| por favor)?/)) {
    st.lg = "en"; st.d.push("lang-en"); st.ls = "global";
    return say(st, `Of course. I'll continue in English. ${repromptFor(st)}`);
  }
  if (short && exact(/(?:(?:can|could) you )?(?:please )?(?:switch|change|speak|talk|hablar?)?\s*(?:to |in |en )?(?:spanish|espa[nñ]ol)(?: please| por favor)?|(?:en )?espa[nñ]ol(?: por favor)?/)) {
    st.lg = "es"; st.d.push("spanish"); st.ls = "global";
    return say(st, `Claro. Continúo en español. ${repromptFor(st)}`);
  }
  if (short && /\b(switch|change|other|another|different) (the )?languages?\b|\bcambiar (de )?idioma\b/.test(t)) {
    st.lg = st.lg === "es" ? "en" : "es"; st.ls = "global"; st.d.push(st.lg === "es" ? "spanish" : "lang-en");
    return say(st, st.lg === "es" ? `Claro. Continúo en español. ${repromptFor(st)}` : `Of course. I'll continue in English. ${repromptFor(st)}`);
  }
  if (/\b(what|which) languages?\b|\bdo you (speak|have) (spanish|english|other languages)\b|\bqu[eé] idiomas?\b/.test(t)) {
    st.ls = "global";
    return say(st, L(st, `I currently support English and Spanish. ${repromptFor(st)}`, `Por ahora hablo inglés y español. ${repromptFor(st)}`));
  }
  if (short && OTHER_LANGUAGES.test(t) && /\b(switch|speak|talk|in|please|can you|do you|habla)\b|^\w+$/.test(t)) {
    st.ls = "global"; st.d.push("lang-unsupported");
    return say(st, L(st, "I'm sorry, I currently support English and Spanish. I can take a message for the office, and they can arrange help in your language. Would you like to leave a message?", "Lo siento, por ahora solo hablo inglés y español. Puedo tomar un mensaje para la oficina. ¿Quiere dejar un mensaje?"));
  }
  // ---- conversation ----
  if (short && /^(?:(?:can you |could you )?(?:please )?(?:repeat( that| it)?|say (that|it) again|what did you say|come again|pardon|sorry what)|repita|otra vez)$/.test(t)) {
    st.ls = "global";
    return say(st, st.lt || repromptFor(st));
  }
  if (short && /\b(speak|talk|go) (more )?(slower|slowly)\b|\bslow down\b|\bm[aá]s despacio\b/.test(t)) {
    st.sl = true; st.ls = "global";
    return say(st, `${L(st, "Of course.", "Claro.")} ${st.lt || repromptFor(st)}`);
  }
  if (short && /^(?:(?:let'?s |can we |please )?start over|start again|restart|from the (top|beginning)|empezar de nuevo)$/.test(t)) {
    for (const k of ["m", "mt", "mr", "mc", "os", "cw", "pi", "pq", "gi"]) delete st[k];
    st.q = []; st.s = "menu"; st.cf = 0; st.ls = "global";
    return say(st, L(st, "Sure, let's start over. How can I help?", "Claro, empecemos de nuevo. ¿En qué le puedo ayudar?"));
  }
  if (short && st.s !== "menu" && /^(?:go back|never ?mind|forget (it|that)|cancel that|olv[ií]dalo|no importa)$/.test(t)) {
    for (const k of ["m", "mt", "mr", "mc", "os", "cw", "pi", "gi"]) delete st[k];
    st.s = "menu"; st.ls = "global";
    return say(st, L(st, "Okay. What would you like to do instead?", "Está bien. ¿Qué le gustaría hacer?"));
  }
  if (short && st.s !== "message" && /^(?:help|what can you do|what do you do|how can you help|what are my options|options|menu|ayuda|qu[eé] puede hacer)$/.test(t)) {
    st.ls = "global";
    return say(st, `${capabilities(st)} ${L(st, "What would you like to do?", "¿Qué le gustaría hacer?")}`);
  }
  if (short && /\b(are you (a )?(real|human|person|robot|machine|bot|ai|computer|recording)|am i talking to a (person|human|robot|machine|computer)|is this (a )?(robot|machine|recording|real person)|eres (una )?(persona|robot)|es (usted )?(una )?(persona|m[aá]quina))\b/.test(t)) {
    st.ls = "global";
    return say(st, L(st, `I'm the practice's automated assistant. I can connect you with the office if you'd like. ${repromptFor(st)}`, `Soy el asistente automático de la práctica. Puedo comunicarle con la oficina si lo desea. ${repromptFor(st)}`));
  }
  if (short && exact(/(?:i want |i need |can i |let me |please )?(?:talk to |speak (to|with) )?(?:a |an |the |someone|somebody)?\s*(?:operator|representative|human|real person|person|front desk|receptionist|office|staff|someone|somebody)(?: please)?|(?:talk|speak) to (someone|somebody|a person|the office|staff)|una persona|recepcionista|hablar con alguien|operador(a)?/)) {
    st.ls = "global"; st.hm = true;
    return offerHuman(st, deps, "");
  }
  return null;
}

function spanishGreeting(st, deps) {
  st.lg = "es";
  st.d.push("spanish");
  const note = deps.announcement?.es || deps.announcement?.en ? ` ${deps.announcement.es || deps.announcement.en}` : "";
  return say(st, `Gracias por llamar a ${deps.practiceName}. Soy Lemonade, el asistente automático de la práctica. Esta llamada puede ser grabada y transcrita de forma segura.${note} ¿En qué le puedo ayudar?`);
}

async function askToVerify(st, pendingIntent, deps) {
  if (st.k === "unknown") {
    st.d.push("phi-refused");
    st.pr = (st.pr || 0) + 1;
    // Information safety (1.8.2): asking again and again for patient details
    // from a number we don't know is reported to staff.
    if (st.pr === 2 && deps.reportSafety) {
      st.d.push("privacy-flag");
      await deps.reportSafety({ state: st, reason: "An unverified caller asked more than once for patient information." }).catch(() => null);
    }
    return say({ ...st, s: "menu" }, L(st,
      `I understand what you're asking for, but I can only look up patient information for callers using the phone number we have on file, or offices we've approved. I can take a message for the office and someone will call you back. Would you like to leave a message?`,
      `Entiendo lo que pide, pero solo puedo buscar información de pacientes para quienes llaman desde el número que tenemos registrado u oficinas aprobadas. Puedo tomar un mensaje para la oficina y alguien le devolverá la llamada. ¿Quiere dejar un mensaje?`));
  }
  const what = st.k === "patient" ? L(st, `your date of birth ${spellDigitsHint(st)}`, `su fecha de nacimiento ${spellDigitsHint(st)}`) : st.vp || L(st, `your client's date of birth ${spellDigitsHint(st)}`, `la fecha de nacimiento de su cliente ${spellDigitsHint(st)}`);
  return say({ ...st, s: "verify", pi: pendingIntent, t: 0 }, L(st, `I can help with that. First, I need to quickly verify your information. Please enter ${what} on your keypad, then press pound.`, `Con gusto. Primero necesito verificar su información. Por favor marque ${what} en el teclado y luego oprima la tecla de número.`), "gather", { digits: st.vd || 8 });
}

function startMessage(st, target, lead = "", topic = "") {
  const to = target === "provider" ? (st.k === "patient" ? L(st, "your provider", "su proveedor") : L(st, "the provider", "el proveedor")) : L(st, "the office", "la oficina");
  st.s = "message";
  st.mt = target;
  st.m = "";
  if (topic) st.mc = topic; else delete st.mc;
  const prompt = st.mr
    ? L(st, "Please tell me the name of the medication, the pharmacy you use, and about how many days of medication you have left.", "Por favor dígame el nombre del medicamento, la farmacia que usa y para cuántos días le queda medicamento.")
    : L(st, `Please say your message for ${to} now${st.ok ? "" : ", including your name and the best number to reach you"}.`, `Por favor diga su mensaje para ${to}${st.ok ? "" : ", con su nombre y el mejor número para comunicarnos con usted"}.`);
  return say(st, `${lead}${prompt} ${L(st, `When you're finished, press pound, or say "that's all".`, `Cuando termine, oprima la tecla de número o diga "eso es todo".`)}`);
}

async function offerHuman(st, deps, lead) {
  if (deps.transferNumber) {
    st.d.push("transferred");
    return say({ ...st, s: "end" }, `${lead}${L(st, "Let me connect you with the office.", "Le comunico con la oficina.")}`, "transfer", { to: deps.transferNumber });
  }
  st.mr = false;
  st.d.push("human-requested");
  return startMessage(st, "staff", `${lead}${L(st, "The office isn't available to take the call right now. I can take a message and make sure it reaches the appropriate team. ", "La oficina no puede atender la llamada en este momento. Puedo tomar un mensaje y asegurarme de que llegue al equipo indicado. ")}`);
}

async function runIntent(st, intent, deps) {
  st.u = 0;
  st.d.push(`did-${intent}`);
  if (intent === "next_appt" || intent === "last_appt") {
    const which = intent === "next_appt" ? "next" : "last";
    const appts = await deps.appointments(st).catch(() => null);
    if (!appts) return say(st, `${L(st, "Sorry, I couldn't look up appointments just now. I can take a message for the office instead.", "Lo siento, no pude buscar las citas en este momento. Puedo tomar un mensaje para la oficina.")} ${nextOrAnythingElse(st)}`);
    st.d.push(`${which}-appt`);
    return say(st, `${apptSentence(st, which, appts[which])} ${nextOrAnythingElse(st)}`);
  }
  if (intent === "case_status") {
    const line = deps.caseStatus ? await deps.caseStatus(st).catch(() => null) : null;
    st.d.push("case-status");
    return say(st, `${line || L(st, "I don't see a report status on file. I can take a message for the office.", "No veo el estado de un informe. Puedo tomar un mensaje para la oficina.")} ${nextOrAnythingElse(st)}`);
  }
  if (intent === "clinical_info") {
    st.d.push("clinical-declined");
    return startMessage(st, "provider", L(st, "I understand what you're asking for, but I'm not able to provide clinical information by phone. I can take a message for the provider. ", "Entiendo lo que pide, pero no puedo dar información clínica por teléfono. Puedo tomar un mensaje para su proveedor. "), "Clinical question");
  }
  if (intent === "schedule") {
    if (deps.automation?.schedule === "off" || st.k !== "patient" || !deps.offerSlots) {
      return startMessage(st, "staff", L(st, "Yes, I can help with that. I'll pass your appointment request to the office. ", "Sí, con gusto. Pasaré su solicitud de cita a la oficina. "), "New appointment request");
    }
    const offer = await deps.offerSlots(st).catch(() => null);
    if (!offer?.slots?.length) return startMessage(st, "staff", L(st, "Yes, I can help with that. I don't see open times I can offer right now, so I'll pass your request to the office. ", "Sí, con gusto. No veo horarios disponibles ahora, así que pasaré su solicitud a la oficina. "), "New appointment request");
    st.s = "resched";
    st.sk = "schedule";
    st.os = offer.slots.slice(0, 3).map((x) => ({ l: x.label, k: x.key }));
    return say(st, L(st, `Yes, I can help with that. I have ${st.os.map((x) => x.l).join(", or ")}. Would any of those work? You can also say "neither".`, `Sí, con gusto. Tengo ${st.os.map((x) => x.l).join(", o ")}. ¿Le conviene alguna? También puede decir "ninguna".`));
  }
  if (intent === "reschedule") {
    if (deps.automation?.reschedule === "off") return startMessage(st, "staff", L(st, "I'll pass a rescheduling request to the office. ", "Pasaré su solicitud de cambio de cita a la oficina. "), "Reschedule request");
    if (st.k !== "patient" || !deps.offerSlots) return startMessage(st, "staff", L(st, "I'll pass a rescheduling request to the office. ", "Pasaré su solicitud de cambio de cita a la oficina. "), "Reschedule request");
    const offer = await deps.offerSlots(st).catch(() => null);
    if (!offer?.slots?.length) return startMessage(st, "staff", L(st, "I don't see open times I can offer right now, so I'll pass your request to the office. ", "No veo horarios disponibles en este momento, así que pasaré su solicitud a la oficina. "), "Reschedule request");
    st.s = "resched";
    st.sk = "reschedule";
    st.os = offer.slots.slice(0, 3).map((s) => ({ l: s.label, k: s.key }));
    const options = st.os.map((s) => s.l).join(L(st, ", or ", ", o "));
    return say(st, L(st, `Sure. I have ${options}. Which works better? You can also say "neither".`, `Claro. Tengo ${options}. ¿Cuál le conviene? También puede decir "ninguna".`));
  }
  if (intent === "cancel") {
    if (st.k !== "patient") return startMessage(st, "staff", L(st, "I'll pass the cancellation to the office to handle. ", "Pasaré la cancelación a la oficina. "), "Cancel request");
    const appts = await deps.appointments(st).catch(() => null);
    const next = appts?.next;
    if (!next) return say(st, `${L(st, "I don't see an upcoming appointment to cancel.", "No veo una próxima cita para cancelar.")} ${nextOrAnythingElse(st)}`);
    // Never cancel without a clear yes to the exact appointment (directive 9/13).
    st.s = "cancel_confirm";
    st.cw = next.when;
    return say(st, L(st, `Just to confirm, you'd like to cancel your appointment on ${next.when}${next.provider ? ` with ${next.provider}` : ""}? Please say yes or no.`, `Para confirmar, ¿quiere cancelar su cita del ${next.when}${next.provider ? ` con ${next.provider}` : ""}? Diga sí o no.`));
  }
  if (intent === "refill") {
    if (deps.automation?.refill === "off") { st.mr = false; return startMessage(st, "provider", "", "Refill question"); }
    st.mr = true;
    return startMessage(st, "provider", L(st, "I can send a refill request to the prescribing team. ", "Puedo enviar una solicitud de receta al equipo que receta. "));
  }
  if (intent === "message_provider" || intent === "message_staff") {
    st.mr = false;
    return startMessage(st, intent === "message_provider" ? "provider" : "staff");
  }
  if (STAFF_TOPICS[intent]) {
    st.mr = false;
    const lead = intent === "running_late"
      ? L(st, "Thanks for letting us know. ", "Gracias por avisarnos. ")
      : "";
    return startMessage(st, "staff", lead, STAFF_TOPICS[intent].en);
  }
  return say(st, `${menuLine(st)} ${L(st, "What can I help you with?", "¿En qué le puedo ayudar?")}`);
}

// 1.8.6: "Thursday -- actually Friday": the newest correction wins.
export function correctionTail(text) {
  const parts = String(text || "").split(/\b(?:actually|sorry|i mean|no wait|wait|rather|mejor dicho|perd[oó]n)\b/i);
  return parts.length > 1 && parts.at(-1).trim() ? parts.at(-1) : String(text || "");
}
function pickSlot(st, input) {
  const t = correctionTail(String(input?.speech || input?.key || "")).toLowerCase();
  if (/\b(neither|none|no|other|different|ninguna|otra)\b/.test(t)) return "none";
  // "Second" first: "the second one" also contains "one".
  if (/^3$|\b(third|three|3rd|tercera|tres)\b/.test(t)) return st.os[2] || null;
  if (/^2$|\b(second|two|2nd|later|the other|last one|segunda|dos)\b/.test(t)) return st.os[1] || null;
  if (/^1$|\b(first|one|1st|earlier|primera|una)\b/.test(t)) return st.os[0];
  return st.os.find((s) => s.l.toLowerCase().split(/[ ,]+/).filter((w) => w.length > 3).some((w) => t.includes(w))) || null;
}

const isYes = (speech, key) => /\b(yes|yeah|yep|please|ok|okay|sure|correct|si|claro|correcto|por favor)\b/i.test(fold(speech)) || key === "1";
const isNo = (speech, key) => /\b(no|nope|nah|don'?t|do not|never mind|cancel that)\b/i.test(fold(speech)) || key === "2";

// ---- crisis (1.8.2) --------------------------------------------------------------
async function raiseAlert(st, deps, text, kind) {
  if (!deps.flagUrgent) return false;
  const r = await deps.flagUrgent({ state: st, text, kind }).catch(() => null);
  if (r?.alertId) st.cr = r.alertId;
  if (alertOk(r)) st.d.push("alert-sent");
  return alertOk(r);
}

async function crisisStart(st, deps, speech) {
  st.d.push("crisis");
  const sent = await raiseAlert(st, deps, speech, "crisis");
  const told = sent ? L(st, " I've let the clinic's crisis response staff know.", " Ya avisé al equipo de respuesta a crisis de la clínica.") : "";
  return say({ ...st, s: "crisis_q" }, L(st,
    `I'm glad you told me. I'm concerned about your safety, and I want to help you get connected with someone who can help.${told} Are you in immediate danger of hurting yourself right now?`,
    `Gracias por decírmelo. Me preocupa su seguridad y quiero ayudarle a comunicarse con alguien que pueda ayudarle.${told} ¿Está en peligro inmediato de hacerse daño ahora mismo?`));
}

function emergencyLine(st) {
  return st.ah
    ? L(st, "I'm concerned about your immediate safety. The clinic is closed right now, so please call 9 1 1 or go to the nearest emergency department now.", "Me preocupa su seguridad inmediata. La clínica está cerrada en este momento. Llame al 9 1 1 o vaya al departamento de emergencias más cercano ahora.")
    : L(st, "I'm concerned about your immediate safety. Please call 9 1 1 now, or go to the nearest emergency department.", "Me preocupa su seguridad inmediata. Por favor llame al 9 1 1 ahora o vaya al departamento de emergencias más cercano.");
}
const stayLine = (st) => L(st, "I'm still here with you.", "Sigo aquí con usted.");
const line988 = (st) => L(st, "You can call or text 9 8 8, the Suicide and Crisis Lifeline, any time, day or night.", "Puede llamar o enviar un mensaje de texto al 9 8 8, la Línea de Prevención del Suicidio y Crisis, a cualquier hora. Hay ayuda en español.");

async function crisisTurn(st, speech, key, deps) {
  // A person, at any point, comes first (directive 23).
  const wantsPerson = /\b(person|human|someone|somebody|representative|operator|real person|staff|doctor|nurse|counselor|una persona|alguien)\b/i.test(speech);
  if (st.s === "crisis_q") {
    if (isYes(speech, key) || /\b(i am|maybe|i think so|right now|ahora)\b/i.test(speech)) {
      st.d.push("imminent");
      return say({ ...st, s: "crisis_loc" }, `${emergencyLine(st)} ${L(st, "Where are you right now?", "¿Dónde está ahora mismo?")}`);
    }
    const sent = (st.d || []).includes("alert-sent");
    const alerted = sent ? ` ${L(st, "I've alerted the clinical team.", "Ya avisé al equipo clínico.")}` : "";
    const afterHours = st.ah ? ` ${L(st, "If at any point you feel you can't stay safe, call 9 1 1 or go to the nearest emergency department.", "Si en algún momento siente que no puede mantenerse a salvo, llame al 9 1 1 o vaya al departamento de emergencias más cercano.")}` : "";
    if (deps.transferNumber && !st.ah) {
      return say({ ...st, s: "crisis_offer" }, `${L(st, "Thank you for telling me.", "Gracias por decírmelo.")} ${line988(st)}${alerted} ${L(st, "I can also connect you to our clinical team right now. Would you like that?", "También puedo comunicarle con nuestro equipo clínico ahora mismo. ¿Le gustaría?")}`);
    }
    return say({ ...st, s: "crisis_stay" }, `${L(st, "Thank you for telling me.", "Gracias por decírmelo.")} ${line988(st)}${alerted}${afterHours} ${stayLine(st)} ${L(st, "Is there anything you'd like me to pass on to your care team?", "¿Hay algo que quiera que le pase a su equipo de atención?")}`);
  }
  if (st.s === "crisis_loc") {
    await raiseAlert(st, deps, speech || "(no location given)", "location");
    if (deps.transferNumber) return say({ ...st, s: "end" }, L(st, "Thank you. I'm connecting you to our clinical team now. If the call drops, please call 9 1 1.", "Gracias. Le comunico ahora con nuestro equipo clínico. Si se corta la llamada, llame al 9 1 1."), "transfer", { to: deps.transferNumber });
    // Emergency help and the clinic alert are parallel -- never "wait for us".
    return say({ ...st, s: "crisis_stay" }, L(st,
      "Thank you. I've alerted the clinical team with where you are. Please hang up and call 9 1 1 now. If you can't, stay on the line with me.",
      "Gracias. Ya avisé al equipo clínico dónde está. Por favor cuelgue y llame al 9 1 1 ahora. Si no puede, quédese en la línea conmigo."));
  }
  if (st.s === "crisis_offer") {
    if (isYes(speech, key) || wantsPerson) return say({ ...st, s: "end" }, L(st, "Connecting you now. If the call drops, call or text 9 8 8, or call 9 1 1.", "Le comunico ahora. Si se corta la llamada, llame o envíe un texto al 9 8 8, o llame al 9 1 1."), "transfer", { to: deps.transferNumber });
    return say({ ...st, s: "crisis_stay" }, `${L(st, "Okay.", "Está bien.")} ${stayLine(st)} ${L(st, "Is there anything you'd like me to pass on to your care team?", "¿Hay algo que quiera que le pase a su equipo de atención?")}`);
  }
  // crisis_stay: keep the caller company, listen for things getting worse.
  if (wantsPerson && deps.transferNumber) return say({ ...st, s: "end" }, L(st, "Of course. Connecting you now.", "Claro. Le comunico ahora."), "transfer", { to: deps.transferNumber });
  if (/\b(bye|goodbye|hang up|i'?m (ok|okay|fine)|that'?s all|adi[oó]s|estoy bien)\b/i.test(speech) || key === "#") {
    return done(st, L(st, "Thank you for calling. Please call or text 9 8 8 any time, or call 9 1 1 if you're in danger. Take care of yourself.", "Gracias por llamar. Llame o envíe un texto al 9 8 8 a cualquier hora, o llame al 9 1 1 si está en peligro. Cuídese."));
  }
  if (speech) {
    st.cn = (st.cn || 0) + 1;
    if (st.cn <= 3 && deps.leaveMessage) {
      await deps.leaveMessage({ state: st, target: "provider", text: speech, urgent: true, verified: Boolean(st.ok) }).catch(() => null);
      st.d.push("crisis-note");
    }
    return say(st, `${L(st, "Thank you. I've passed that to the clinical team.", "Gracias. Se lo pasé al equipo clínico.")} ${stayLine(st)} ${line988(st)}`);
  }
  return say(st, stayLine(st));
}

export async function continueConversation(state, input, deps) {
  const st = { ...state, d: [...(state.d || [])], q: [...(state.q || [])], n: (state.n || 0) + 1 };
  if (!st.lg) st.lg = "en";
  if (st.n > MAX_TURNS) return done(st, L(st, "We've reached the end of what I can help with on this call. If you need help right away, call 9 1 1 or 9 8 8. Goodbye.", "Llegamos al final de lo que puedo ayudar en esta llamada. Si necesita ayuda de inmediato, llame al 9 1 1 o al 9 8 8. Adiós."));
  const speech = String(input?.speech || "").trim();
  const key = String(input?.key || "");
  st.ls = speech ? "keywords" : key ? "keypad" : "digits";

  // ---- 1. global commands (never when the sentence carries crisis words) ----
  if (speech && !CRISIS.test(speech) && !THREAT.test(speech) && !["crisis_q", "crisis_loc", "crisis_offer", "crisis_stay", "verify"].includes(st.s)) {
    const g = await globalCommand(st, speech, key, deps);
    if (g) return g;
  }

  // ---- 2. safety comes first, in every state ----
  if (speech && THREAT.test(speech) && st.s !== "crisis_loc") {
    st.d.push("threat");
    await raiseAlert(st, deps, speech, "threat");
    if (deps.transferNumber) return say({ ...st, s: "end" }, L(st, "I'm getting someone from our clinical team on the line right now. Please stay on the line.", "Estoy comunicándole con alguien de nuestro equipo clínico ahora mismo. Por favor no cuelgue."), "transfer", { to: deps.transferNumber });
    return say({ ...st, s: "menu" }, `${L(st, "I've sent what you said to our clinical team right away. If anyone is in danger right now, please hang up and call 9 1 1.", "Envié lo que dijo a nuestro equipo clínico de inmediato. Si alguien está en peligro ahora mismo, cuelgue y llame al 9 1 1.")} ${anythingElse(st)}`);
  }
  if (speech && CRISIS.test(speech) && !["crisis_q", "crisis_loc", "crisis_stay", "crisis_offer"].includes(st.s)) {
    // The routine task is dropped -- safety is the only job now (directive 37).
    delete st.m; delete st.mt; delete st.mr; delete st.os; delete st.pi; delete st.pq;
    st.q = [];
    return crisisStart(st, deps, speech);
  }
  if (speech && CRISIS.test(speech) && st.s === "crisis_stay" && /\b(took|overdos\w*|pills|now|right now|tonight|gun|knife|sobredosis|pastillas|ahora)\b/i.test(speech)) {
    st.d.push("imminent");
    await raiseAlert(st, deps, speech, "location");
    return say({ ...st, s: "crisis_loc" }, `${emergencyLine(st)} ${L(st, "Where are you right now?", "¿Dónde está ahora mismo?")}`);
  }
  if (["crisis_q", "crisis_loc", "crisis_offer", "crisis_stay"].includes(st.s)) return crisisTurn(st, speech, key, deps);

  // ---- verification ----
  if (st.s === "verify") {
    const digits = String(input?.digits || "").replace(/\D/g, "");
    const result = digits ? await deps.verify(st, digits).catch(() => null) : null;
    if (!result?.ok) {
      st.t = (st.t || 0) + 1;
      if (st.t >= MAX_TRIES) {
        st.d.push("verify-failed");
        st.s = "menu";
        if (deps.reportSafety) {
          st.d.push("privacy-flag");
          await deps.reportSafety({ state: st, reason: "Two birth dates that didn't match the chart for this phone number." }).catch(() => null);
        }
        return offerHuman(st, deps, L(st, "Sorry, I wasn't able to verify that, so I can't share details on this call. ", "Lo siento, no pude verificar eso, así que no puedo compartir detalles en esta llamada. "));
      }
      return say(st, L(st, "Sorry, that didn't match our records. Please try once more, then press pound.", "Lo siento, eso no coincide con nuestros registros. Inténtelo una vez más y oprima la tecla de número."), "gather", { digits: st.vd || 8 });
    }
    st.ok = true;
    st.s = "menu";
    st.t = 0;
    st.sid = result.subjectId;
    st.sn = result.subjectFirstName || "";
    st.d.push("verified");
    const pending = st.pi;
    delete st.pi;
    const thanks = st.k === "patient" ? L(st, "Thank you, you're verified.", "Gracias, ya está verificado.") : L(st, `Thank you. I found ${st.sn ? `${st.sn}'s record` : "the record"}.`, `Gracias. Encontré el registro${st.sn ? ` de ${st.sn}` : ""}.`);
    if (pending) {
      const out = await runIntent(st, pending, deps);
      return { ...out, say: `${thanks} ${out.say}` };
    }
    return say(st, `${thanks} ${menuLine(st)} ${L(st, "What can I help you with?", "¿En qué le puedo ayudar?")}`);
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
    const topic = st.mc || "";
    delete st.m; delete st.mt; delete st.mr; delete st.mc;
    st.s = "menu";
    if (!message) return say(st, `${L(st, "I didn't catch a message.", "No escuché un mensaje.")} ${anythingElse(st)}`);
    const sent = await deps.leaveMessage({ state: st, target, text: message, refill, topic, verified: Boolean(st.ok) }).catch(() => null);
    if (!sent?.ok) return say(st, `${L(st, "Sorry, I couldn't save your message just now. Please call the office during business hours.", "Lo siento, no pude guardar su mensaje en este momento. Por favor llame a la oficina en horario de atención.")} ${anythingElse(st)}`);
    st.d.push(refill ? "refill-request" : `message-${target}`);
    if (topic === "Reschedule request") st.d.push("reschedule-request");
    if (topic === "Cancel request") st.d.push("cancel-request");
    const outcome = refill
      ? L(st, `Thank you. I've sent the refill request to ${sent.to || "the prescribing team"}. They may contact you if anything else is needed.`, `Gracias. Envié la solicitud de receta al equipo que receta. Es posible que le contacten si necesitan algo más.`)
      : L(st, `Thank you. Your message has been sent to ${sent.to || (target === "provider" ? "the provider" : "the office")}, and someone will follow up with you.`, `Gracias. Su mensaje fue enviado a ${target === "provider" ? "su proveedor" : "la oficina"} y alguien se comunicará con usted.`);
    return say(st, `${outcome} ${nextOrAnythingElse(st)}`);
  }

  // ---- choosing a new time ----
  if (st.s === "resched") {
    if (speech && /\b(when is|what time is|when's) (my|the) (current|next|existing)? ?(appointment|appt)\b|\bmy current appointment\b/i.test(speech) && deps.appointments) {
      const appts = await deps.appointments(st).catch(() => null);
      const goal = st.sk === "schedule" ? L(st, "You wanted a new appointment.", "Usted quería una cita nueva.") : L(st, "You wanted to move it.", "Usted quería cambiarla.");
      return say(st, `${apptSentence(st, "next", appts?.next)} ${goal} ${L(st, `I have ${st.os.map((x) => x.l).join(", or ")}. Would one of those work?`, `Tengo ${st.os.map((x) => x.l).join(", o ")}. ¿Le conviene alguna?`)}`);
    }
    const pick = pickSlot(st, input);
    if (pick === "none") {
      delete st.os;
      return startMessage(st, "staff", L(st, "No problem. I'll pass your request to the office so they can find a time that works. ", "No hay problema. Pasaré su solicitud a la oficina para que encuentren un horario que le convenga. "), "Reschedule request");
    }
    if (!pick) {
      st.t = (st.t || 0) + 1;
      if (st.t >= MAX_TRIES) { delete st.os; st.t = 0; return startMessage(st, "staff", L(st, "I'll pass your request to the office instead. ", "Pasaré su solicitud a la oficina. "), "Reschedule request"); }
      const ord = (i) => L(st, ["first", "second", "third"][i], ["primera", "segunda", "tercera"][i]);
      return say(st, `${L(st, "Sorry, which one?", "Perdón, ¿cuál?")} ${st.os.map((s, i) => L(st, `Say ${ord(i)} for ${s.l}`, `Diga ${ord(i)} para ${s.l}`)).join(L(st, ", or ", ", o "))}.`);
    }
    const isNew = st.sk === "schedule";
    const sent = await deps.requestReschedule({ state: st, slot: { label: pick.l, key: pick.k }, kind: isNew ? "schedule" : "reschedule" }).catch(() => null);
    delete st.os; delete st.sk;
    st.s = "menu";
    st.t = 0;
    if (!sent?.ok) return say(st, `${L(st, "Sorry, I couldn't send that just now. Please call the office during business hours.", "Lo siento, no pude enviarlo en este momento. Por favor llame a la oficina en horario de atención.")} ${anythingElse(st)}`);
    st.d.push(isNew ? "schedule-request" : "reschedule-request");
    // A request, not a booking: staff confirm it and text the patient (directive 10).
    return say(st, `${isNew
      ? L(st, `Thank you. I've asked the office to book ${pick.l} for you. They'll confirm it with you by text.`, `Gracias. Pedí a la oficina que le reserve ${pick.l}. Le confirmarán por mensaje de texto.`)
      : L(st, `Thank you. I've asked the office to move your appointment to ${pick.l}. They'll confirm it with you by text.`, `Gracias. Pedí a la oficina que cambie su cita a ${pick.l}. Le confirmarán por mensaje de texto.`)} ${nextOrAnythingElse(st)}`);
  }

  // ---- confirming a cancellation ----
  if (st.s === "cancel_confirm") {
    const when = st.cw;
    delete st.cw;
    st.s = "menu";
    if (isNo(speech, key) && !isYes(speech, key)) {
      st.d.push("cancel-declined");
      return say(st, `${L(st, "Okay, I won't cancel it.", "Está bien, no la cancelaré.")} ${nextOrAnythingElse(st)}`);
    }
    if (!isYes(speech, key)) {
      st.d.push("cancel-declined");
      return say(st, `${L(st, "I didn't hear a clear yes, so I haven't cancelled anything.", "No escuché un sí claro, así que no cancelé nada.")} ${nextOrAnythingElse(st)}`);
    }
    const sent = await deps.leaveMessage({ state: st, target: "staff", text: `Please cancel the appointment on ${when}. The patient confirmed on the phone.`, topic: "Cancel request", verified: Boolean(st.ok) }).catch(() => null);
    if (!sent?.ok) return say(st, `${L(st, "Sorry, I couldn't send that just now. Please call the office during business hours.", "Lo siento, no pude enviarlo. Por favor llame a la oficina en horario de atención.")} ${anythingElse(st)}`);
    st.d.push("cancel-request");
    return say(st, `${L(st, `I've sent the cancellation for ${when} to the office. They'll confirm it with you by text.`, `Envié la cancelación del ${when} a la oficina. Le confirmarán por mensaje de texto.`)} ${nextOrAnythingElse(st)}`);
  }

  // ---- a choice between rescheduling and cancelling ----
  if (st.s === "cant_make") {
    st.s = "menu";
    if (/\b(cancel|cancelar)\b/i.test(speech)) return st.ok ? runIntent(st, "cancel", deps) : askToVerify(st, "cancel", deps);
    if (/\b(reschedul\w*|move|another|different|change|cambiar|otra)\b/i.test(speech) || isYes(speech, key)) return st.ok ? runIntent(st, "reschedule", deps) : askToVerify(st, "reschedule", deps);
    return say(st, `${L(st, "Okay, I won't change anything.", "Está bien, no cambiaré nada.")} ${anythingElse(st)}`);
  }

  if (st.s !== "menu") return done(st, L(st, "Goodbye.", "Adiós."));

  // ---- the menu: what does the caller want? ----
  if (key === "8" || (st.lg !== "es" && st.n <= 2 && SPANISH.test(speech) && !/\b(english|appointment|schedule|refill|message)\b/i.test(speech))) {
    if (st.lg !== "es") return spanishGreeting(st, deps);
  }
  // "Is that right?" after Gary's best guess.
  if (st.gi) {
    const guessed = st.gi;
    delete st.gi;
    if (isYes(speech, key) && !isNo(speech, key)) {
      st.cf = 0;
      st.li = guessed;
      if (guessed === "schedule" && st.k === "unknown") return newAppointmentRequest(st);
      if (PHI_INTENTS.has(guessed) && !st.ok) return askToVerify(st, guessed, deps);
      return runIntent(st, guessed, deps);
    }
  }

  // A question from earlier in the call ("You also mentioned...") -- yes/no.
  if (st.pq) {
    const pending = st.pq;
    if (isYes(speech, key) && !isNo(speech, key)) {
      delete st.pq;
      if (PHI_INTENTS.has(pending) && !st.ok) return askToVerify(st, pending, deps);
      return runIntent(st, pending, deps);
    }
    if (isNo(speech, key) && !speech.replace(/\b(no|nope|nah)\b/gi, "").trim()) {
      delete st.pq;
      st.q = [];
      return say(st, anythingElse(st));
    }
    delete st.pq;
  }

  if (speech && NEGATED_CANCEL.test(speech) && !classifyAll(speech).some((i) => i !== "cancel")) {
    st.d.push("cancel-declined");
    return say(st, `${L(st, "Okay, I won't cancel anything.", "Está bien, no cancelaré nada.")} ${anythingElse(st)}`);
  }
  if (speech && MASS_CANCEL_OTHERS.test(speech)) {
    st.d.push("mass-cancel-refused");
    return say(st, `${L(st, "I can't make changes to other people's appointments over the phone. Office staff can help with that.", "No puedo hacer cambios a las citas de otras personas por teléfono. El personal de la oficina puede ayudarle.")} ${anythingElse(st)}`);
  }
  if (speech && MASS_CANCEL_ALL_MINE.test(speech)) {
    st.mr = false;
    if (!st.ok && st.k !== "unknown") return askToVerify(st, "message_staff", deps);
    return startMessage(st, "staff", L(st, "I'll have the office go over each of your appointments with you before anything is cancelled. ", "La oficina revisará con usted cada una de sus citas antes de cancelar algo. "), "Cancel request (all appointments -- review each with the patient)");
  }
  if (speech && CANT_MAKE_IT.test(speech) && !/\b(cancel|reschedul\w*|move)\b/i.test(speech)) {
    st.s = "cant_make";
    return say(st, L(st, "No problem. Would you like to reschedule it, or just cancel it?", "No hay problema. ¿Quiere cambiar la cita o solo cancelarla?"));
  }

  let intent = KEY_INTENTS[key] || null;
  if (!intent && speech) {
    const ai = deps.classify ? await deps.classify(speech, st).catch(() => null) : null;
    const kw = classifyByKeywords(speech);
    // The AI's "unknown" never overrides a clear keyword match.
    intent = ai && ai !== "unknown" ? ai : kw;
    st.ls = ai && ai !== "unknown" ? "ai" : "keywords";
  }
  if (!intent) intent = "unknown";
  if (intent === "cancel_day") intent = "cancel";
  if (intent === "cancel" && NEGATED_CANCEL.test(speech)) intent = "unknown";
  if (intent === "case_status" && !deps.caseStatus) intent = "message_staff";
  // Remember the other requests in the same sentence (directive 39/40), and
  // take them in the order the caller said them.
  if (speech) {
    let all = classifyAll(speech).filter((i) => i !== "human").map((i) => (i === "cancel_day" ? "cancel" : i));
    // "...actually, before you do that, when is my current appointment?"
    if (/\bbefore (you do that|that|we do that)\b|\bfirst,? (tell me|when)\b/i.test(speech) && all.length > 1) all = [...all.slice(1), all[0]];
    all = [...new Set(all)];
    if (all.length > 1 && all.includes(intent)) intent = all[0];
    const extra = all.filter((i) => i !== intent && i !== "human" && INTENTS.includes(i) && !(st.q || []).includes(i));
    if (extra.length) st.q = [...(st.q || []), ...extra].slice(0, 4);
  }

  st.li = intent;
  if (intent !== "unknown") st.cf = 0;
  if (intent === "goodbye" || intent === "no") return goodbye(st, deps);
  if (intent === "repeat") return say(st, st.lt || repromptFor(st));
  if (intent === "yes") {
    // "Would you like to leave a message?" -> yes
    if (!st.ok) return startMessage(st, "staff");
    return say(st, L(st, "What can I help you with?", "¿En qué le puedo ayudar?"));
  }
  if (PUBLIC_INTENTS.has(intent)) {
    st.u = 0;
    const info = deps.publicInfo || {};
    const answer = {
      hours: info.hours ? L(st, `Our office hours are ${info.hours}.`, `Nuestro horario es ${info.hours}.`) : "",
      location: info.address ? L(st, `We're located at ${info.address}.`, `Estamos en ${info.address}.`) : "",
      fax: info.fax ? L(st, `Our fax number is ${info.fax}.`, `Nuestro número de fax es ${info.fax}.`) : "",
      new_patients: info.newPatients || "",
    }[intent];
    st.d.push(`info-${intent}`);
    st.d.push(`did-${intent}`);
    return say(st, `${answer || L(st, "I don't have that information in front of me, but I can take a message and the office will call you back.", "No tengo esa información, pero puedo tomar un mensaje y la oficina le devolverá la llamada.")} ${nextOrAnythingElse(st)}`);
  }
  if (intent === "human") { st.hm = true; return offerHuman(st, deps, ""); }
  if (intent === "message_staff" || (STAFF_TOPICS[intent] && !PHI_INTENTS.has(intent))) return runIntent(st, intent, deps);
  // Understood, never authorized by phone -- say so, offer a message.
  if (intent === "clinical_info") return runIntent(st, intent, deps);
  // A caller we don't know asking for an appointment is usually a NEW
  // patient: no verification needed to take the request.
  if (intent === "schedule" && st.k === "unknown") return newAppointmentRequest(st);
  if (PHI_INTENTS.has(intent)) {
    if (!st.ok) return askToVerify(st, intent, deps);
    return runIntent(st, intent, deps);
  }

  return clarify(st, speech);
}

// A caller we don't know asking for an appointment: usually a new patient.
function newAppointmentRequest(st) {
  return startMessage(st, "staff", L(st, "Yes, I can help with that. I'll pass your appointment request to the office. ", "Sí, con gusto. Pasaré su solicitud de cita a la oficina. "), "New appointment request");
}

// 1.8.6: when unsure, stay on the likely topic -- never list unrelated
// options, never jump to voicemail after two misses.
export function likelyTopic(text) {
  const t = String(text || "").toLowerCase();
  if (/\b(appoint\w*|appt|schedul\w*|book|see (the )?(doctor|dr)|come in|visit|opening|cita)\b/.test(t)) return "appointment";
  if (/\b(med\w*|pills?|prescri\w*|pharmac\w*|dos(e|es|age)|refill\w*|receta)\b/.test(t)) return "medication";
  if (/\b(form|paper\w*|report|records?|l ?& ?i|claim|letter)\b/.test(t)) return "paperwork";
  return "";
}
function clarify(st, speech) {
  st.cf = (st.cf || 0) + 1;
  st.d.push("clarify");
  const topic = likelyTopic(speech);
  if (st.cf === 1 && topic === "appointment") {
    st.gi = /\b(when|what time)\b/i.test(speech) ? "next_appt" : "schedule";
    return say(st, st.gi === "next_appt"
      ? L(st, "It sounds like you'd like to know when your appointment is. Is that right?", "Parece que quiere saber cuándo es su cita. ¿Es correcto?")
      : L(st, "It sounds like you're trying to schedule an appointment. Is that right?", "Parece que quiere programar una cita. ¿Es correcto?"));
  }
  if (st.cf === 1 && topic === "medication") {
    st.gi = "refill";
    return say(st, L(st, "It sounds like this is about a medication. Are you asking for a refill?", "Parece que es sobre un medicamento. ¿Necesita una receta?"));
  }
  if (st.cf <= 2) {
    const q = {
      appointment: L(st, "Are you trying to schedule, change, or cancel an appointment?", "¿Quiere programar, cambiar o cancelar una cita?"),
      medication: L(st, "Is this about a refill, a side effect, or a question for your provider?", "¿Es sobre una receta, un efecto secundario o una pregunta para su proveedor?"),
      paperwork: L(st, "Is this about a form, a report, or records?", "¿Es sobre un formulario, un informe o expedientes?"),
    }[topic] || L(st, "Are you calling about an appointment, a medication, or something else?", "¿Llama por una cita, un medicamento u otra cosa?");
    return say(st, q);
  }
  return say(st, L(st, "I'm still having trouble understanding. You can tell me in your own words, say \"representative\", or I can take a message for the office.", "Todavía me cuesta entenderle. Puede decírmelo con sus propias palabras, decir \"representante\", o puedo tomar un mensaje para la oficina."));
}

// One line for the call log: what happened (no chart data).
export function callOutcome(state) {
  const did = new Set(state?.d || []);
  const bits = [];
  const add = (k, text) => { if (did.has(k)) bits.push(text); };
  add("spanish", "in Spanish");
  add("not-on-file", "number not on file or allowed list");
  add("phi-refused", "asked for patient details -- not shared (unverified)");
  add("verify-failed", "could not verify -- nothing shared");
  add("privacy-flag", "information-safety flag sent to staff");
  add("verified", "verified");
  add("next-appt", "heard next appointment");
  add("last-appt", "heard last appointment");
  add("case-status", "heard report status");
  for (const k of ["hours", "location", "fax", "new_patients"]) add(`info-${k}`, `asked for ${k.replace("_", " ")}`);
  add("schedule-request", "asked for a new appointment (sent to staff)");
  add("reschedule-request", "asked to reschedule (sent to staff)");
  add("clinical-declined", "asked for clinical information -- not given by phone; message taken");
  add("lang-unsupported", "asked for a language we don't support yet");
  add("human-requested", "asked for a person");
  add("cancel-request", "asked to cancel (sent to staff)");
  add("cancel-declined", "decided not to cancel");
  add("mass-cancel-refused", "asked to cancel other people's appointments -- refused");
  add("refill-request", "requested a refill (sent to the prescribing team)");
  add("message-provider", "left a message for the provider");
  add("message-staff", "left a message for the office");
  add("crisis", "crisis words -- engaged, given 988/911");
  add("alert-sent", "crisis alert sent to the crisis-response staff");
  add("imminent", "said they were in immediate danger");
  add("crisis-note", "said more for the care team during the crisis");
  add("threat", "threat toward another person -- staff alerted");
  add("transferred", "transferred to the office");
  return bits.join("; ") || "hung up before anything happened";
}

// What's still needed after the call (the Phone Assistant's "Action needed").
export function callActions(state) {
  const did = new Set(state?.d || []);
  const out = [];
  if (did.has("threat")) out.push({ level: "urgent", text: "Clinician review now: threat toward another person (duty-to-warn question)" });
  if (did.has("imminent")) out.push({ level: "urgent", text: "Crisis: caller said they were in immediate danger -- see the crisis alert" });
  else if (did.has("crisis")) out.push({ level: "urgent", text: "Crisis words on the call -- follow up through the crisis alert" });
  if (did.has("refill-request")) out.push({ level: "task", text: "Review the refill request (My Day task)" });
  if (did.has("schedule-request")) out.push({ level: "task", text: "Book the new appointment the patient chose, then text to confirm (My Day task)" });
  if (did.has("lang-unsupported")) out.push({ level: "review", text: "Caller needed a language we don't support -- call back with an interpreter" });
  if (did.has("reschedule-request")) out.push({ level: "task", text: "Move the appointment as requested, then text the patient to confirm (My Day task)" });
  if (did.has("cancel-request")) out.push({ level: "task", text: "Cancel the appointment the patient confirmed, then text them (My Day task)" });
  if (did.has("message-provider")) out.push({ level: "task", text: "Provider: answer the message (My Day task)" });
  if (did.has("message-staff")) out.push({ level: "task", text: "Office: answer the message (My Day task)" });
  if (did.has("privacy-flag")) out.push({ level: "review", text: "Information safety: review who this caller is before sharing anything" });
  if (did.has("verify-failed") && !did.has("message-staff") && !did.has("transferred")) out.push({ level: "review", text: "Couldn't verify -- consider calling back the number on the chart" });
  if (did.has("transferred")) out.push({ level: "info", text: "Transferred to the office" });
  return out;
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
