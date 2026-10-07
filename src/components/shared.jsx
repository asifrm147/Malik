import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, uploadAsset, downloadReport } from '../api.js';
import { logout } from '../auth.js';
import { useT, fmtDate } from '../i18n.js';

export function TopBar({ title = 'Asif Malik, MD', showLang = true, signedIn = true }) {
  const { t, lang, setLang } = useT();
  return (
    <header className="top">
      <Link to="/" className="brand"><span className="mark">AM</span><span><b>{title}</b><small>Psychiatry & independent review</small></span></Link>
      <div className="topacts">
        {showLang && <button className="btn sec sm" onClick={() => setLang(lang === 'en' ? 'es' : 'en')}>{t('language')}</button>}
        {signedIn && <button className="btn sec sm" onClick={logout}>{t('signOut')}</button>}
      </div>
    </header>
  );
}

export const ErrorBox = ({ error }) => error ? <div className="err" role="alert">{String(error.message || error)}</div> : null;

export function StageTimeline({ c }) {
  const { t, stages, lang } = useT();
  return (
    <ol className="tl">
      {stages.map(([name, desc], i) => {
        const done = i < c.stage || (i === 5 && c.stage === 5);
        const cur = i === c.stage && !done;
        const cls = done ? 'done' : cur ? (c.hold ? 'warn' : 'cur') : '';
        const pill = done ? <span className="pill done">✓ {t('done')}</span> : cur ? (c.hold ? <span className="pill warn">! {t('onHold')}</span> : <span className="pill cur">● {t('current')}</span>) : <span className="pill none">{t('notStarted')}</span>;
        const ev = c.timeline?.filter(e => e.type === 'Status change' && e.detail === stagesEn(i)).pop();
        return <li key={i} className={cls}><span className="mk" aria-hidden>{done ? '✓' : cls === 'warn' ? '!' : i + 1}</span><div><b>{name}</b><small>{desc}</small>{pill}{ev?.at && <small>{fmtDate(ev.at, lang)}</small>}</div></li>;
      })}
    </ol>
  );
}
const EN = ['Awaiting appointment / review', 'Report in preparation', 'Dictated', 'Proofed and compiled', 'In quality control', 'Ready for download'];
const stagesEn = (i) => EN[i];

export function StatusPill({ c }) {
  const { t, stages } = useT();
  if (c.hold) return <span className="pill warn">! {t('onHold')}</span>;
  return <span className={`pill ${c.stage === 5 ? 'done' : 'cur'}`}>{stages[c.stage][0]}</span>;
}

export function HoldCard({ c, onUpload }) {
  const { t, stages, lang } = useT();
  if (!c.hold) return null;
  return (
    <div className="hold" id={`hold-${c.id}`}>
      <span className="pill warn">! {t('onHold')}</span>
      <h3 className="mt">{t('holdT')}</h3>
      <dl><dt>{t('what')}</dt><dd>{c.hold.what}</dd><dt>{t('who')}</dt><dd>{c.hold.who}</dd><dt>{t('how')}</dt><dd>{c.hold.how}</dd></dl>
      <p>{t('holdStage', { s: stages[c.stage][0] })}</p>
      {c.hold.receivedAt ? <p style={{ color: 'var(--done)', fontWeight: 600 }}>✓ {t('holdRecv', { d: fmtDate(c.hold.receivedAt, lang) })}</p>
        : <UploadButton caseId={c.id} answersHold label={t('submitInfo')} onDone={onUpload} />}
    </div>
  );
}

export function ReportBox({ c, kind }) {
  const { t, lang } = useT();
  const [err, setErr] = useState(null);
  return (
    <div className="card" style={{ background: '#fbfcfa' }}>
      <h3>{t('yourReport')}</h3>
      {c.report ? <>
        <p>{t('ver', { v: c.report.version, d: fmtDate(c.report.releasedAt, lang) })} · <span className="pill done">{t('curVer')}</span></p>
        <button className="btn" onClick={() => downloadReport(c.report.versionId).catch(setErr)}>{t('dl')}</button>
      </> : <p>{t('notRel')}</p>}
      <ErrorBox error={err} />
      <p className="small mt">{kind === 'org' ? t('accessO') : t('accessP')}</p>
    </div>
  );
}

