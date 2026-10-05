import { accessToken, startLogin, KNACK_API_BASE, KNACK_APP_ID } from './auth.js';

export class ApiError extends Error { constructor(msg, status) { super(msg); this.status = status; } }

export async function api(path, { method = 'GET', body } = {}) {
  const token = await accessToken();
  const res = await fetch(`/api${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && token) { startLogin(window.location.pathname); throw new ApiError('Session expired', 401); }
  if (!res.ok) throw new ApiError(data.error || `Request failed (${res.status})`, res.status);
  return data;
}

// Uploads a file to Knack's asset store with the user's own token; returns the asset id.
export async function uploadAsset(file) {
  const token = await accessToken();
  const fd = new FormData(); fd.append('files', file);
  const res = await fetch(`${KNACK_API_BASE}/applications/${KNACK_APP_ID}/assets/file/upload`, { method: 'POST', headers: { 'X-Knack-Application-Id': KNACK_APP_ID, Authorization: `Bearer ${token}` }, body: fd });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.id) throw new ApiError(`Upload failed (${res.status}): ${data.message || data.error || JSON.stringify(data).slice(0, 200)}`, res.status);
  return data.id;
}

export async function downloadReport(versionId) {
  const token = await accessToken();
  const res = await fetch(`/api/reports/${versionId}/download`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) { const d = await res.json().catch(() => ({})); throw new ApiError(d.error || `Download failed (${res.status})`, res.status); }
  const blob = await res.blob();
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'report.pdf'; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
