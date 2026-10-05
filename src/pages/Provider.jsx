import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, uploadAsset } from '../api.js';
import { getTokens, startLogin } from '../auth.js';
import { TopBar, ErrorBox } from '../components/shared.jsx';

const STAGES = ['Awaiting appointment / review', 'Report in preparation', 'Dictated', 'Proofed and compiled', 'In quality control', 'Ready for download'];
const d = (iso) => iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
const pill = (c) => c.onHold || c.hold ? <span className="pill warn">! On hold{(c.holdReceived || c.hold?.receivedAt) ? ' · info received' : ''}</span> : <span className={`pill ${c.stage === 5 ? 'done' : 'cur'}`}>{STAGES[c.stage]}</span>;

export function Provider() {
  const [cases, setCases] = useState(null); const [sel, setSel] = useState(null); const [err, setErr] = useState(null); const [tab, setTab] = useState('cases');
  const load = useCallback(() => api('/provider/cases').then(r => setCases(r.cases)).catch(setErr), []);
  useEffect(() => { if (!getTokens()) { startLogin('/provider'); return; } load(); }, [load]);
  return (
    <>
      <TopBar title="Dr. Malik · Workspace" showLang={false} />
      <main className="wrap">
        <div className="row wrapflex" style={{ marginBottom: 12 }}>
          <button className={`btn sm ${tab === 'cases' ? '' : 'sec'}`} onClick={() => setTab('cases')}>Cases</button>
          <button className={`btn sm ${tab === 'orgs' ? '' : 'sec'}`} onClick={() => setTab('orgs')}>Organization users</button>
        </div>
        <ErrorBox error={err} />
        {tab === 'orgs' ? <OrgUsers /> : <>
          <div className="card tablewrap">
            <h2>Cases</h2>
            {!cases ? <p>Loading…</p> : !cases.length ? <p>No cases yet.</p> :
              <table><thead><tr><th>#</th><th>Type</th><th>Who</th><th>Status</th><th>Paid</th><th>Updated</th></tr></thead><tbody>
                {cases.map(c => <tr key={c.id} className={sel === c.id ? 'sel' : ''} onClick={() => setSel(c.id)} style={{ cursor: 'pointer' }}>
                  <td><b>{c.number}</b></td><td>{c.type}</td><td>{c.patient || c.examinee}{c.org && <><br /><span className="small muted">{c.org}</span></>}</td><td>{pill(c)}</td><td>{c.paid ? '✓' : <span className="pill warn">Unpaid</span>}</td><td className="small">{d(c.lastChange)}</td></tr>)}
              </tbody></table>}
          </div>
          {sel && <CaseControls id={sel} onChanged={load} />}
        </>}
      </main>
    </>
  );
}