// Simple, structured forms per checklist item. Answers save as drafts and lock on submit.
const FORMS = {
  'Telehealth consent': [{ k: 'agree', type: 'check', en: 'I consent to a one-time telehealth consultation with Dr. Malik and understand its limits.', es: 'Doy mi consentimiento para una consulta única de telesalud con el Dr. Malik y entiendo sus límites.' }, { k: 'signature', en: 'Type your full name as your signature', es: 'Escriba su nombre completo como firma' }],
  'Health history': [{ k: 'concern', type: 'area', en: 'What would you like help with?', es: '¿Con qué le gustaría recibir ayuda?' }, { k: 'history', type: 'area', en: 'Past mental health treatment, hospitalizations, diagnoses', es: 'Tratamiento de salud mental previo, hospitalizaciones, diagnósticos' }, { k: 'medical', type: 'area', en: 'Medical conditions and allergies', es: 'Condiciones médicas y alergias' }],
  'Medication list': [{ k: 'meds', type: 'area', en: 'Every medicine you take, with dose if you know it', es: 'Todos los medicamentos que toma, con la dosis si la sabe' }, { k: 'pharmacy', en: 'Preferred pharmacy (name and city)', es: 'Farmacia preferida (nombre y ciudad)' }],
  'Release to your PCP': [{ k: 'pcp', en: 'Primary care clinician name', es: 'Nombre de su médico de cabecera' }, { k: 'fax', en: 'Their fax or secure email', es: 'Su fax o correo seguro' }, { k: 'agree', type: 'check', en: 'I authorize Dr. Malik to send my consultation plan to this clinician.', es: 'Autorizo al Dr. Malik a enviar mi plan de consulta a este médico.' }, { k: 'signature', en: 'Type your full name as your signature', es: 'Escriba su nombre completo como firma' }],
  'Engagement letter': [{ k: 'agree', type: 'check', en: 'We accept the scope, fee and delivery terms for this case.', es: 'Aceptamos el alcance, la tarifa y los plazos de este caso.' }, { k: 'signature', en: 'Authorized signer full name and title', es: 'Nombre completo y cargo del firmante autorizado' }],
  'Referral questions': [{ k: 'questions', type: 'area', en: 'The exact questions the report must answer', es: 'Las preguntas exactas que el informe debe responder' }],
  'Authorization to release': [{ k: 'recipients', type: 'area', en: 'Who may receive the final report (names and roles)', es: 'Quién puede recibir el informe final (nombres y cargos)' }, { k: 'signature', en: 'Authorized signer full name', es: 'Nombre completo del firmante autorizado' }],
};

export function Checklist({ c, onChange }) {
  const { t, lang } = useT();
  const [open, setOpen] = useState(null);
  const done = c.checklist.filter(i => i.status === 'Submitted').length;
  return (
    <div className="card" id={`prep-${c.id}`}>
      <div className="row"><h2>{t('prep')}</h2><span className={`pill ${done === c.checklist.length ? 'done' : 'warn'}`}>{t('count', { a: done, b: c.checklist.length })}</span></div>
      <ul className="list">
        {c.checklist.map(i => (
          <li key={i.id}>
            <span>{lang === 'es' ? i.nameEs || i.name : i.name}<small>{i.status === 'Submitted' ? '✓ ' + t('submitted', { d: fmtDate(i.at, lang) }) : i.status === 'Saved' ? t('saved') : t('notStarted')}</small></span>
            {i.status === 'Submitted' ? <span className="pill done">✓ {t('done')}</span> : <button className={`btn sm ${i.status === 'Saved' ? '' : 'sec'}`} onClick={() => setOpen(i)}>{i.status === 'Saved' ? t('cont') : t('start')}</button>}
          </li>
        ))}
      </ul>
      {open && <ItemForm item={open} onClose={() => setOpen(null)} onDone={() => { setOpen(null); onChange(); }} />}
    </div>
  );
}

