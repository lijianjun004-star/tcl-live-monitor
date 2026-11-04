// Read-only GET of TCL ops platform APIs (management-approved). Output encrypted by the workflow.
import fs from 'node:fs/promises';
const BASE = process.env.BASE; const out = {};
const bj = d => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(d);
const today = bj(new Date()), d3 = bj(new Date(Date.now() - 3 * 864e5));
async function get(path) {
  const u = new URL(path, BASE); if (!u.pathname.startsWith('/api/')) throw Error('path');
  const t0 = Date.now();
  try { const r = await fetch(u, { method: 'GET', signal: AbortSignal.timeout(20000) }); const text = await r.text();
    out[path] = { status: r.status, ms: Date.now() - t0, body: text.slice(0, 200000) }; try { return JSON.parse(text); } catch { return null; } }
  catch (e) { out[path] = { error: String(e).slice(0, 200) }; return null; }
}
const rooms = (await get('/api/capture/rooms'))?.rooms || [];
await get('/api/shops'); await get('/api/assistant/active-rooms'); await get('/api/capture/room-overview/filters');
for (const r of rooms) {
  await get(`/api/capture/room-overview/daily?start_date=${d3}&end_date=${today}&platform=${r.platform}&live_room_id=${r.id}`);
  await get(`/api/capture/schedules?date=${today}&platform=${r.platform}&live_room_id=${r.id}`);
}
await fs.mkdir('out', { recursive: true });
await fs.writeFile('out/data.json', JSON.stringify({ fetchedAt: new Date().toISOString(), today, d3, out }, null, 1));
