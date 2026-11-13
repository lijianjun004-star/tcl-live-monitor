// R3.22 sealed end-to-end: loopback stand-in for the two APPROVED accounts' public pages.
// Pages are built in memory from config/probe-targets.json; nothing is written to disk and only
// fixed labels are logged (never a path, id or name). Runs ONLY inside the sealed namespace.
// Usage: node stand-in-server.mjs <repo-root> <scenario> <work-dir>
// Scenarios: NORMAL, FORBIDDEN_FIRST (R3.22); REAL_LAYOUT, FOREIGN_BADGE, ROOM_TITLE_EMPTY (R3.23) mirror
// the page shape seen in approved real run 43449924435: empty profile titles and the account's own
// "直播中" link outside the guessed owner containers.
import https from 'node:https';
import fs from 'node:fs';
const [root, scenario, work] = process.argv.slice(2);
const reg = JSON.parse(fs.readFileSync(root + '/config/probe-targets.json', 'utf8'));
const { targets } = JSON.parse(fs.readFileSync(root + '/config/r316-douyin-rpa-targets.json', 'utf8'));
const [first, second] = targets.map(t => reg.douyin.find(x => x.key === t.key));
const FOREIGN = '70000000001'; // synthetic room of some OTHER account (e.g. a recommendation)
if (reg.douyin.some(t => String(t.roomId) === FOREIGN)) throw Error('FOREIGN_ROOM_COLLIDES_WITH_REGISTRY');
const R323 = ['REAL_LAYOUT', 'FOREIGN_BADGE', 'ROOM_TITLE_EMPTY'].includes(scenario);
const pathOf = t => new URL(t.profileUrl).pathname;
const page = (title, body, head = '') => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${head}</head><body>${body}</body></html>`;
const header = (t, inner = '') => `<div data-e2e="user-info"><h1>${t.accountName}</h1><span>抖音号：${t.displayDouyinId}</span>${inner}</div>`;
const liveLink = id => `<a href="https://live.douyin.com/${id}">直播中</a>`;
// R3.23: live entries rendered OUTSIDE every owner container, as on the real pages.
const outside = ids => ids.map(id => `<section data-e2e="live-entry">${liveLink(id)}</section>`).join('');
const profile = (t, liveInHeader, outsideIds = []) => page(R323 ? '' : `${t.accountName}的抖音 - 抖音`,
  `<main>${header(t, liveInHeader ? liveLink(t.roomId) : '')}${outside(outsideIds)}</main>`);
const room = (t, emptyTitle = false) => page(emptyTitle ? '' : `${t.accountName}的抖音直播间 - 抖音直播`,
  `<main><div data-e2e="room-owner"><a href="${t.profileUrl}">${t.accountName}</a></div><video></video></main>`,
  `<meta name="description" content="欢迎来到${t.accountName}的抖音直播间">`);
const firstProfile = { NORMAL: () => profile(first, false), REAL_LAYOUT: () => profile(first, false, [first.roomId]),
  FOREIGN_BADGE: () => profile(first, false, [FOREIGN]), ROOM_TITLE_EMPTY: () => profile(first, false, [first.roomId]) };
const secondProfile = { NORMAL: () => profile(second, true), REAL_LAYOUT: () => profile(second, false),
  FOREIGN_BADGE: () => profile(second, false, [second.roomId, FOREIGN]), ROOM_TITLE_EMPTY: () => profile(second, false) };
if (scenario !== 'FORBIDDEN_FIRST' && !firstProfile[scenario]) throw Error('UNKNOWN_SCENARIO');
const log = [];
https.createServer({ key: fs.readFileSync(work + '/key.pem'), cert: fs.readFileSync(work + '/cert.pem') }, (req, res) => {
  const host = String(req.headers.host || '').split(':')[0], p = req.url.split('?')[0];
  const send = (code, body, type = 'text/html; charset=utf-8') => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };
  if (host === 'www.douyin.com' && p === pathOf(first)) {
    if (scenario === 'FORBIDDEN_FIRST') { log.push('profile:first:403'); return send(403, 'forbidden'); }
    log.push('profile:first'); return send(200, firstProfile[scenario]());
  }
  if (host === 'www.douyin.com' && p === pathOf(second)) { log.push('profile:second'); return send(200, secondProfile[scenario]()); }
  if (host === 'live.douyin.com' && p === '/' + second.roomId) { log.push('room:second'); return send(200, room(second)); }
  if (host === 'live.douyin.com' && p === '/' + first.roomId) { log.push('room:first'); return send(200, room(first, scenario === 'ROOM_TITLE_EMPTY')); }
  if (host === 'live.douyin.com' && p === '/' + FOREIGN) { log.push('room:foreign'); return send(200, page('', '<main></main>')); }
  log.push(host === 'www.douyin.com' || host === 'live.douyin.com' ? 'douyin:other-path' : 'other-host');
  send(404, 'nf', 'text/plain');
}).listen(443, '127.0.0.1', () => console.error('READY'));
process.on('SIGTERM', () => { fs.writeFileSync(work + '/' + scenario + '/server-log.json', JSON.stringify(log)); process.exit(0); });
