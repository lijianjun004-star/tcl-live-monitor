/**
 * R3.16 public-visitor Douyin observation, ONE pass, at most two in-scope accounts.
 * Mobile viewport, no login, no cookies supplied, no UA spoofing, no stealth, no proxy.
 * Stops the whole run on HTTP 401/403/429, login/verify redirect or challenge text.
 * HTTP 200 is not LIVE; no live badge is not OFFLINE; LIVE needs profile identity + room page identity.
 * PUBLIC log: key + booleans + state/reason only (no secUid, no names, no room ids).
 */
import fs from 'node:fs/promises';
import { chromium } from 'playwright';
import { decideDouyin, liveAnchorRoomIds, CHALLENGE_RE } from '../lib/douyin.mjs';

if (process.env.R316_RPA_ONCE !== 'TWO_ACCOUNTS_ONE_PASS') throw Error('R316_RPA_GUARD_REQUIRED');
const { targets, maxPerRun } = JSON.parse(await fs.readFile('config/r316-douyin-rpa-targets.json', 'utf8'));
const registry = JSON.parse(await fs.readFile('config/probe-targets.json', 'utf8'));
if (!Array.isArray(targets) || targets.length > 2 || maxPerRun !== 2 || new Set(targets.map(t => t.key)).size !== targets.length) throw Error('RPA_TARGET_LIMIT');
const approved = new Map((registry.douyin || []).filter(x => x.scopeApproved === true).map(x => [x.key, x]));
const selected = targets.map(t => {
  if (!t || typeof t.key !== 'string' || Object.keys(t).some(k => k !== 'key') || !approved.has(t.key)) throw Error('RPA_TARGET_NOT_SCOPE_APPROVED');
  return approved.get(t.key);
});
const STOP_PATH = /(login|passport|verify|captcha|sso)/i;
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'zh-CN' });
// Explicit network boundary: only public GET/HEAD on douyin.com; block subresource streams,
// non-GET verbs, third-party hosts, WebSockets and media. Never send account credentials.
const blocked = new Map(); // report only hostname/type counts to diagnose missing first-party assets
await ctx.route('**/*', route => {
  const req = route.request(), u = new URL(req.url());
  const hostAllowed = u.protocol === 'https:' && (u.hostname === 'douyin.com' || u.hostname.endsWith('.douyin.com'));
  if (hostAllowed && ['GET', 'HEAD'].includes(req.method()) && !['media', 'eventsource'].includes(req.resourceType())) return route.continue();
  const k = !hostAllowed ? 'host:' + u.hostname : 'type:' + req.resourceType() + '/' + req.method();
  blocked.set(k, (blocked.get(k) || 0) + 1);
  return route.abort('blockedbyclient');
});
// Browser route() cannot intercept WebSockets; explicitly terminate WebSocket sessions.
await ctx.routeWebSocket(/.*/, ws => { blocked.set('websocket', (blocked.get('websocket') || 0) + 1); ws.close(); });
let stopped = null; const pub = [], priv = [];
let activeKey = null;
// A 401/403/429 from ANY page response is an access-limit signal, not just
// from the top-level navigation. Close pages to prevent further browsing.
ctx.on('response', response => {
  const code = response.status();
  if (![401, 403, 429].includes(code) || stopped) return;
  stopped = { key: activeKey || 'PRE_NAVIGATION', reason: 'HTTP_' + code + '_RESOURCE' };
  for (const page of ctx.pages()) void page.close().catch(() => {});
});
async function snap(url) {
  const page = await ctx.newPage();
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(6000);
    const data = await page.evaluate(() => {
      const text = document.body?.innerText || '';
      return { title: document.title, bodyExcerpt: text.replace(/\s+/g, ' ').slice(0, 3000),
        metaDescription: document.querySelector('meta[name="description"]')?.content || '',
        douyinIdsInPage: [...text.matchAll(/抖音号[:：]\s*([A-Za-z0-9._-]{3,32})/g)].map(m => m[1]),
        liveRoomAnchors: [...document.querySelectorAll('a[href]')].filter(a => /^https:\/\/live\.douyin\.com\/\d/.test(a.href))
          .map(a => ({ href: a.href, text: (a.innerText || a.textContent || '').replace(/\s+/g, ' ').slice(0, 60) })).slice(0, 15) };
    });
    const f = new URL(page.url());
    return { httpStatus: resp?.status() ?? null, finalHost: f.hostname, finalPath: f.pathname.slice(0, 80), ...data };
  } catch (e) { return { httpStatus: null, navigationError: String(e?.name || 'NAV_ERROR').slice(0, 40) }; }
  finally { await page.close().catch(() => {}); }
}
const stopOf = s => !s ? null : s.navigationError ? 'NAVIGATION_ERROR' : [401, 403, 429].includes(s.httpStatus) ? 'HTTP_' + s.httpStatus
  : (s.finalHost && !/(^|\.)douyin\.com$/.test(s.finalHost)) ? 'REDIRECT_OFF_DOUYIN'
  : STOP_PATH.test(s.finalPath || '') ? 'LOGIN_OR_VERIFY_REDIRECT'
  : CHALLENGE_RE.test(`${s.title} ${s.bodyExcerpt}`) ? 'CHALLENGE_TEXT' : null;