function ItemForm({ item, onClose, onDone }) {
  const { t, lang } = useT();
  const fields = FORMS[item.name] || [{ k: 'notes', type: 'area', en: 'Details', es: 'Detalles' }];
  const [data, setData] = useState(() => { try { return JSON.parse(item.data || '{}'); } catch { return {}; } });
  const [err, setErr] = useState(null); const [busy, setBusy] = useState(false);
  const set = (k, v) => setData(d => ({ ...d, [k]: v }));
  const complete = fields.every(f => f.type === 'check' ? data[f.k] === true : String(data[f.k] || '').trim().length > 0);
  async function send(action) {
    setBusy(true); setErr(null);
    try { await api(`/checklist/${item.id}`, { method: 'POST', body: { action, data } }); onDone(); } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label={item.name}>
      <div className="sheet">
        <div className="row"><h2>{lang === 'es' ? item.nameEs || item.name : item.name}</h2><button className="btn sec sm" onClick={onClose}>{t('close')}</button></div>
        {fields.map(f => f.type === 'check'
          ? <label key={f.k} className="check"><input type="checkbox" checked={data[f.k] === true} onChange={e => set(f.k, e.target.checked)} />{f[lang] || f.en}</label>
          : <div key={f.k}><label htmlFor={f.k}>{f[lang] || f.en}</label>{f.type === 'area' ? <textarea id={f.k} value={data[f.k] || ''} onChange={e => set(f.k, e.target.value)} /> : <input id={f.k} value={data[f.k] || ''} onChange={e => set(f.k, e.target.value)} />}</div>)}
        <ErrorBox error={err} />
        <div className="row wrapflex mt"><button className="btn sec" disabled={busy} onClick={() => send('save')}>{t('saveDraft')}</button><button className="btn" disabled={busy || !complete} onClick={() => send('submit')}>{t('submit')}</button></div>
      </div>
    </div>
  );
}

export function UploadButton({ caseId, answersHold = false, label, onDone }) {
  const { t } = useT();
  const [busy, setBusy] = useState(false); const [err, setErr] = useState(null); const [ok, setOk] = useState(null);
  async function pick(e) {
    const file = e.target.files?.[0]; e.target.value = '';
    if (!file) return;
    setBusy(true); setErr(null); setOk(null);
    try {
      const assetId = await uploadAsset(file);
      const { receipt } = await api('/documents', { method: 'POST', body: { caseId, assetId, fileName: file.name, answersHold } });
      setOk(`${t('received')} · ${t('receipt')} ${receipt}`); onDone?.();
    } catch (e2) { setErr(e2); } finally { setBusy(false); }
  }
  return (
    <div>
      <label className="btn" style={{ margin: 0, width: 'fit-content' }}>{busy ? t('uploading') : label || t('choose')}<input type="file" hidden onChange={pick} disabled={busy} accept=".pdf,.jpg,.jpeg,.png,.doc,.docx,.tif,.tiff" /></label>
      {ok && <p style={{ color: 'var(--done)', fontWeight: 600, marginTop: 8 }}>✓ {ok}</p>}
      <ErrorBox error={err} />
    </div>
  );
}

export function Documents({ c, onChange }) {
  const { t, lang } = useT();
  return (
    <div className="card">
      <h2>{t('docs')}</h2><p>{t('docsP')}</p>
      <UploadButton caseId={c.id} onDone={onChange} />
      <ul className="list">{c.documents.length ? c.documents.map(d => <li key={d.id}><span>{d.name}<small>{fmtDate(d.at, lang)} · {t('receipt')} {d.receipt}</small></span><span className="pill done">✓ {t('received')}</span></li>) : <li>{t('noDocs')}</li>}</ul>
    </div>
  );
}

