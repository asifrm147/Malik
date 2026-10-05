import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, downloadReport } from '../api.js';
import { getTokens, startLogin } from '../auth.js';
import { useT, fmtDate, fmtDateTime } from '../i18n.js';
import { TopBar, ErrorBox, StageTimeline, StatusPill, HoldCard, ReportBox, Checklist, Documents, Updates, Prefs, Requests, scrollTo } from '../components/shared.jsx';

export function Account() {
  const nav = useNavigate();
  const [q] = useSearchParams();
  const { t, setLang } = useT();
  const [me, setMe] = useState(null); const [err, setErr] = useState(null); const [role, setRole] = useState(null);
  const load = useCallback(() => api('/me').then(d => { setMe(d); setRole(r => r || (d.patient ? 'patient' : d.org ? 'org' : null)); }).catch(setErr), []);
  useEffect(() => { if (!getTokens()) { startLogin('/account'); return; } load(); }, [load]);
  useEffect(() => { if (me?.roles?.includes('provider') && !me.patient && !me.org) nav('/provider', { replace: true }); }, [me]);
  useEffect(() => { const l = me?.patient?.lang || me?.org?.lang; if (l) setLang(l); }, [me?.patient?.lang, me?.org?.lang]);
  const banner = q.get('payment') === 'ok' ? 'Payment received. Your appointment is confirmed.' : q.get('payment') === 'declined' ? 'Payment was not completed. Your time is held for a few more minutes; try again from your account.' : q.get('payment') === 'slot-lost' ? 'Your 15-minute hold expired and that time was taken. Please contact the office for a refund or rebooking.' : q.get('verified') === '1' ? t('idVerified') + ' ✓' : q.get('verified') === 'incomplete' ? 'ID.me could not complete verification. You can try again, or Dr. Malik can check your photo ID at the start of the visit.' : null;
  if (err) return <><TopBar /><main className="wrap"><ErrorBox error={err} /></main></>;
  if (!me) return <><TopBar /><main className="wrap"><p>Loading…</p></main></>;
  if (!me.patient && !me.org) return <><TopBar /><main className="wrap" style={{ maxWidth: 640 }}><h1>Welcome</h1><div className="card"><p>Your account was created. If you registered as a law firm, insurer or employer, Dr. Malik’s office will approve your account and link it to your organization. You will be able to sign in once that is done.</p><p>If you are a patient, start by booking a consultation.</p><button className="btn" onClick={() => nav('/book')}>Book a consultation</button></div></main></>;
  return (
    <>
      <TopBar />
      <main className="wrap">
        {me.patient && me.org && <div className="row wrapflex" style={{ marginBottom: 12 }}><button className={`btn sm ${role === 'patient' ? '' : 'sec'}`} onClick={() => setRole('patient')}>Patient</button><button className={`btn sm ${role === 'org' ? '' : 'sec'}`} onClick={() => setRole('org')}>Organization</button></div>}
        {banner && <div className="note" role="status">{banner}</div>}
        {role === 'patient' ? <PatientView data={me.patient} reload={load} /> : <OrgView data={me.org} reload={load} />}
      </main>
    </>
  );
}

function verify(setErr) { api('/idme/start').then(r => window.location.assign(r.url)).catch(setErr); }

