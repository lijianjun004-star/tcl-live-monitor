/**
 * R3.16 one-shot read-only extraction of the TCL OPS reference system (JD + Douyin only).
 * - GET only, fixed path allowlist, no cookies/credentials, no redirects followed, 15 s timeout,
 *   2 MB cap, 1 s spacing, stop the whole run on 401/403/429/challenge/unknown redirect.
 * - PUBLIC output (stdout + summary file): per-request metadata only. Internal room/shop IDs are
 *   replaced by run-local placeholders; no names, no business fields, no bodies.
 * - PRIVATE output: raw bodies in out/r316-private/ — the workflow encrypts it with the repository
 *   RSA public key before anything leaves the runner. The private key is not in the repo or CI.
 */
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';

if (process.env.R316_EXTRACT_ONCE !== 'GET_ONLY_ALLOWLIST_ONCE') throw Error('R316_ONESHOT_GUARD_REQUIRED');
const ORIGIN = 'http://101.96.215.251';
const HOST = new URL(ORIGIN).hostname;
const MAX = 2_000_000, TIMEOUT = 15000, GAP = 1000;
const PLATFORM_OK = new Set(['jd', 'douyin']);
const ALLOW = [
  /^\/$/, /^\/assets\/[\w.-]+\.js$/,
  /^\/api\/capture\/rooms$/, /^\/api\/shops$/, /^\/api\/assistant\/active-rooms$/, /^\/api\/dashboard\/filters$/,
  /^\/api\/capture\/room-overview\/filters$/, /^\/api\/capture\/room-overview\/daily$/,
  /^\/api\/capture\/schedules$/, /^\/api\/capture\/inspection-events$/,
];
const CHALLENGE = /(captcha|验证码|人机验证|安全验证|访问受限|请登录|login)/i;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const startedAt = new Date();
const bj = d => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const today = bj(startedAt), from = bj(new Date(startedAt.getTime() - 7 * 86400000)), yday = bj(new Date(startedAt.getTime() - 86400000));

const pub = { schemaVersion: 316, mode: 'PUBLIC_METADATA_ONLY', origin: ORIGIN, startedAt: startedAt.toISOString(), beijingDate: today,
  network: {}, requests: [], stopped: null, counts: {}, rawBodyStoredPublicly: false, credentialsSent: false };
const priv = { schemaVersion: 316, startedAt: startedAt.toISOString(), beijingDate: today, bodies: {} };
const placeholder = new Map(); // internal id -> run-local label, never printed together
const ph = (kind, id) => { const k = kind + ':' + id; if (!placeholder.has(k)) placeholder.set(k, `${kind}#${[...placeholder.keys()].filter(x => x.startsWith(kind + ':')).length + 1}`); return placeholder.get(k); };

// --- network layer evidence: DNS / TCP
try { pub.network.dns = net.isIP(HOST) ? 'LITERAL_IP' : (await dns.lookup(HOST)).address ? 'RESOLVED' : 'FAILED'; } catch (e) { pub.network.dns = 'FAILED:' + e.code; }
pub.network.tcp80 = await new Promise(res => { const s = net.connect({ host: HOST, port: 80, timeout: 8000 });
  s.on('connect', () => { s.destroy(); res('OPEN'); }); s.on('timeout', () => { s.destroy(); res('TIMEOUT'); }); s.on('error', e => res('ERROR:' + e.code)); });
pub.network.tcp443 = await new Promise(res => { const s = net.connect({ host: HOST, port: 443, timeout: 8000 });
  s.on('connect', () => { s.destroy(); res('OPEN'); }); s.on('timeout', () => { s.destroy(); res('TIMEOUT'); }); s.on('error', e => res('ERROR:' + e.code)); });

