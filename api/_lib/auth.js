import { HttpError, O, PROFILE } from './knack.js';
import crypto from 'node:crypto';

const BASE = 'https://api.knack.com/v1';
const APP = process.env.KNACK_APP_ID;

// Verifies the caller's Knack OAuth token and returns { accountId, name, profileKeys, roles: { patient?, org?, provider? } }.
// Each role entry holds the caller's own role-object record, fetched with THEIR token so Knack's access control decides.
export async function requireUser(req) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer lao_')) throw new HttpError(401, 'Sign in required.');
  const h = { 'X-Knack-Application-Id': APP, Authorization: auth };
  const s = await fetch(`${BASE}/live-app/${APP}/session`, { headers: h });
  if (s.status === 401) throw new HttpError(401, 'Your session expired. Please sign in again.');
  if (!s.ok) throw new HttpError(502, `Could not verify session (${s.status}).`);
  const { session } = await s.json();
  const user = session?.user;
  if (!user?.id) throw new HttpError(401, 'Sign in required.');
  const profileKeys = user.profileKeys || [];
  const roles = {};
  const wanted = [['patient', PROFILE.patient, O.patients], ['org', PROFILE.org, O.orgUsers], ['provider', PROFILE.provider, O.providers]];
  await Promise.all(wanted.filter(([, pk]) => profileKeys.includes(pk)).map(async ([role, , obj]) => {
    const r = await fetch(`${BASE}/objects/${obj}/records?rows_per_page=1`, { headers: h });
    if (r.ok) { const d = await r.json(); if (d.records?.[0]) roles[role] = d.records[0]; }
  }));
  return { accountId: user.id, name: user.name?.fullName || '', profileKeys, roles };
}

export function requireRole(me, role) {
  if (!me.roles[role]) throw new HttpError(403, role === 'org' ? 'Your organization account is not approved yet.' : 'You do not have access to this area.');
  return me.roles[role];
}

// Signed, expiring state for third-party redirects (ID.me).
const secret = () => { if (!process.env.STATE_SECRET) throw new HttpError(500, 'STATE_SECRET is not set.'); return process.env.STATE_SECRET; };
export function signState(payload, ttlSec = 900) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + ttlSec * 1000 })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}
export function readState(state) {
  const [body, sig] = String(state || '').split('.');
  const good = crypto.createHmac('sha256', secret()).update(body || '').digest('base64url');
  if (!sig || sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) throw new HttpError(400, 'Invalid verification state.');
  const data = JSON.parse(Buffer.from(body, 'base64url').toString());
  if (data.exp < Date.now()) throw new HttpError(400, 'Verification link expired. Please start again.');
  return data;
}
