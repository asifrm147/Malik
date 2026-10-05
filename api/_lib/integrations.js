// Third-party integrations. Each runs in TEST MODE until its credentials are set,
// so the full flow can be exercised before contracts are signed.
// Endpoints marked VERIFY must be checked against the vendor's current docs when credentials arrive.
import { HttpError } from './knack.js';

const appUrl = () => process.env.APP_BASE_URL || 'https://app.asifmalikmd.com';

// ---------------- ID.me (OAuth 2.0) ----------------
export const idme = {
  testMode: () => !process.env.IDME_CLIENT_ID,
  authorizeUrl(state) {
    const base = process.env.IDME_BASE || 'https://api.idmelabs.com';
    const q = new URLSearchParams({ client_id: process.env.IDME_CLIENT_ID, redirect_uri: `${appUrl()}/api/idme/callback`, response_type: 'code', scope: process.env.IDME_SCOPE || 'identity', state });
    return `${base}/oauth/authorize?${q}`; // VERIFY
  },
  async exchange(code) {
    const base = process.env.IDME_BASE || 'https://api.idmelabs.com';
    const tok = await fetch(`${base}/oauth/token`, { // VERIFY
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: process.env.IDME_CLIENT_ID, client_secret: process.env.IDME_CLIENT_SECRET, redirect_uri: `${appUrl()}/api/idme/callback`, grant_type: 'authorization_code' }),
    });
    if (!tok.ok) throw new HttpError(502, `ID.me token exchange failed (${tok.status}).`);
    const { access_token } = await tok.json();
    const attr = await fetch(`${base}/api/public/v3/attributes.json`, { headers: { Authorization: `Bearer ${access_token}` } }); // VERIFY
    if (!attr.ok) throw new HttpError(502, `ID.me attributes request failed (${attr.status}).`);
    const data = await attr.json();
    // Keep only what we need: a stable reference and whether verification passed. No ID images, no SSN.
    const uuid = data?.attributes?.find?.(a => a.handle === 'uuid')?.value || data?.uuid || null;
    const verified = (data?.status || []).some?.(s => s.verified) ?? !!uuid;
    return { reference: uuid, verified };
  },
};

// ---------------- Sphere / TrustCommerce ----------------
export const sphere = {
  testMode: () => !process.env.SPHERE_CUSTOMER_ID,
  // Returns a URL the client is sent to for card entry. Card data never touches this app.
  checkoutUrl({ amount, reference, returnPath }) {
    if (this.testMode()) return `${appUrl()}/pay/test?ref=${encodeURIComponent(reference)}&amount=${amount}&return=${encodeURIComponent(returnPath)}`;
    // VERIFY: build the TC Trustee Host hosted-payment-page request per Sphere's integration guide.
    const q = new URLSearchParams({ custid: process.env.SPHERE_CUSTOMER_ID, amount: String(Math.round(amount * 100)), ticket: reference, returnurl: `${appUrl()}/api/payments/return?ref=${encodeURIComponent(reference)}&return=${encodeURIComponent(returnPath)}` });
    return `${process.env.SPHERE_HOSTED_PAGE_URL}?${q}`;
  },
  // Confirms a payment server-side. Never trust a browser redirect alone.
  async confirm(reference, query) {
    if (this.testMode()) return { paid: query.test === 'approved', transactionId: `TEST-${reference}` };
    // VERIFY: query the transaction by ticket/transid through Sphere's API and check status === approved.
    throw new HttpError(501, 'Sphere confirmation not yet configured. Add credentials and finish per Sphere docs.');
  },
};

// ---------------- Daily (built-in video) ----------------
export const daily = {
  testMode: () => !process.env.DAILY_API_KEY,
  async room(name, startIso) {
    if (this.testMode()) return { url: null, testMode: true };
    const h = { Authorization: `Bearer ${process.env.DAILY_API_KEY}`, 'Content-Type': 'application/json' };
    const exp = Math.floor(new Date(startIso).getTime() / 1000) + 2 * 3600;
    let r = await fetch(`https://api.daily.co/v1/rooms/${name}`, { headers: h });
    if (r.status === 404) {
      r = await fetch('https://api.daily.co/v1/rooms', { method: 'POST', headers: h, body: JSON.stringify({ name, privacy: 'private', properties: { exp, enable_knocking: true, enable_prejoin_ui: true, enable_recording: false, enable_chat: false } }) });
    }
    if (!r.ok) throw new HttpError(502, `Video room setup failed (${r.status}).`);
    return r.json();
  },
  async token(name, { owner, userName, startIso }) {
    const h = { Authorization: `Bearer ${process.env.DAILY_API_KEY}`, 'Content-Type': 'application/json' };
    const exp = Math.floor(new Date(startIso).getTime() / 1000) + 2 * 3600;
    const r = await fetch('https://api.daily.co/v1/meeting-tokens', { method: 'POST', headers: h, body: JSON.stringify({ properties: { room_name: name, is_owner: !!owner, user_name: userName, exp } }) });
    if (!r.ok) throw new HttpError(502, `Video token failed (${r.status}).`);
    return (await r.json()).token;
  },
};