async function get(path, params = null, label = path) {
  if (pub.stopped) return null;
  if (!ALLOW.some(r => r.test(path))) throw Error('PATH_NOT_ALLOWED');
  const u = new URL(path, ORIGIN);
  if (params) for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  const meta = { label, path, method: 'GET', checkedAt: new Date().toISOString(), httpStatus: null, contentType: null, responseBytes: null,
    paginationObserved: null, totalField: null, topLevel: null, items: null, authRequired: false, challengeObserved: false, error: null };
  let text = null;
  try {
    const r = await fetch(u, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT), headers: { accept: 'application/json, text/html;q=0.8, */*;q=0.5' } });
    meta.httpStatus = r.status; meta.contentType = (r.headers.get('content-type') || '').slice(0, 60);
    const buf = Buffer.from(await r.arrayBuffer());
    meta.responseBytes = buf.length; meta.sha256 = sha(buf);
    if (buf.length > MAX) { meta.error = 'RESPONSE_TOO_LARGE'; pub.stopped = { label, reason: 'RESPONSE_TOO_LARGE' }; }
    text = buf.subarray(0, MAX).toString('utf8');
    if ([301, 302, 303, 307, 308].includes(r.status)) { meta.error = 'REDIRECT_NOT_FOLLOWED'; pub.stopped = { label, reason: 'REDIRECT' }; }
    if ([401, 403, 429].includes(r.status)) { meta.authRequired = r.status === 401; pub.stopped = { label, reason: 'HTTP_' + r.status }; }
    if (/html/.test(meta.contentType) && path !== '/' && CHALLENGE.test(text)) { meta.challengeObserved = true; pub.stopped = { label, reason: 'CHALLENGE' }; }
    if (/json/.test(meta.contentType)) {
      try {
        const j = JSON.parse(text);
        const arr = Array.isArray(j) ? j : (['rooms', 'days', 'events', 'schedules', 'items', 'list', 'data'].map(k => j?.[k]).find(Array.isArray) || null);
        meta.topLevel = Array.isArray(j) ? 'ARRAY' : Object.keys(j).sort().slice(0, 12);
        meta.items = arr ? arr.length : null;
        const pk = ['total', 'total_count', 'has_more', 'hasMore', 'next', 'next_cursor', 'offset', 'page', 'page_size', 'limit', 'pagination'];
        meta.paginationObserved = !Array.isArray(j) && pk.some(k => k in j) ? pk.filter(k => k in j) : false;
        if (!Array.isArray(j) && 'total' in j) meta.totalField = Number.isInteger(j.total) ? j.total : 'NON_INTEGER';
      } catch { meta.error = 'JSON_PARSE_FAILED'; }
    }
  } catch (e) { meta.error = String(e?.name === 'TimeoutError' ? 'TIMEOUT' : (e?.cause?.code || e?.name || 'FETCH_ERROR')).slice(0, 40); }
  pub.requests.push(meta);
  priv.bodies[label + (params ? ' ' + new URLSearchParams(params) : '')] = { status: meta.httpStatus, contentType: meta.contentType, checkedAt: meta.checkedAt, body: text };
  await sleep(GAP);
  return text;
}
const json = t => { try { return JSON.parse(t); } catch { return null; } };

// 1. page + static bundles (REA inputs)
const html = await get('/', null, 'GET /');
const scripts = html ? [...html.matchAll(/<script[^>]+src="(\/assets\/[\w.-]+\.js)"/g)].map(m => m[1]).slice(0, 3) : [];
const preload = html ? [...html.matchAll(/<link[^>]+href="(\/assets\/[\w.-]+\.js)"/g)].map(m => m[1]).slice(0, 6) : [];
pub.counts.htmlScripts = scripts.length; pub.counts.htmlModulePreloads = preload.length;
for (const s of [...new Set([...scripts, ...preload])].slice(0, 8)) await get(s, null, 'GET ' + s);

// 2. catalogs
const rooms = json(await get('/api/capture/rooms', null, 'rooms'));
const shops = json(await get('/api/shops', null, 'shops'));
await get('/api/assistant/active-rooms', null, 'heartbeats');
await get('/api/dashboard/filters', null, 'dashboard-filters');
await get('/api/capture/room-overview/filters', null, 'overview-filters');
const list = Array.isArray(rooms?.rooms) ? rooms.rooms : [];
const byPlat = {};
for (const r of list) { const p = String(r?.platform ?? '').trim().toLowerCase(); (byPlat[p] ||= []).push(r); }
pub.counts.roomsByPlatform = Object.fromEntries(Object.entries(byPlat).map(([k, v]) => [k, v.length]));
pub.counts.shopsByPlatform = Array.isArray(shops) ? shops.reduce((m, s) => { const p = String(s?.platform ?? '').toLowerCase(); m[p] = (m[p] || 0) + 1; return m; }, {}) : null;

// 3. per-room daily history (last 8 Beijing days), JD + Douyin only, platform value exactly as the source returned it
for (const p of ['jd', 'douyin']) {
  for (const r of (byPlat[p] || []).slice(0, 30)) {
    const id = String(r?.id ?? '');
    if (!/^[0-9]{1,16}$/.test(id)) continue;
    await get('/api/capture/room-overview/daily', { start_date: from, end_date: today, platform: r.platform, live_room_id: id }, `daily ${p} ${ph(p + '-room', id)}`);
  }
}
// 4. schedule + inspection events (platform level). Contain staff names -> private only.
for (const p of ['jd', 'douyin']) {
  if (!(byPlat[p] || []).length) continue;
  await get('/api/capture/schedules', { date: today, platform: p }, `schedules ${p} today`);
  await get('/api/capture/inspection-events', { start_date: yday, end_date: today, platform: p, limit: 500 }, `inspection-events ${p}`);
}
pub.finishedAt = new Date().toISOString();
pub.requestCount = pub.requests.length;
await fs.mkdir('out/r316-private', { recursive: true });
await fs.writeFile('out/r316-private/extract.json', JSON.stringify(priv));
await fs.writeFile('out/r316-public-summary.json', JSON.stringify(pub, null, 1) + '\n');
for (const m of pub.requests) console.log('R316_REQ ' + JSON.stringify({ label: m.label, path: m.path, http: m.httpStatus, type: m.contentType, bytes: m.responseBytes, items: m.items, top: m.topLevel, pagination: m.paginationObserved, err: m.error }));
console.log('R316_NET ' + JSON.stringify(pub.network));
console.log('R316_COUNTS ' + JSON.stringify(pub.counts));
console.log('R316_STOPPED ' + JSON.stringify(pub.stopped));
if (pub.stopped) process.exitCode = 3;