function CaseControls({ id, onChanged }) {
  const nav = useNavigate();
  const [c, setC] = useState(null); const [err, setErr] = useState(null); const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState(0); const [hold, setHold] = useState({ what: '', who: 'Patient', how: 'Upload in your secure account' });
  const [rel, setRel] = useState({ file: null, includePatient: true, orgUserIds: [], approve: false, note: '' });
  const load = useCallback(() => api(`/provider/cases/${id}`).then(x => { setC(x); setStage(Math.min(x.stage, 4)); setHold(h => ({ ...h, who: x.org ? 'Requesting organization' : 'Patient' })); }).catch(setErr), [id]);
  useEffect(() => { setC(null); load(); }, [load]);
  const act = (fn) => async () => { setBusy(true); setErr(null); try { await fn(); await load(); onChanged(); } catch (e) { setErr(e); } finally { setBusy(false); } };
  if (!c) return <div className="card"><p>Loading case…</p><ErrorBox error={err} /></div>;
  const canRelease = c.stage === 4 && !c.hold;
  const appt = c.appointments.find(a => a.status === 'Booked');
  return (
    <div className="card">
      <div className="row wrapflex"><h2>Case #{c.number} · {c.type}</h2>{pill(c)}</div>
      <p>{c.patient?.identifier || c.examinee}{c.org && ` · ${c.org.identifier}`}{c.claim && ` · Claim ${c.claim}`}{c.pages ? ` · ${c.pages} pages` : ''} · Fee ${c.fee} {c.paid ? '(paid)' : '(unpaid)'}</p>
      {c.questions && <div className="note"><b>Referral questions</b><br />{c.questions}</div>}
      {appt && <div className="row wrapflex"><span>Visit: {d(appt.start)} ({appt.state})</span><button className="btn sm" onClick={() => nav(`/visit/${appt.id}`)}>Open video</button>
        {c.patient && <button className="btn sm sec" disabled={busy} onClick={act(() => api(`/provider/patients/${c.patient.id}/verify-manual`, { method: 'POST' }))}>Mark ID checked on camera</button>}</div>}
      <ErrorBox error={err} />
      <div className="ctrl mt">
        <div className="card" style={{ margin: 0 }}><h3>1. Update status</h3>
          <select value={stage} onChange={e => setStage(+e.target.value)}>{STAGES.slice(0, 5).map((s, i) => <option key={i} value={i}>{s}</option>)}</select>
          <button className="btn sm mt" disabled={busy} onClick={act(() => api(`/provider/cases/${id}/stage`, { method: 'POST', body: { stage } }))}>Update status</button>
          <p className="small mt">Ready for download is reached only by releasing an approved report (box 4). The client is notified of every change.</p></div>

        <div className="card" style={{ margin: 0 }}><h3>2. Request missing information</h3>
          {c.hold ? <>
            <p><b>Hold active:</b> {c.hold.what}<br /><span className="small">{c.hold.who} · {c.hold.how}</span></p>
            {c.hold.receivedAt ? <><p className="small">Client upload received {d(c.hold.receivedAt)}. Review it in box 3, then decide.</p>
              <div className="row wrapflex"><button className="btn sm" disabled={busy} onClick={act(() => api(`/provider/cases/${id}/hold/clear`, { method: 'POST' }))}>Complete — clear hold</button><button className="btn sm sec" disabled={busy} onClick={act(() => api(`/provider/cases/${id}/hold/keep`, { method: 'POST' }))}>Still missing — keep hold</button></div></>
              : <><p className="small">Waiting for the client.</p><button className="btn sm sec" disabled={busy} onClick={act(() => api(`/provider/cases/${id}/hold/clear`, { method: 'POST' }))}>Clear hold anyway</button></>}
          </> : <>
            <label>What is needed</label><textarea style={{ minHeight: 70 }} value={hold.what} onChange={e => setHold({ ...hold, what: e.target.value })} />
            <label>Who provides it</label><select value={hold.who} onChange={e => setHold({ ...hold, who: e.target.value })}><option>Patient</option><option>Requesting organization</option><option>Prior treating provider (with signed release)</option><option>Retaining attorney</option></select>
            <label>How to submit</label><select value={hold.how} onChange={e => setHold({ ...hold, how: e.target.value })}><option>Upload in your secure account</option><option>Fax to the practice, then confirm in your account</option><option>We will request it directly once you sign a release</option></select>
            <button className="btn sm mt" disabled={busy || !hold.what.trim()} onClick={act(() => api(`/provider/cases/${id}/hold`, { method: 'POST', body: hold }))}>Place hold and notify</button>
          </>}</div>

        <div className="card" style={{ margin: 0 }}><h3>3. Review uploads</h3>
          <ul className="list">{c.documents.length ? c.documents.map(doc => <li key={doc.id}><span>{doc.url ? <a href={doc.url} target="_blank" rel="noreferrer">{doc.name}</a> : doc.name}<small>{doc.by} · {d(doc.at)} · {doc.receipt} · scan: {doc.scan}</small></span>
            {doc.reviewed ? <span className="pill done">✓ Reviewed</span> : <button className="btn sm sec" disabled={busy} onClick={act(() => api(`/provider/documents/${doc.id}/reviewed`, { method: 'POST' }))}>Mark reviewed</button>}</li>) : <li>No uploads.</li>}</ul>
          <h3 className="mt">Paperwork</h3>
          <ul className="list">{c.checklist.map((i, k) => <li key={k}><span>{i.name}<small>{i.status}</small></span>{i.data && i.status === 'Submitted' && <details><summary className="small">View</summary><pre className="small" style={{ whiteSpace: 'pre-wrap' }}>{pretty(i.data)}</pre></details>}</li>)}</ul></div>

        <div className="card" style={{ margin: 0 }}><h3>4. Approve and release</h3>
          {c.versions.length > 0 && <ul className="list">{c.versions.map(v => <li key={v.id}><span>Version {v.number}<small>{d(v.at)} → {[...v.toPatients, ...v.toOrgUsers].join(', ')}</small></span>{v.current && <span className="pill done">Current</span>}</li>)}</ul>}
          {!canRelease && <p className="small">Available only at In quality control with no hold. Moving to quality control never releases a report.</p>}
          <fieldset disabled={!canRelease || busy} style={{ border: 0, padding: 0, margin: 0 }}>
            <label>Signed report (PDF)</label><input type="file" accept="application/pdf" onChange={e => setRel({ ...rel, file: e.target.files?.[0] || null })} />
            {c.patient && <label className="check"><input type="checkbox" checked={rel.includePatient} onChange={e => setRel({ ...rel, includePatient: e.target.checked })} />{c.patient.identifier} (patient)</label>}
            {c.orgUsers.map(u => <label key={u.id} className="check"><input type="checkbox" checked={rel.orgUserIds.includes(u.id)} onChange={e => setRel({ ...rel, orgUserIds: e.target.checked ? [...rel.orgUserIds, u.id] : rel.orgUserIds.filter(x => x !== u.id) })} />{u.name} ({c.org.identifier})</label>)}
            <label>Release note (internal)</label><input value={rel.note} onChange={e => setRel({ ...rel, note: e.target.value })} />
            <label className="check"><input type="checkbox" checked={rel.approve} onChange={e => setRel({ ...rel, approve: e.target.checked })} />I approve this final, signed version for release to the people checked above.</label>
            <button className="btn sm" disabled={!rel.file || !rel.approve || (!rel.includePatient && !rel.orgUserIds.length)} onClick={act(async () => {
              const assetId = await uploadAsset(rel.file);
              await api(`/provider/cases/${id}/release`, { method: 'POST', body: { assetId, includePatient: !!c.patient && rel.includePatient, orgUserIds: rel.orgUserIds, approve: true, note: rel.note } });
              setRel({ file: null, includePatient: true, orgUserIds: [], approve: false, note: '' });
            })}>Release report</button>
          </fieldset>
          <p className="small mt">To correct a released report, move the case back to In quality control and release a new version.</p></div>
      </div>
      <h3 className="mt">Audit trail</h3>
      <ul className="audit">{[...c.audit].reverse().map((a, i) => <li key={i}>{d(a.at)} · <b>{a.type}</b>{a.detail ? ` — ${a.detail}` : ''} · {a.actor}{a.visible ? '' : ' · internal'}</li>)}</ul>
    </div>
  );
}
const pretty = (s) => { try { return Object.entries(JSON.parse(s)).map(([k, v]) => `${k}: ${v}`).join('\n'); } catch { return s; } };