function PatientView({ data, reload }) {
  const nav = useNavigate();
  const { t, lang } = useT();
  const [err, setErr] = useState(null);
  const now = Date.now();
  const cases = data.cases;
  const c = cases.find(x => !(x.stage === 5 && x.report)) || cases[cases.length - 1];
  const appt = c?.appointments?.filter(a => a.status === 'Booked' && new Date(a.start).getTime() + 2 * 3600000 > now).sort((a, b) => a.start.localeCompare(b.start))[0];
  const verified = data.idStatus === 'Verified';
  let ns;
  if (!c) ns = [t('ns_book'), t('ns_bookD'), t('ns_book'), () => nav('/book')];
  else if (c.hold && !c.hold.receivedAt) ns = [t('ns_hold'), c.hold.what, t('submitInfo'), () => scrollTo(`hold-${c.id}`)];
  else if (appt && !verified) ns = [t('ns_verify'), t('ns_verifyD'), t('verifyBtn'), () => verify(setErr)];
  else if (c.checklist.some(i => i.status !== 'Submitted')) ns = [t('ns_paper'), t('ns_paperD', { n: c.checklist.filter(i => i.status !== 'Submitted').length }), t('cont'), () => scrollTo(`prep-${c.id}`)];
  else if (appt) ns = [t('ns_join'), `${fmtDateTime(appt.start, lang)}. ${t('ns_joinD')}`, t('join'), () => nav(`/visit/${appt.id}`)];
  else if (c.report) ns = [t('ns_dl'), t('ns_dlD', { v: c.report.version, d: fmtDate(c.report.releasedAt, lang) }), t('dl'), () => downloadReport(c.report.versionId).catch(setErr)];
  else if (c.hold?.receivedAt) ns = [t('ns_recv'), t('ns_recvD')];
  else ns = [t('ns_wait'), t('ns_waitD')];
  return (
    <>
      <h1>{t('welcome')}</h1>
      <section className="next" aria-live="polite"><div className="k">{t('next')}</div><h2>{ns[0]}</h2><p>{ns[1]}</p>{ns[2] && <button className="btn light" onClick={ns[3]}>{ns[2]}</button>}</section>
      <ErrorBox error={err} />
      {c && <div className="grid"><div>
        {appt && <div className="card"><h2>{t('appt')}</h2><p style={{ color: 'var(--ink)', fontWeight: 600, fontSize: 18 }}>{fmtDateTime(appt.start, lang)}</p><p>{t('apptLen', { m: appt.minutes || 50 })}</p>
          <div className="row wrapflex"><button className="btn" onClick={() => nav(`/visit/${appt.id}`)}>{t('join')}</button>{verified ? <span className="pill done">✓ {t('idVerified')}</span> : <button className="btn sec" onClick={() => verify(setErr)}>{t('verifyBtn')}</button>}</div></div>}
        <div className="card"><div className="row"><h2>{t('status')}</h2><StatusPill c={c} /></div><HoldCard c={c} onUpload={reload} /><StageTimeline c={c} /><ReportBox c={c} kind="patient" /></div>
        <Checklist c={c} onChange={reload} />
        <Documents c={c} onChange={reload} />
      </div><aside>
        <Updates notes={data.notifications} onRead={reload} />
        <Prefs initial={{ emailOn: data.emailOn, reminders: data.reminders }} showReminders />
        <Requests onSchedule={() => nav('/book')} onReport={() => c.report ? downloadReport(c.report.versionId).catch(setErr) : scrollTo('updates')} onSubmitInfo={() => scrollTo(c.hold ? `hold-${c.id}` : `prep-${c.id}`)} />
      </aside></div>}
    </>
  );
}