try {
  for (const t of selected) {
    activeKey = t.key;
    const at = new Date().toISOString();
    if (stopped) { pub.push({ key: t.key, at, state: 'NOT_RUN', reason: 'STOPPED_AFTER_ACCESS_LIMIT' }); continue; }
    const profile = await snap(t.profileUrl);
    let reasonStop = stopped?.reason || stopOf(profile), room = null;
    if (!reasonStop && !stopped && !profile.navigationError) {
      const ids = liveAnchorRoomIds(profile);
      if (ids[0]) { await new Promise(r => setTimeout(r, 5000)); room = await snap(`https://live.douyin.com/${ids[0]}`); reasonStop = stopped?.reason || stopOf(room); }
    }
    let d;
    if (reasonStop) { stopped ||= { key: t.key, reason: reasonStop }; d = { state: 'UNKNOWN', reason: 'STOPPED_' + reasonStop }; }
    else if (profile.navigationError) d = { state: 'UNKNOWN', reason: 'PROFILE_NAVIGATION_ERROR' };
    else d = decideDouyin(profile, room, { accountName: t.accountName, displayDouyinId: t.displayDouyinId, roomId: t.roomId || undefined }); // registry room id, if previously verified
    if (d.state === 'OFFLINE') d = { ...d, state: 'UNKNOWN', reason: 'OFFLINE_RULE_NOT_VALIDATED' };
    const ids = profile.navigationError ? [] : liveAnchorRoomIds(profile);
    pub.push({ key: t.key, at, profileHttp: profile.httpStatus ?? null, roomHttp: room?.httpStatus ?? null,
      profileIdentityVerified: d.profileIdentityVerified === true, liveBadgeSeen: ids.length > 0,
      roomIdentityVerified: d.roomPageIdentityVerified === true, state: d.state, reason: d.reason, stop: reasonStop });
    priv.push({ key: t.key, at, profileTitle: profile.title, finalHost: profile.finalHost, finalPath: profile.finalPath,
      douyinIdsInPage: profile.douyinIdsInPage, liveRoomIds: ids, roomTitle: room?.title ?? null, roomMeta: room?.metaDescription?.slice(0, 120) ?? null,
      observedRoomId: d.observedRoomId ?? null, decision: d });
    await new Promise(r => setTimeout(r, 5000));
  }
} finally {
  await browser.close();
  await fs.mkdir('out/r316-private', { recursive: true });
  await fs.writeFile('out/r316-private/rpa.json', JSON.stringify({ at: new Date().toISOString(), priv }));
  for (const p of pub) console.log('R316_RPA ' + JSON.stringify(p));
  console.log('R316_RPA_STOPPED ' + JSON.stringify(stopped));
  console.log('R316_RPA_BLOCKED ' + JSON.stringify(Object.fromEntries([...blocked].sort((a,b)=>b[1]-a[1]).slice(0,40))));
}
