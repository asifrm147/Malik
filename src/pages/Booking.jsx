import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { getTokens, startLogin, finishLogin } from '../auth.js';
import { TopBar, ErrorBox, ComingSoon } from '../components/shared.jsx';

const PT = { timeZone: 'America/Los_Angeles' };
const dayLabel = (iso) => new Date(iso).toLocaleDateString('en-US', { ...PT, weekday: 'long', month: 'long', day: 'numeric' });
const timeLabel = (iso) => new Date(iso).toLocaleTimeString('en-US', { ...PT, hour: 'numeric', minute: '2-digit' });
const localLabel = (iso) => new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });

export function Book() {
  const nav = useNavigate();
  const [cfg, setCfg] = useState(null); const [slots, setSlots] = useState(null); const [err, setErr] = useState(null);
  const [state, setState] = useState(''); const [pick, setPick] = useState('');
  useEffect(() => { Promise.all([api('/config'), api('/slots')]).then(([c, s]) => { setCfg(c); setSlots(s.slots); }).catch(setErr); }, []);
  const byDay = useMemo(() => (slots || []).reduce((m, s) => { (m[dayLabel(s)] ||= []).push(s); return m; }, {}), [slots]);
  function go() {
    sessionStorage.setItem('booking', JSON.stringify({ start: pick, state }));
    if (getTokens()) nav('/book/confirm'); else startLogin('/book/confirm');
  }
  if (cfg && !cfg.bookingOpen) return <ComingSoon />;
  return (
    <>
      <TopBar signedIn={!!getTokens()} showLang={false} />
      <main className="wrap" style={{ maxWidth: 640 }}>
        <h1>Book a one-time consultation</h1>
        <p>A 50-minute video visit with Dr. Malik, followed by a written plan for your primary care clinician. Monday appointments only.</p>
        {cfg && <div className="note">Flat fee ${cfg.fees.consult}, paid when you book. Appointments must be booked at least {cfg.minLeadHours} hours ahead. Times are shown in Pacific time.</div>}
        <ErrorBox error={err} />
        <div className="card">
          <label htmlFor="st">Where will you physically be during the video visit?</label>
          <select id="st" value={state} onChange={e => setState(e.target.value)}>
            <option value="">Choose a state</option>
            {cfg && Object.entries(cfg.states).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            <option value="other">Somewhere else</option>
          </select>
          {state === 'other' && <div className="err">Dr. Malik is licensed in California, Idaho, Pennsylvania and Washington, and can only see you while you are physically in one of those states.</div>}
        </div>
        {state && state !== 'other' && <div className="card">
          <h2>Choose a time</h2>
          {slots === null ? <p>Loading times…</p> : !slots.length ? <p>No open times in the next 8 weeks. Please check back soon.</p> :
            Object.entries(byDay).map(([day, list]) => <div key={day}><h3 className="mt">{day}</h3><div className="slots">{list.map(s => <button key={s} className={`slot ${pick === s ? 'on' : ''}`} onClick={() => setPick(s)} aria-pressed={pick === s}>{timeLabel(s)}</button>)}</div></div>)}
          {pick && <p className="small">Your local time: {localLabel(pick)}</p>}
          <button className="btn full mt" disabled={!pick} onClick={go}>Continue — sign in or create account</button>
          <p className="small mt">Your chosen time is held for 15 minutes once you sign in.</p>
        </div>}
        <p className="small">Emergencies: call 911. Crisis: call or text 988. This service does not provide ongoing psychiatric care.</p>
      </main>
    </>
  );
}

export function BookConfirm() {
  const nav = useNavigate();
  const b = JSON.parse(sessionStorage.getItem('booking') || 'null');
  const [cfg, setCfg] = useState(null); const [err, setErr] = useState(null); const [busy, setBusy] = useState(false); const [agree, setAgree] = useState(false);
  useEffect(() => { if (!getTokens()) startLogin('/book/confirm'); api('/config').then(setCfg).catch(setErr); }, []);
  if (!b) return <><TopBar /><main className="wrap"><p>No time selected.</p><button className="btn" onClick={() => nav('/book')}>Choose a time</button></main></>;
  async function hold() {
    setBusy(true); setErr(null);
    try { const r = await api('/book/hold', { method: 'POST', body: b }); sessionStorage.removeItem('booking'); window.location.assign(r.checkoutUrl); }
    catch (e) { setErr(e); setBusy(false); }
  }
  return (
    <>
      <TopBar />
      <main className="wrap" style={{ maxWidth: 640 }}>
        <h1>Confirm and pay</h1>
        <div className="card">
          <p style={{ color: 'var(--ink)', fontSize: 19, fontWeight: 600 }}>{dayLabel(b.start)} at {timeLabel(b.start)} Pacific</p>
          <p>One-time video consultation with Asif Malik, MD · 50 minutes</p>
          {cfg && <p style={{ color: 'var(--ink)' }}><b>${cfg.fees.consult}</b> self-pay. No insurance is billed. A prescription is given only when clinically appropriate.</p>}
          <label className="check"><input type="checkbox" checked={agree} onChange={e => setAgree(e.target.checked)} />I understand this is a one-time, self-pay consultation, my primary care clinician provides follow-up, and I must verify my identity before the visit.</label>
          <ErrorBox error={err} />
          <button className="btn full" disabled={!agree || busy} onClick={hold}>{busy ? 'Holding your time…' : 'Hold this time and pay'}</button>
          {cfg?.testMode.payments && <div className="test">Payments are in test mode. No card will be charged.</div>}
        </div>
      </main>
    </>
  );
}

export function PayTest() {
  const [q] = useSearchParams();
  const go = (result) => window.location.assign(`/api/payments/return?ref=${encodeURIComponent(q.get('ref'))}&test=${result}&return=${encodeURIComponent(q.get('return') || '/account')}`);
  return (
    <><TopBar showLang={false} /><main className="wrap" style={{ maxWidth: 520 }}>
      <div className="test">Test payment page. In production this is Sphere’s secure hosted payment page.</div>
      <div className="card"><h1>${q.get('amount')}</h1><p>Reference {q.get('ref')}</p>
        <div className="row wrapflex"><button className="btn" onClick={() => go('approved')}>Approve test payment</button><button className="btn sec" onClick={() => go('declined')}>Decline</button></div></div>
    </main></>
  );
}

export function Callback() {
  const nav = useNavigate(); const [err, setErr] = useState(null);
  useEffect(() => { finishLogin(new URLSearchParams(window.location.search)).then(to => nav(to, { replace: true })).catch(setErr); }, []);
  return <main className="wrap"><p>Signing you in…</p><ErrorBox error={err} />{err && <button className="btn" onClick={() => startLogin()}>Try again</button>}</main>;
}

export function VerifyTest() {
  const [q] = useSearchParams(); const nav = useNavigate(); const [err, setErr] = useState(null);
  return (
    <><TopBar showLang={false} /><main className="wrap" style={{ maxWidth: 520 }}>
      <div className="test">ID.me is in test mode. In production this button opens ID.me’s secure verification.</div>
      <div className="card"><h1>Verify your identity</h1><p>ID.me checks your photo ID and a selfie. Dr. Malik receives only confirmation that you passed.</p>
        <button className="btn full" onClick={() => api('/idme/test-complete', { method: 'POST', body: { state: q.get('state') } }).then(() => nav('/account?verified=1')).catch(setErr)}>Complete test verification</button>
        <ErrorBox error={err} /></div>
    </main></>
  );
}
