// Workspace → Phone assistant (pilot, 2026-10-07): setup, who may call, and a
// pretend call that uses real data but saves nothing. See api/voice.js.
import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { ErrorBox } from '../components/shared.jsx';

const Recognition = typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;
const Ok = ({ on, children }) => <li><b style={{ color: on ? '#2e7d32' : '#c62828' }}>{on ? 'Ready' : 'Not set'}</b> · {children}</li>;

export function PhoneAssistant() {
  const [info, setInfo] = useState(null); const [err, setErr] = useState(null);
  useEffect(() => { api('/voice/status').then(setInfo).catch(setErr); }, []);
  if (!info) return <div className="card"><p>Loading…</p><ErrorBox error={err} /></div>;
  return (
    <>
      <div className="card">
        <h2>Phone assistant <span className="pill cur">Pilot</span></h2>
        <p className="small">Callers hear that it's an automated assistant and that the call is transcribed, then say what they need. Anyone can hear the office information below and leave a message. Case details need the phone number on file plus the patient's date of birth (or, for an approved firm, the case number) -- and nothing is said that would confirm someone is a patient before that. Crisis words get 911 / 988 and an urgent alert; threats toward someone else are flagged for you at once.</p>
        <ul className="small" style={{ paddingLeft: 18 }}>
          <Ok on={info.enabled}>Answering calls (VOICE_ATTENDANT_ON=true)</Ok>
          <Ok on={info.setup.telnyx}>Telnyx (TELNYX_API_KEY)</Ok>
          <Ok on={info.setup.signatures}>Telnyx signature checks (TELNYX_PUBLIC_KEY). Required: real calls are ignored without it.</Ok>
          <Ok on={info.setup.ai}>AI understanding (Azure OpenAI). Without it, keyword matching is used.</Ok>
          <Ok on={info.setup.email}>Email alert for new messages (RESEND_API_KEY and VOICE_ALERT_EMAIL)</Ok>
          <Ok on={Boolean(info.transferNumber)}>Transfer to a person (VOICE_TRANSFER_NUMBER){info.transferNumber ? `: ${info.transferNumber}` : ': without it, callers leave a message instead'}</Ok>
          <li>In Telnyx, create a Call Control application with webhook <code>{info.setup.webhookUrl}</code>, and assign the practice number to it.</li>
        </ul>
        <h3>Office information callers can hear</h3>
        <p className="small">Set in Vercel. A blank line means the assistant offers to take a message instead.</p>
        <ul className="small" style={{ paddingLeft: 18 }}>
          <li>Hours (VOICE_HOURS): {info.info.hours || <i>not set</i>}</li>
          <li>Address (VOICE_ADDRESS): {info.info.address || <i>not set</i>}</li>
          <li>Fax (VOICE_FAX): {info.info.fax || <i>not set</i>}</li>
          <li>New patients (VOICE_NEW_PATIENTS): {info.info.newPatients || <i>not set</i>}</li>
        </ul>
        <h3>Firms that may call</h3>
        <p className="small">Only linked organization users whose phone number is also listed in VOICE_ALLOWED_NUMBERS (comma-separated, in Vercel). Add a number only with a signed release on file.</p>
        {!info.callers.length ? <p className="small muted">No linked organization users yet.</p> :
          <ul className="list">{info.callers.map((c, i) => <li key={i}><span><b>{c.name}</b><small>{c.org} · {c.phone || 'no phone on file'}</small></span>{c.allowed ? <span className="pill done">Allowed</span> : <span className="pill warn">Not allowed</span>}</li>)}</ul>}
      </div>
      <Messages />
      <TryIt />
    </>
  );
}

// Every phone message and urgent call, case or no case (1.8.0).
function Messages() {
  const [rows, setRows] = useState(null); const [err, setErr] = useState(null);
  useEffect(() => { api('/voice/messages').then(r => setRows(r.messages)).catch(setErr); }, []);
  return (
    <div className="card">
      <h2>Phone messages</h2>
      <p className="small">Last 60 days. Messages from callers who weren't verified aren't linked to a case -- check who it is before discussing anything.</p>
      <ErrorBox error={err} />
      {!rows ? <p>Loading…</p> : !rows.length ? <p className="small muted">No phone messages yet.</p> :
        <ul className="list">{rows.map(m => <li key={m.id} style={{ flexDirection: 'column', alignItems: 'flex-start' }}>
          <span><b>{m.type}</b>{m.caseNumber ? ` · Case ${m.caseNumber}` : ' · no case (not verified)'} <span className="small muted">{m.at ? new Date(m.at).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''}</span></span>
          <small style={{ whiteSpace: 'pre-wrap' }}>{m.detail}</small>
        </li>)}</ul>}
    </div>
  );
}

