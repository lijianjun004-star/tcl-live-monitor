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
const R323 = ['REAL_LAYOUT', 'FOREIGN_BADGE', 'ROOM_TITLE_EMPTY', 'RAW_ROOM'].includes(scenario);
const pathOf = t => new URL(t.profileUrl).pathname;
const page = (title, body, head = '') => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${head}</head><body>${body}</body></html>`;
const header = (t, inner = '') => `<div data-e2e="user-info"><h1>${t.accountName}</h1><span>抖音号：${t.displayDouyinId}</span>${inner}</div>`;
const liveLink = id => `<a href="https://live.douyin.com/${id}">直播中</a>`;
// R3.23: live entries rendered OUTSIDE every owner container, as on the real pages.
const outside = ids => ids.map(id => `<section data-e2e="live-entry">${liveLink(id)}</section>`).join('');
const profile = (t, liveInHeader, outsideIds = []) => page(R323 ? '' : `${t.accountName}的抖音 - 抖音`,
  `<main>${header(t, liveInHeader ? liveLink(t.roomId) : '')}${outside(outsideIds)}</main>`);
// R3.24: raw server payloads (as RENDER_DATA or a streamed chunk) and JS/CSS from a host outside the
// approved CDNs, like the real room page in approved run 43454668656. Synthetic structure.
const payload = (t, status) => ({ roomInfo: { web_rid: String(t.roomId), room: { status, owner: { sec_uid: pathOf(t).split('/').pop(), nickname: t.accountName } } } });
const ssr = (t, kind) => kind === 'RENDER_DATA'
  ? `<script id="RENDER_DATA" type="application/json">${encodeURIComponent(JSON.stringify({ app: payload(t, 2) }))}</script>`
  : kind === 'PACE' ? `<script>(self.__pace_f=self.__pace_f||[]).push([1,${JSON.stringify(JSON.stringify(payload(t, 4)))}])</script>` : '';
const foreignStatic = '<link rel="stylesheet" href="https://static.synthetic-cdn.test/room.css"><script src="https://static.synthetic-cdn.test/room.js"></script>';
const room = (t, emptyTitle = false, kind = null) => page(emptyTitle ? '' : `${t.accountName}的抖音直播间 - 抖音直播`,
  `<main><div data-e2e="room-owner"><a href="${t.profileUrl}">${t.accountName}</a></div><video></video></main>${ssr(t, kind)}`,
  `<meta name="description" content="欢迎来到${t.accountName}的抖音直播间">${kind ? foreignStatic : ''}`);
// R3.25: a "直播回放" entry on the first profile (REAL_LAYOUT) for the private replay diagnostics.
const withReplay = html => html.replace('</main>', '<section data-e2e="live-replay"><span>直播回放</span></section></main>');
// R3.26: an UNRENDERED room page as in approved run 43464891978: empty title, no meta, no owner link;
// identity only in the raw streamed payload (roomStore.roomInfo.room.owner / web_rid + anchor).
const rawRoom = t => { const sec = pathOf(t).split('/').pop(); const o = { id_str: '111', sec_uid: sec, nickname: t.accountName };
  const st = { state: { roomStore: { roomInfo: { room: { id_str: '7000000000000000001', status: 2, owner: o }, roomId: '7000000000000000001', web_rid: String(t.roomId), anchor: o } } } };
  return page('', `<main></main><script>(self.__pace_f=self.__pace_f||[]).push([1,${JSON.stringify(JSON.stringify(st))}])</script>`, foreignStatic); };
const firstProfile = { RAW_ROOM: () => profile(first, false, [first.roomId]), NORMAL: () => profile(first, false), REAL_LAYOUT: () => withReplay(profile(first, false, [first.roomId])),
  FOREIGN_BADGE: () => profile(first, false, [FOREIGN]), ROOM_TITLE_EMPTY: () => profile(first, false, [first.roomId]) };
const secondProfile = { RAW_ROOM: () => profile(second, false), NORMAL: () => profile(second, true), REAL_LAYOUT: () => profile(second, false),
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
  if (host === 'live.douyin.com' && p === '/' + first.roomId) { log.push('room:first');
    if (scenario === 'RAW_ROOM') return send(200, rawRoom(first));
    return send(200, room(first, scenario === 'ROOM_TITLE_EMPTY', scenario === 'REAL_LAYOUT' ? 'RENDER_DATA' : scenario === 'ROOM_TITLE_EMPTY' ? 'PACE' : null)); }
  if (host === 'live.douyin.com' && p === '/' + FOREIGN) { log.push('room:foreign'); return send(200, page('', '<main></main>')); }
  log.push(host === 'www.douyin.com' || host === 'live.douyin.com' ? 'douyin:other-path' : 'other-host');
  send(404, 'nf', 'text/plain');
}).listen(443, '127.0.0.1', () => console.error('READY'));
process.on('SIGTERM', () => { fs.writeFileSync(work + '/' + scenario + '/server-log.json', JSON.stringify(log)); process.exit(0); });
