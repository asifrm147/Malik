// Phone Assistant Simulator -- shared with Lemonade (src/server-lib/voiceScenarios.js, the "Phone Attendant Fix
// Directive" #21-22). Scripted calls against a made-up practice -- no real
// patient data, nothing saved -- so the conversation engine can be checked
// in seconds, from the Phone Assistant page and in the automated tests.
//
// For every turn the run reports: what was heard, the language, the intent
// and how it was understood, whether the caller was matched and verified,
// what they were authorized for, the action, the data looked at, what was
// disclosed, any chart change (never -- requests go to staff), tasks
// created, the reply, and pass/fail with the reason.
import { startConversation, continueConversation } from "./voiceAttendantCore.js";

const PATIENT = "+15095550100";
const SPANISH_PATIENT = "+15095550111";
const LAWYER = "+15095550199";
const UNKNOWN = "+12065550000";

function fakePractice(log, practiceName) {
  const wouldSend = [];
  const deps = {
    practiceName,
    publicInfo: { hours: "Monday through Friday, 8 AM to 5 PM", address: "5904 North Division Street, Spokane", fax: "509 555 0101", newPatients: "Yes, we're accepting new patients." },
    transferNumber: "",
    automation: { schedule: "request", reschedule: "request", cancel: "request", refill: "request", officeInfo: "on" },
    wouldSend,
    async lookupCaller(from) {
      log.push("caller lookup by phone number");
      if (from === PATIENT || from === SPANISH_PATIENT) return { kind: "patient" };
      if (from === LAWYER) return { kind: "party", id: "p1" };
      return null;
    },
    async verify(st, digits) {
      log.push("birth-date check");
      if (st.k === "patient" && digits === "03051980") return { ok: true, subjectId: "PATIENT_001", subjectFirstName: "Ann" };
      if (st.k === "party" && digits === "01021990") return { ok: true, subjectId: "PATIENT_002", subjectFirstName: "Bo" };
      return { ok: false };
    },
    async appointments() { log.push("appointments (own record)"); return { next: { when: "Tuesday, October 13 at 10 AM", provider: "Dr. Malik" }, last: { when: "Monday, September 14 at 10 AM", provider: "Dr. Malik", status: "Completed" } }; },
    async offerSlots() { log.push("open appointment times"); return { slots: [{ label: "Wednesday, October 14 at 2 PM", key: "a" }, { label: "Thursday, October 15 at 11 AM", key: "b" }] }; },
    async requestReschedule({ slot, kind }) { wouldSend.push({ kind: "My Day task", title: `${kind === "schedule" ? "Appointment" : "Reschedule"} request: ${slot.label}` }); return { ok: true }; },
    async leaveMessage(m) { wouldSend.push({ kind: "My Day task", title: `${m.refill ? "Refill request" : m.topic || `Message for the ${m.target}`}: "${String(m.text).slice(0, 60)}"` }); return { ok: true, to: m.refill ? "the prescribing team" : "the office staff" }; },
    async flagUrgent(m) { wouldSend.push({ kind: "Crisis alert + urgent task", title: m.kind }); return { ok: true, alertId: "sim" }; },
    async reportSafety() { wouldSend.push({ kind: "Information-safety task", title: "privacy review" }); return true; },
  };
  return deps;
}

const T = (say, expect = {}) => ({ say, expect });
const D = (digits, expect = {}) => ({ digits, expect });