function TryIt() {
  const [from, setFrom] = useState(''); const [call, setCall] = useState(null); const [lines, setLines] = useState([]);
  const [would, setWould] = useState([]); const [text, setText] = useState(''); const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null); const [voice, setVoice] = useState(true); const [listening, setListening] = useState(false);
  const recRef = useRef(null);
  useEffect(() => () => { try { recRef.current?.stop(); } catch { /* ignore */ } window.speechSynthesis?.cancel(); }, []);

  const speak = (s) => { if (voice && s && window.speechSynthesis) { window.speechSynthesis.cancel(); window.speechSynthesis.speak(new SpeechSynthesisUtterance(s)); } };
  const turn = async (body, said) => {
    setBusy(true); setErr(null);
    if (said) setLines(l => [...l, { who: 'Caller', text: said }]);
    try {
      const out = await api('/voice/simulate', { method: 'POST', body });
      if (out.say) setLines(l => [...l, { who: 'Assistant', text: out.say }]);
      if (out.wouldSend?.length) setWould(w => [...w, ...out.wouldSend]);
      speak(out.say);
      const over = out.action === 'hangup' || out.action === 'transfer';
      setCall(over ? null : out);
      if (out.action === 'hangup') setLines(l => [...l, { who: '', text: 'Call ended.' }]);
      if (out.action === 'transfer') setLines(l => [...l, { who: '', text: `A real call would now be transferred to ${out.to}.` }]);
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const send = (input, said) => call && turn({ token: call.token, input }, said);
  const submit = () => {
    const v = text.trim(); if (!v) return; setText('');
    if (call?.action === 'gather') send({ digits: v.replace(/\D/g, '') }, `(keys) ${v.replace(/\D/g, '')}#`); else send({ speech: v }, v);
  };
  const mic = () => {
    if (!Recognition) return;
    const r = new Recognition(); r.lang = 'en-US'; r.interimResults = false; r.continuous = false;
    r.onresult = (e) => { const s = e.results?.[0]?.[0]?.transcript || ''; if (s) send({ speech: s }, s); };
    r.onend = () => setListening(false); r.onerror = () => setListening(false);
    recRef.current = r; window.speechSynthesis?.cancel(); setListening(true); r.start();
  };
  const gathering = call?.action === 'gather';

  return (
    <div className="card">
      <h2>Try it</h2>
      <p className="small">A pretend call using real data. Nothing is saved; what a real call would have saved is shown below. Works while the assistant is off.</p>
      {!call && <div className="row wrapflex">
        <input style={{ maxWidth: 220 }} placeholder="Call from this number" value={from} onChange={e => setFrom(e.target.value)} />
        <button className="btn" disabled={busy || from.replace(/\D/g, '').length < 10} onClick={() => { setLines([{ who: '', text: `Calling from ${from}…` }]); setWould([]); turn({ from }); }}>Start test call</button>
        <label className="check" style={{ margin: 0 }}><input type="checkbox" checked={voice} onChange={e => setVoice(e.target.checked)} />Read replies aloud</label>
      </div>}
      {lines.length > 0 && <div style={{ maxHeight: 340, overflowY: 'auto', margin: '12px 0' }}>
        {lines.map((l, i) => <p key={i} className={l.who ? '' : 'small muted'} style={{ textAlign: l.who === 'Caller' ? 'right' : 'left', margin: '6px 0' }}>{l.who && <b>{l.who}: </b>}{l.text}</p>)}
      </div>}
      {call && <>
        <div className="row wrapflex">
          <input style={{ flex: '1 1 240px' }} inputMode={gathering ? 'numeric' : 'text'} value={text} disabled={busy}
            placeholder={gathering ? 'Type the digits' : call.step === 'message' ? 'Say your message (then press #)' : 'Say something, e.g. "when is my next appointment?"'}
            onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') submit(); }} />
          <button className="btn sm" disabled={busy} onClick={submit}>{gathering ? 'Enter #' : 'Say it'}</button>
          {!gathering && Recognition && <button className="btn sm sec" disabled={busy || listening} onClick={mic}>{listening ? 'Listening…' : 'Use microphone'}</button>}
          <button className="btn sm sec" onClick={() => { setCall(null); setLines(l => [...l, { who: '', text: 'You hung up.' }]); window.speechSynthesis?.cancel(); }}>Hang up</button>
        </div>
        {!gathering && <div className="row wrapflex" style={{ marginTop: 8 }}>
          {(call.step === 'message' ? ['#'] : ['1', '2', '3', '4', '5', '6', '9', '0']).map(k => <button key={k} className="btn sm sec" disabled={busy} onClick={() => send({ key: k }, `(pressed ${k})`)}>{k}</button>)}
        </div>}
      </>}
      <ErrorBox error={err} />
      {would.length > 0 && <>
        <h3>A real call would have saved</h3>
        <ul className="list">{would.map((w, i) => <li key={i} style={{ flexDirection: 'column', alignItems: 'flex-start' }}><b>{w.kind}: {w.title}</b><small style={{ whiteSpace: 'pre-wrap' }}>{w.detail}</small></li>)}</ul>
      </>}
    </div>
  );
}
