// Read-only GET of given same-host paths (/api/* or /assets/*.js). Output encrypted by workflow.
import fs from 'node:fs/promises';
const BASE = process.env.BASE; const paths = String(process.env.PATHS || '').split(/\s+/).filter(Boolean).slice(0, 60);
const out = {};
for (const p of paths) {
  const u = new URL(p, BASE);
  if (u.origin !== new URL(BASE).origin || !/^\/(api\/|assets\/[\w.-]+\.js$)/.test(u.pathname)) { out[p] = { error: 'path not allowed' }; continue; }
  try { const r = await fetch(u, { method: 'GET', signal: AbortSignal.timeout(20000) }); out[p] = { status: r.status, body: (await r.text()).slice(0, 400000) }; }
  catch (e) { out[p] = { error: String(e).slice(0, 200) }; }
}
await fs.mkdir('out', { recursive: true });
await fs.writeFile('out/fetch.json', JSON.stringify({ fetchedAt: new Date().toISOString(), out }));