export const SCENARIOS = [
  { id: "new-patient", title: "New patient scheduling", from: UNKNOWN, turns: [T("Can you schedule an appointment?", { intent: "schedule", say: /I can help with that/ })] },
  { id: "existing-schedule", title: "Existing patient scheduling", from: PATIENT, turns: [T("I need an appointment.", { intent: "schedule", action: "gather" }), D("03051980", { verified: true, say: /I have Wednesday/ }), T("the second one", { say: /book Thursday/, task: true })] },
  { id: "reschedule", title: "Reschedule", from: PATIENT, turns: [T("Can I change my appointment?", { intent: "reschedule" }), D("03051980", { say: /I have/ }), T("Thursday -- actually Wednesday would be better", { say: /move your appointment to Wednesday/ })] },
  { id: "cancel", title: "Cancellation", from: PATIENT, turns: [T("Cancel tomorrow.", { intent: "cancel" }), D("03051980", { say: /Just to confirm/ }), T("yes", { say: /sent the cancellation/, task: true })] },
  { id: "when", title: "Patient asks when the appointment is", from: PATIENT, turns: [T("What time am I scheduled?", { intent: "next_appt" }), D("03051980", { say: /Tuesday, October 13 at 10 AM/, disclosed: true })] },
  { id: "lang-switch", title: "Patient changes language", from: PATIENT, turns: [T("Español", { lang: "es" }), T("English please.", { lang: "en", say: /continue in English/ }), T("Spanish please", { lang: "es" }), T("English.", { lang: "en" })] },
  { id: "spanish-caller", title: "Spanish caller", from: SPANISH_PATIENT, turns: [T("Hola, necesito una cita", { lang: "es" }), T("necesito una cita", { intent: "schedule", lang: "es" })] },
  { id: "languages", title: "Caller asks what languages are supported", from: UNKNOWN, turns: [T("What languages do you speak?", { say: /English and Spanish/ }), T("Can you please switch to Punjabi?", { say: /support English and Spanish/ }), T("Can you please switch languages?", { lang: "es" })] },
  { id: "refill", title: "Refill request", from: PATIENT, turns: [T("I need my Lexapro refilled", { intent: "refill" }), D("03051980", { say: /name of the medication/ }), T("escitalopram 10, Walgreens, out tomorrow. that's all", { say: /refill request/, task: true, notSay: /approved|will be refilled/i })] },
  { id: "side-effect", title: "Medication side-effect message", from: PATIENT, turns: [T("I'm dizzy from the new medication", { intent: "message_provider" })] },
  { id: "clinical", title: "Asks for a diagnosis (understood, not authorized)", from: LAWYER, turns: [T("Tell me what diagnosis John Smith has", { intent: "clinical_info", say: /I understand what you're asking for, but I'm not able to provide clinical information/ })] },
  { id: "attorney", title: "Attorney (allowed office) calls", from: LAWYER, turns: [T("When is the next appointment?", { say: /client's date of birth/ }), D("01021990", { verified: true, say: /Bo's next appointment/ })] },
  { id: "unknown-phi", title: "Unknown number asks for patient details", from: UNKNOWN, turns: [T("When is my wife's appointment?", { say: /I understand what you're asking for/, notSay: /Tuesday/ })] },
  { id: "wrong-dob", title: "Wrong DOB", from: PATIENT, turns: [T("When is my appointment?"), D("11111111", { verified: false }), D("22222222", { verified: false, notSay: /Tuesday/ })] },
  { id: "human", title: "Caller says 'human'", from: PATIENT, turns: [T("Talk to someone.", { say: /take a message/ })] },
  { id: "start-over", title: "Start over", from: PATIENT, turns: [T("I want to leave a message for the office"), T("Start over.", { say: /start over/ })] },
  { id: "two-things", title: "Caller asks two things", from: PATIENT, turns: [T("Move my appointment to Thursday, and I also need a refill", { intent: "reschedule" }), D("03051980", { say: /I have/ }), T("Thursday", { say: /also mentioned your refill/ })] },
  { id: "angry", title: "Angry caller (not a crisis)", from: PATIENT, turns: [T("This whole thing is fucking ridiculous, nobody ever calls me back", { notSay: /9 8 8|crisis/i })] },
  { id: "confused", title: "Unclear caller (never gives up after two misses)", from: PATIENT, turns: [T("purple elephants", { say: /appointment, a medication, or something else/ }), T("bananas"), T("kiwis", { say: /representative/ })] },
  { id: "ai-question", title: "Are you a person?", from: PATIENT, turns: [T("Are you a person?", { say: /automated assistant/ })] },
  { id: "suicidal", title: "Suicidal caller", from: PATIENT, turns: [T("I want to kill myself", { say: /I'm glad you told me/, task: true })] },
  { id: "suicidal-mid", title: "Caller becomes suicidal halfway through an ordinary call", from: PATIENT, turns: [T("I need to reschedule"), T("honestly I don't want to live anymore", { say: /concerned about your safety/, task: true })] },
  { id: "dont-cancel", title: "Caller changes their mind (don't cancel)", from: PATIENT, turns: [T("Don't cancel Tuesday", { say: /won't cancel anything/, notTask: true })] },
];

export async function runScenario(sc, practiceName = "The Psychiatry Group") {
  const log = [];
  const deps = fakePractice(log, practiceName);
  let out = await startConversation({ from: sc.from }, deps);
  const rows = [{ heard: "(call answered)", reply: out.say, lang: out.state.lg, pass: true }];
  let pass = true;
  for (const turn of sc.turns) {
    const before = { tasks: deps.wouldSend.length, ok: Boolean(out.state.ok) };
    log.length = 0;
    const input = turn.say ? { speech: turn.say } : turn.digits ? { digits: turn.digits } : { key: turn.key };
    out = await continueConversation(out.state, input, deps);
    const st = out.state;
    const newTasks = deps.wouldSend.slice(before.tasks);
    const e = turn.expect || {};
    const fails = [];
    if (e.intent && st.li !== e.intent) fails.push(`intent ${st.li || "none"} ≠ ${e.intent}`);
    if (e.lang && st.lg !== e.lang) fails.push(`language ${st.lg} ≠ ${e.lang}`);
    if (e.say && !e.say.test(out.say)) fails.push(`reply didn't match ${e.say}`);
    if (e.notSay && e.notSay.test(out.say)) fails.push(`reply must not match ${e.notSay}`);
    if (e.verified !== undefined && Boolean(st.ok) !== e.verified) fails.push(`verified ${Boolean(st.ok)} ≠ ${e.verified}`);
    if (e.action && out.action !== e.action) fails.push(`action ${out.action} ≠ ${e.action}`);
    if (e.task && !newTasks.length) fails.push("expected a task for staff");
    if (e.notTask && newTasks.length) fails.push("no task expected");
    if (e.disclosed && !(st.d || []).some((x) => /appt|info-|case-status/.test(x))) fails.push("expected information to be given");
    if (fails.length) pass = false;
    rows.push({
      heard: turn.say || (turn.digits ? `(keyed ${"•".repeat(turn.digits.length)})` : `(pressed ${turn.key})`),
      lang: st.lg,
      intent: st.li || "",
      understoodBy: st.ls || "",
      patientMatched: st.k === "patient" || st.k === "party" ? "yes (by phone)" : "no",
      verified: Boolean(st.ok),
      authorization: !st.ok ? "public information only" : st.k === "party" ? "allowed office, listed client" : "own record",
      action: `${out.action}${st.s ? ` → ${st.s}` : ""}`,
      dataAccessed: [...log],
      disclosed: (st.d || []).filter((x) => /appt|info-|case-status/.test(x)).filter((x) => !before.disclosed?.includes(x)),
      chartChange: "none (requests go to staff)",
      tasks: newTasks.map((t) => `${t.kind}: ${t.title}`),
      reply: out.say,
      pass: !fails.length,
      reason: fails.join("; "),
    });
  }
  return { id: sc.id, title: sc.title, pass, rows };
}

export async function runAllScenarios(ids = null, practiceName) {
  const list = ids ? SCENARIOS.filter((s) => ids.includes(s.id)) : SCENARIOS;
  const results = [];
  for (const sc of list) results.push(await runScenario(sc, practiceName));
  return results;
}