function OrgUsers() {
  const [data, setData] = useState(null); const [err, setErr] = useState(null); const [form, setForm] = useState({});
  const load = () => api('/provider/org-users').then(setData).catch(setErr);
  useEffect(() => { load(); }, []);
  if (!data) return <div className="card"><p>Loading…</p><ErrorBox error={err} /></div>;
  return (
    <div className="card">
      <h2>Organization users</h2>
      <p className="small">Approve new firm accounts in Knack (Organization Users → pending approval), then link each one to its organization here.</p>
      <ErrorBox error={err} />
      <ul className="list">{data.users.map(u => <li key={u.id} style={{ alignItems: 'flex-start', flexDirection: 'column' }}>
        <span><b>{u.name || u.email}</b><small>{u.email} · {u.org ? `Linked to ${u.org}` : 'Not linked'}</small></span>
        {!u.org && <div className="row wrapflex" style={{ width: '100%' }}>
          <select style={{ maxWidth: 260 }} value={form[u.id]?.orgId || ''} onChange={e => setForm({ ...form, [u.id]: { ...form[u.id], orgId: e.target.value } })}><option value="">Existing organization…</option>{data.orgs.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}</select>
          <input style={{ maxWidth: 260 }} placeholder="or new organization name" value={form[u.id]?.newOrgName || ''} onChange={e => setForm({ ...form, [u.id]: { ...form[u.id], newOrgName: e.target.value } })} />
          <label className="check" style={{ margin: 0 }}><input type="checkbox" checked={!!form[u.id]?.admin} onChange={e => setForm({ ...form, [u.id]: { ...form[u.id], admin: e.target.checked } })} />Admin</label>
          <button className="btn sm" onClick={() => api(`/provider/org-users/${u.id}/link`, { method: 'POST', body: form[u.id] || {} }).then(load).catch(setErr)}>Link</button>
        </div>}
      </li>)}</ul>
    </div>
  );
}
