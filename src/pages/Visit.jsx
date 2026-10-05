import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { getTokens, startLogin } from '../auth.js';
import { TopBar, ErrorBox } from '../components/shared.jsx';

// Built-in video. The room is private and joins with a short-lived token issued by our server.
export function Visit() {
  const { id } = useParams(); const nav = useNavigate();
  const [room, setRoom] = useState(null); const [err, setErr] = useState(null); const [ready, setReady] = useState(false);
  useEffect(() => { if (!getTokens()) startLogin(`/visit/${id}`); }, [id]);
  const join = () => api(`/video/${id}`).then(setRoom).catch(setErr);
  return (
    <>
      <TopBar showLang={false} />
      <main className="wrap" style={{ maxWidth: 900 }}>
        <h1>Video visit</h1>
        {!room && <div className="card">
          <p>Find a quiet, private place. Use a phone or computer with a camera. If the video drops, rejoin from this page; Dr. Malik will call the number on file if it cannot reconnect.</p>
          <label className="check"><input type="checkbox" checked={ready} onChange={e => setReady(e.target.checked)} />I am in a private place, physically in the state I chose, and I consent to this video visit.</label>
          <button className="btn full" disabled={!ready} onClick={join}>Enter waiting room</button>
          <ErrorBox error={err} />
          <p className="small mt">Emergencies: call 911. Crisis: call or text 988.</p>
        </div>}
        {room?.testMode && <div className="card"><div className="test">Video is in test mode (no Daily account yet). Room name: {room.room}. In production the video appears here.</div><button className="btn sec" onClick={() => nav('/account')}>Back to account</button></div>}
        {room?.url && <iframe className="video" title="Video visit" src={`${room.url}?t=${encodeURIComponent(room.token)}`} allow="camera; microphone; fullscreen; display-capture; autoplay" />}
      </main>
    </>
  );
}
