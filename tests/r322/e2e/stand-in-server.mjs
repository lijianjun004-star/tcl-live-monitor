// R3.22 sealed end-to-end: loopback stand-in for the two APPROVED accounts' public pages.
// Pages are built in memory from config/probe-targets.json; nothing is written to disk and only
// fixed labels are logged (never a path, id or name). Runs ONLY inside the sealed namespace.
// Usage: node stand-in-server.mjs <repo-root> <NORMAL|FORBIDDEN_FIRST> <work-dir>
import https from 'node:https';
import fs from 'node:fs';
const [root, scenario, work] = process.argv.slice(2);
const reg = JSON.parse(fs.readFileSync(root + '/config/probe-targets.json', 'utf8'));
const { targets } = JSON.parse(fs.readFileSync(root + '/config/r316-douyin-rpa-targets.json', 'utf8'));
const [first, second] = targets.map(t => reg.douyin.find(x => x.key === t.key));
const pathOf = t => new URL(t.profileUrl).pathname;
const page = (title, body, head = '') => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${head}</head><body>${body}</body></html>`;
const profile = (t, live) => page(`${t.accountName}的抖音 - 抖音`, `<main><div data-e2e="user-info"><h1>${t.accountName}</h1><span>抖音号：${t.displayDouyinId}</span>${live ? `<a href="https://live.douyin.com/${t.roomId}">直播中</a>` : ''}</div></main>`);
const room = t => page(`${t.accountName}的抖音直播间 - 抖音直播`, `<main><div data-e2e="room-owner"><a href="${t.profileUrl}">${t.accountName}</a></div><video></video></main>`,
  `<meta name="description" content="欢迎来到${t.accountName}的抖音直播间">`);
const log = [];
https.createServer({ key: fs.readFileSync(work + '/key.pem'), cert: fs.readFileSync(work + '/cert.pem') }, (req, res) => {
  const host = String(req.headers.host || '').split(':')[0], p = req.url.split('?')[0];
  const send = (code, body, type = 'text/html; charset=utf-8') => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };
  if (host === 'www.douyin.com' && p === pathOf(first)) {
    if (scenario === 'FORBIDDEN_FIRST') { log.push('profile:first:403'); return send(403, 'forbidden'); }
    log.push('profile:first'); return send(200, profile(first, false));
  }
  if (host === 'www.douyin.com' && p === pathOf(second)) { log.push('profile:second'); return send(200, profile(second, true)); }
  if (host === 'live.douyin.com' && p === '/' + second.roomId) { log.push('room:second'); return send(200, room(second)); }
  log.push(host === 'www.douyin.com' || host === 'live.douyin.com' ? 'douyin:other-path' : 'other-host');
  send(404, 'nf', 'text/plain');
}).listen(443, '127.0.0.1', () => console.error('READY'));
process.on('SIGTERM', () => { fs.writeFileSync(work + '/' + scenario + '/server-log.json', JSON.stringify(log)); process.exit(0); });