export function Updates({ notes, onRead }) {
  const { t, lang } = useT();
  const unread = notes.filter(n => !n.read);
  return (
    <div className="card" id="updates">
      <div className="row"><h2>{t('updates')}{unread.length ? ` (${unread.length})` : ''}</h2>{unread.length > 0 && <button className="btn sec sm" onClick={() => api('/notifications/read', { method: 'POST', body: { ids: unread.map(n => n.id) } }).then(onRead)}>{t('markRead')}</button>}</div>
      <ul className="list">{notes.length ? notes.slice(0, 12).map(n => <li key={n.id} style={{ fontWeight: n.read ? 400 : 650 }}><span>{lang === 'es' ? n.es : n.en}<small>{fmtDate(n.at, lang)}</small></span></li>) : <li>{t('noUpdates')}</li>}</ul>
    </div>
  );
}

export function Prefs({ initial, showReminders }) {
  const { t, lang } = useT();
  const [p, setP] = useState(initial); const [msg, setMsg] = useState(null); const [err, setErr] = useState(null);
  return (
    <div className="card">
      <h2>{t('email')}</h2>
      <label className="check"><input type="checkbox" checked={p.emailOn} onChange={e => setP({ ...p, emailOn: e.target.checked })} />{t('emailOn')}</label>
      {showReminders && <label className="check"><input type="checkbox" checked={p.reminders} onChange={e => setP({ ...p, reminders: e.target.checked })} />{t('reminders')}</label>}
      <button className="btn sm" onClick={() => api('/prefs', { method: 'POST', body: { ...p, lang } }).then(() => setMsg(t('saved2'))).catch(setErr)}>{t('save')}</button>
      {msg && <p style={{ color: 'var(--done)', marginTop: 8 }}>{msg}</p>}<ErrorBox error={err} />
      <div className="note">{t('emailNote')}</div>
    </div>
  );
}

export function Requests({ onSchedule, onReport, onSubmitInfo }) {
  const { t } = useT();
  return (
    <div className="card">
      <h2>{t('need')}</h2>
      <div style={{ display: 'grid', gap: 8 }}>
        {onSchedule && <button className="btn sec full" onClick={onSchedule}>{t('aSched')}</button>}
        <button className="btn sec full" onClick={onReport}>{t('aReport')}</button>
        <button className="btn sec full" onClick={onSubmitInfo}>{t('aSubmit')}</button>
      </div>
      <p className="small mt">{t('safety')}</p>
    </div>
  );
}

export const scrollTo = (id) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

// Shown while PORTAL_BOOKING_OPEN isn't "true" on the server (2026-10-07).
export function ComingSoon({ providerLink = false }) {
  return (
    <>
      <TopBar signedIn={false} showLang={false} />
      <main className="wrap" style={{ maxWidth: 640 }}>
        <h1>The secure portal opens soon.</h1>
        <p>Online booking, the case portal for insurers, employers and attorneys, and patient accounts are being finished now.</p>
        <div className="card">
          <h2>Book a consultation or send a review request now</h2>
          <p>Email Dr. Malik, and you’ll get a reply with available Monday times or a quote and next steps.</p>
          <p><a href="mailto:asif.malik@psychiatrygroup.com?subject=Consultation%20or%20review%20request"><b>asif.malik@psychiatrygroup.com</b></a></p>
          <p className="small"><b>Please don’t include medical details, records or identification in email.</b> Regular email isn’t secure.</p>
        </div>
        <p className="small">Emergencies: call 911. Crisis: call or text 988.</p>
        {providerLink && <p className="small mt"><a href="/login?provider=1">Provider sign-in</a></p>}
      </main>
    </>
  );
}