function OrgView({ data, reload }) {
  const { t, lang } = useT();
  const [sel, setSel] = useState(data.cases[data.cases.length - 1]?.id || null);
  const [showNew, setShowNew] = useState(false); const [err, setErr] = useState(null);
  const c = data.cases.find(x => x.id === sel);
  let ns;
  if (!data.linked) ns = [t('ns_wait'), t('notLinked')];
  else if (!c) ns = [t('newReq'), '', t('newReq'), () => setShowNew(true)];
  else if (!c.paid) ns = [t('ns_pay'), t('ns_payD'), t('ns_pay'), () => api(`/cases/${c.id}/checkout`, { method: 'POST' }).then(r => window.location.assign(r.checkoutUrl)).catch(setErr)];
  else if (c.hold && !c.hold.receivedAt) ns = [t('ns_hold'), c.hold.what, t('submitInfo'), () => scrollTo(`hold-${c.id}`)];
  else if (c.checklist.some(i => i.status !== 'Submitted')) ns = [t('ns_paper'), t('ns_paperD', { n: c.checklist.filter(i => i.status !== 'Submitted').length }), t('cont'), () => scrollTo(`prep-${c.id}`)];
  else if (c.report) ns = [t('ns_dl'), t('ns_dlD', { v: c.report.version, d: fmtDate(c.report.releasedAt, lang) }), t('dl'), () => downloadReport(c.report.versionId).catch(setErr)];
  else if (c.hold?.receivedAt) ns = [t('ns_recv'), t('ns_recvD')];
  else ns = [t('ns_wait'), t('ns_waitD')];
  const cols = t('caseCols');
  return (
    <>
      <div className="row wrapflex"><div><h1>{t('cases')}</h1>{data.orgName && <p>{data.orgName}</p>}</div>{data.linked && <button className="btn" onClick={() => setShowNew(true)}>{t('newReq')}</button>}</div>
      <section className="next"><div className="k">{t('next')}</div><h2>{ns[0]}</h2>{ns[1] && <p>{ns[1]}</p>}{ns[2] && <button className="btn light" onClick={ns[3]}>{ns[2]}</button>}</section>
      <ErrorBox error={err} />
      {data.cases.length > 0 && <div className="card tablewrap"><table><thead><tr>{cols.map(h => <th key={h}>{h}</th>)}</tr></thead><tbody>
        {[...data.cases].reverse().map(x => <tr key={x.id} className={x.id === sel ? 'sel' : ''} onClick={() => setSel(x.id)} style={{ cursor: 'pointer' }}>
          <td><b>#{x.number}</b><br /><span className="small muted">{x.examinee}</span></td><td>{x.type}</td><td><StatusPill c={x} /></td><td>{fmtDate(x.lastChange, lang)}</td><td>{x.hold && !x.hold.receivedAt ? x.hold.what : !x.paid ? t('ns_pay') : t('none')}</td></tr>)}
      </tbody></table></div>}
      {c && <div className="grid"><div>
        <div className="card"><div className="row"><h2>{t('status')} · #{c.number}</h2><StatusPill c={c} /></div><HoldCard c={c} onUpload={reload} /><StageTimeline c={c} /><ReportBox c={c} kind="org" /></div>
        <Checklist c={c} onChange={reload} />
        <Documents c={c} onChange={reload} />
      </div><aside>
        <Updates notes={data.notifications} onRead={reload} />
        <Prefs initial={{ emailOn: data.emailOn }} />
        <Requests onReport={() => c.report ? downloadReport(c.report.versionId).catch(setErr) : scrollTo('updates')} onSubmitInfo={() => scrollTo(c.hold ? `hold-${c.id}` : `prep-${c.id}`)} />
      </aside></div>}
      {showNew && <NewRequest onClose={() => setShowNew(false)} onDone={(id) => { setShowNew(false); reload().then(() => setSel(id)); }} />}
    </>
  );
}

function NewRequest({ onClose, onDone }) {
  const [f, setF] = useState({ type: 'Records review', examinee: '', claim: '', state: 'WA', pages: '', questions: '' });
  const [cfg, setCfg] = useState(null); const [err, setErr] = useState(null); const [busy, setBusy] = useState(false);
  useEffect(() => { api('/config').then(setCfg).catch(setErr); }, []);
  const pages = parseInt(f.pages || 0, 10) || 0;
  const review = cfg ? cfg.fees.reviewBase + Math.max(0, pages - cfg.fees.reviewIncludedPages) * cfg.fees.reviewPerPage : 0;
  const quote = cfg ? (f.type === 'IME' ? cfg.fees.ime + review : review) : 0;
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  async function submit() {
    setBusy(true); setErr(null);
    try { const r = await api('/org/cases', { method: 'POST', body: { ...f, pages } }); onDone(r.caseId); window.location.assign(r.checkoutUrl); } catch (e) { setErr(e); setBusy(false); }
  }
  return (
    <div className="modal" role="dialog" aria-modal="true"><div className="sheet">
      <div className="row"><h2>New request</h2><button className="btn sec sm" onClick={onClose}>Close</button></div>
      <label>Service</label><select value={f.type} onChange={set('type')}><option>Records review</option><option value="IME">Independent medical examination (IME)</option></select>
      <label>Examinee name</label><input value={f.examinee} onChange={set('examinee')} />
      <label>Claim or case number</label><input value={f.claim} onChange={set('claim')} />
      <label>Jurisdiction</label><select value={f.state} onChange={set('state')}><option value="CA">California</option><option value="ID">Idaho</option><option value="PA">Pennsylvania</option><option value="WA">Washington</option><option value="other">Other (review required)</option></select>
      <label>Approximate record pages</label><input inputMode="numeric" value={f.pages} onChange={set('pages')} />
      <label>Referral questions</label><textarea value={f.questions} onChange={set('questions')} />
      {cfg && <div className="note">Quote: <b>${quote.toFixed(2)}</b>. Records review ${cfg.fees.reviewBase} covers up to {cfg.fees.reviewIncludedPages} pages, then ${cfg.fees.reviewPerPage.toFixed(2)} per page.{f.type === 'IME' && ` IME $${cfg.fees.ime} plus the records review.`} Final page count is confirmed after records arrive.</div>}
      <ErrorBox error={err} />
      <button className="btn full" disabled={busy || !f.examinee} onClick={submit}>{busy ? 'Submitting…' : 'Submit and pay'}</button>
      {cfg?.testMode.payments && <div className="test">Payments are in test mode.</div>}
    </div></div>
  );
}
