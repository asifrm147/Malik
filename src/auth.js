// Knack OAuth 2.0 (Authorization Code + PKCE), browser-only, per Knack's SPA guide.
export const KNACK_API_BASE = import.meta.env.VITE_KNACK_API_BASE || 'https://api.knack.com/v1';
export const KNACK_APP_ID = import.meta.env.VITE_KNACK_APP_ID;
export const KNACK_CLIENT_ID = import.meta.env.VITE_KNACK_CLIENT_ID;
const redirectUri = () => `${window.location.origin}/auth/callback`;

const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const rand = (n) => b64url(crypto.getRandomValues(new Uint8Array(n)));
const sha256 = async (s) => b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));

export function getTokens() { try { return JSON.parse(sessionStorage.getItem('knack.tokens')); } catch { return null; } }
function setTokens(t) { sessionStorage.setItem('knack.tokens', JSON.stringify({ accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: Date.now() + (t.expires_in - 60) * 1000 })); }

export async function startLogin(returnTo = '/account') {
  const verifier = rand(48), state = rand(16);
  sessionStorage.setItem('knack_pkce', JSON.stringify({ verifier, state, returnTo }));
  const url = new URL(`${KNACK_API_BASE}/oauth/authorize`);
  url.searchParams.set('client_id', KNACK_CLIENT_ID);
  url.searchParams.set('redirect_uri', redirectUri());
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('code_challenge', await sha256(verifier));
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  window.location.assign(url.toString());
}

export async function finishLogin(params) {
  const raw = sessionStorage.getItem('knack_pkce');
  sessionStorage.removeItem('knack_pkce');
  if (!raw) throw new Error('Login session expired. Please sign in again.');
  const pkce = JSON.parse(raw);
  if (params.get('error')) throw new Error(`${params.get('error')}: ${params.get('error_description') || ''}`);
  if (params.get('state') !== pkce.state) throw new Error('Login could not be verified (state mismatch). Please try again.');
  const res = await fetch(`${KNACK_API_BASE}/oauth/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: params.get('code'), redirect_uri: redirectUri(), client_id: KNACK_CLIENT_ID, code_verifier: pkce.verifier }).toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${data.error || res.status}: ${data.error_description || 'Token exchange failed'}`);
  setTokens(data);
  return pkce.returnTo || '/account';
}

let refreshing = null;
export async function accessToken() {
  const t = getTokens();
  if (!t) return null;
  if (Date.now() < t.expiresAt) return t.accessToken;
  refreshing ||= (async () => {
    const res = await fetch(`${KNACK_API_BASE}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refreshToken, client_id: KNACK_CLIENT_ID }).toString() });
    const data = await res.json();
    if (!res.ok) { sessionStorage.removeItem('knack.tokens'); return null; }
    setTokens(data); return data.access_token;
  })().finally(() => { refreshing = null; });
  return refreshing;
}

export async function logout() {
  const t = getTokens();
  sessionStorage.clear();
  if (t) fetch(`${KNACK_API_BASE}/oauth/revoke`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: t.accessToken, client_id: KNACK_CLIENT_ID }).toString() }).catch(() => {});
  window.location.assign('/');
}
