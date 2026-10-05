// Server-only Knack client. Uses the private REST API key, so it must never be imported by frontend code.
const BASE = 'https://api.knack.com/v1';
const APP = process.env.KNACK_APP_ID;

export const O = {
  patients: 'object_3', orgs: 'object_4', orgUsers: 'object_5', providers: 'object_6',
  cases: 'object_7', appts: 'object_8', checklist: 'object_9', docs: 'object_10',
  versions: 'object_11', events: 'object_12', notes: 'object_13',
};
export const PROFILE = { patient: 'profile_3', org: 'profile_5', provider: 'profile_6' };

// Field keys, copied from the live schema.
export const F = {
  patient: { name: 'field_23', email: 'field_24', phone: 'field_34', dob: 'field_35', idStatus: 'field_36', idRef: 'field_37', idAt: 'field_38', emailOn: 'field_39', reminders: 'field_40', lang: 'field_41', pcpName: 'field_42', pcpFax: 'field_43', pharmacy: 'field_44', sphereToken: 'field_45' },
  org: { name: 'field_46', type: 'field_47', domain: 'field_48', signIn: 'field_49', status: 'field_50' },
  orgUser: { name: 'field_59', email: 'field_60', phone: 'field_70', title: 'field_71', role: 'field_72', idStatus: 'field_73', idRef: 'field_74', idAt: 'field_75', emailOn: 'field_76', lang: 'field_77', org: 'field_193' },
  provider: { name: 'field_78', email: 'field_79' },
  case: { number: 'field_92', type: 'field_93', stage: 'field_94', onHold: 'field_95', holdWhat: 'field_96', holdWho: 'field_97', holdHow: 'field_98', holdRecv: 'field_99', lastChange: 'field_100', due: 'field_101', jurisdiction: 'field_102', claim: 'field_103', questions: 'field_104', pages: 'field_105', fee: 'field_106', payStatus: 'field_107', sphereTx: 'field_108', examinee: 'field_109', patient: 'field_194', org: 'field_195', requestedBy: 'field_196' },
  appt: { start: 'field_116', minutes: 'field_117', type: 'field_118', status: 'field_119', state: 'field_120', holdExp: 'field_121', room: 'field_122', fee: 'field_123', payStatus: 'field_124', sphereTx: 'field_125', patient: 'field_197', case: 'field_198', startUtc: 'field_208', holdExpUtc: 'field_209', reminded: 'field_210' },
  item: { name: 'field_132', nameEs: 'field_133', order: 'field_134', status: 'field_135', at: 'field_136', data: 'field_137', signature: 'field_138', case: 'field_199' },
  doc: { file: 'field_145', fileName: 'field_146', receipt: 'field_147', at: 'field_148', byRole: 'field_149', scan: 'field_150', reviewed: 'field_151', answersHold: 'field_152', case: 'field_200' },
  ver: { number: 'field_159', file: 'field_160', at: 'field_161', approved: 'field_162', current: 'field_163', note: 'field_164', case: 'field_201', toPatients: 'field_202', toOrgUsers: 'field_203' },
  ev: { type: 'field_171', detail: 'field_172', at: 'field_173', visible: 'field_174', actor: 'field_175', case: 'field_204' },
  note: { msg: 'field_182', msgEs: 'field_183', at: 'field_184', read: 'field_185', email: 'field_186', case: 'field_205', patient: 'field_206', orgUser: 'field_207' },
};

export const STAGES = ['Awaiting appointment / review', 'Report in preparation', 'Dictated', 'Proofed and compiled', 'In quality control', 'Ready for download'];

function headers(extra = {}) {
  if (!APP || !process.env.KNACK_API_KEY) throw new HttpError(500, 'Server is missing KNACK_APP_ID or KNACK_API_KEY.');
  return { 'X-Knack-Application-Id': APP, 'X-Knack-REST-API-Key': process.env.KNACK_API_KEY, 'Content-Type': 'application/json', ...extra };
}

export class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

async function call(method, path, body) {
  const res = await fetch(`${BASE}${path}`, { method, headers: headers(), body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) throw new HttpError(502, `Knack ${method} ${path} failed (${res.status}): ${text.slice(0, 400)}`);
  return data;
}

export const knack = {
  list: (obj, { filters, sortField, sortOrder = 'desc', rows = 100, page = 1 } = {}) => {
    const q = new URLSearchParams({ rows_per_page: String(rows), page: String(page) });
    if (filters) q.set('filters', JSON.stringify(filters));
    if (sortField) { q.set('sort_field', sortField); q.set('sort_order', sortOrder); }
    return call('GET', `/objects/${obj}/records?${q}`).then(d => d.records || []);
  },
  get: (obj, id) => call('GET', `/objects/${obj}/records/${id}`),
  create: (obj, body) => call('POST', `/objects/${obj}/records`, body),
  update: (obj, id, body) => call('PUT', `/objects/${obj}/records/${id}`, body),
  downloadStream: (assetId, filename) => fetch(`${BASE}/applications/${APP}/download/asset/${assetId}/${encodeURIComponent(filename)}`, { headers: headers() }),
};

// Helpers for raw values.
export const raw = (rec, key) => rec?.[`${key}_raw`];
export const connId = (rec, key) => (raw(rec, key) || [])[0]?.id || null;
export const connIds = (rec, key) => (raw(rec, key) || []).map(c => c.id);
export const rule = (field, operator, value) => ({ field, operator, value });

// Format a JS Date for a Knack date_time write, in the Knack app's time zone.
export function knackDate(date) {
  const tz = process.env.KNACK_APP_TZ || 'America/New_York';
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: true }).formatToParts(date).map(x => [x.type, x.value]));
  return { date: `${p.month}/${p.day}/${p.year}`, time: `${p.hour}:${p.minute} ${p.dayPeriod.toLowerCase()}`, all_day: false };
}
