/**
 * R3.16 public-visitor Douyin observation, ONE pass, at most two in-scope accounts.
 * Mobile viewport, no login, no cookies supplied, no UA spoofing, no stealth, no proxy.
 * Stops the whole run on HTTP 401/403/429, login/verify redirect or challenge text.
 * HTTP 200 is not LIVE; no live badge is not OFFLINE; LIVE needs profile identity + room page identity.
 * PUBLIC log: key + booleans + state/reason only (no secUid, no names, no room ids).
 */
import fs from 'node:fs/promises';
import { chromium } from 'playwright';
import { decideDouyin, profileIdentityEvidence, liveAnchorRoomIds, liveAnchorScope, CHALLENGE_RE } from '../lib/douyin.mjs';
import { CORE_STATIC_CANDIDATES, UNKNOWN_STATIC_CANDIDATES } from '../r318/douyin-static-policy.mjs';
import { guardedRoute, disableUnroutedChannels } from '../r320/network-guard.mjs';

if (process.env.R316_RPA_ONCE !== 'TWO_ACCOUNTS_ONE_PASS') throw Error('R316_RPA_GUARD_REQUIRED');
// Explicitly approved, once-only experimental scope. Any misspelled flag fails closed.
const CDN_FLAG = 'TWO_APPROVED_CDNS_JS_CSS_ONLY';
if (process.env.R319_CORE_CDN_APPROVED_ONCE && process.env.R319_CORE_CDN_APPROVED_ONCE !== CDN_FLAG)
  throw Error('R319_CDN_FLAG_INVALID');
const approvedCoreStatic = process.env.R319_CORE_CDN_APPROVED_ONCE === CDN_FLAG;
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
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'zh-CN', serviceWorkers: 'block' });
await ctx.addInitScript(disableUnroutedChannels);
// Explicit network boundary: only public GET/HEAD on douyin.com; block subresource streams,
// non-GET verbs, third-party hosts, WebSockets and media. Never send account credentials.
const blocked = new Map(); // report only domain/type aggregates; never paths or cookies
const allowedCoreCdn = new Map();
// Every network request is fetched ONLY once with maxRedirects=0.
// Never route.continue: that leaks redirected second hops to Chromium.
await ctx.route('**/*', route => guardedRoute(route,{
  approvedCoreStatic,
  isStopped:()=>Boolean(stopped),
  stop:(reason,evidence=null)=>{
    if(stopped) return;
    stopped={key:activeKey || 'PRE_NAVIGATION',reason};
    stopEvidence=evidence;
    for(const page of ctx.pages()) void page.close().catch(()=>{});
  },
  tallyAllowed:(info,why)=>{
    if(why !== 'EXPLICITLY_APPROVED_CORE_STATIC') return;
    const u=new URL(info.url);
    const key=u.hostname+':'+info.resourceType;
    allowedCoreCdn.set(key,(allowedCoreCdn.get(key)||0)+1);
  },
  tallyBlocked:(info,why)=>{
    let host='OTHER';
    try {
      const u=new URL(info.url);
      if([...CORE_STATIC_CANDIDATES,...UNKNOWN_STATIC_CANDIDATES].includes(u.hostname)) host=u.hostname;
    } catch {}
    const key=host+':'+info.resourceType+':'+why;
    blocked.set(key,(blocked.get(key)||0)+1);
  }
}));
// Browser route() cannot intercept WebSockets; explicitly terminate WebSocket sessions.
await ctx.routeWebSocket(/.*/, ws => { blocked.set('websocket', (blocked.get('websocket') || 0) + 1); ws.close(); });
let stopped = null, stopEvidence = null; const pub = [], priv = [];
let activeKey = null;
// A 401/403/429 from ANY page response is an access-limit signal, not just
// from the top-level navigation. Close pages to prevent further browsing.
ctx.on('response', response => {
  const code = response.status();
  if (stopped) return;
  const location = response.headers()['location'];
  let redirectToAccessGate = false;
  if (code >= 300 && code < 400 && location) {
    try {
      const destination = new URL(location, response.url());
      redirectToAccessGate = /(?:login|passport|verify|captcha|sso)/i.test(destination.pathname);
    } catch { redirectToAccessGate = true; }
  }
  if (![401, 403, 429].includes(code) && !redirectToAccessGate) return;
  stopped = { key: activeKey || 'PRE_NAVIGATION',
    reason: redirectToAccessGate ? 'ACCESS_GATE_REDIRECT_RESOURCE' : 'HTTP_' + code + '_RESOURCE' };
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
          .map(a => ({ href: a.href,
            ownerScoped: Boolean(a.closest('[data-e2e="user-info"], [data-e2e="profile-header"], [data-e2e="author-info"]')),
            text: (a.innerText || a.textContent || '').replace(/\s+/g, ' ').slice(0, 60) })).slice(0, 15),
        ownerProfileLinks: [...document.querySelectorAll('a[href^="https://www.douyin.com/user/"]')]
          .filter(a=>a.closest('[data-e2e="anchor-info"], [data-e2e="room-owner"]'))
          .map(a=>a.href).slice(0,5),
        mainPlayerEndedText: document.querySelector('[data-e2e="player-ended"], [data-e2e="live-ended"]')?.textContent?.trim().slice(0,120) || '' };
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
    // A live badge on an UNVERIFIED profile is not permission to visit its room.
    const profileEvidence = profileIdentityEvidence(profile, { ...t, profileUrl: t.profileUrl });
    if (!reasonStop && !stopped && profileEvidence.verified) {
      const scope=liveAnchorScope(profile);
      if (scope.roomId) {
        await new Promise(r => setTimeout(r, 5000));
        if(!stopped) { room = await snap(`https://live.douyin.com/${scope.roomId}`); reasonStop = stopped?.reason || stopOf(room); }
      }
    }
    let d;
    if (reasonStop) { stopped ||= { key: t.key, reason: reasonStop }; d = { state: 'UNKNOWN', reason: 'STOPPED_' + reasonStop }; }
    else d = decideDouyin(profile, room, { accountName: t.accountName, displayDouyinId: t.displayDouyinId, roomId: t.roomId || undefined, profileUrl: t.profileUrl }, { strictRoomOwner: true }); // registry room id, if previously verified
    if (d.state === 'OFFLINE') d = { ...d, state: 'UNKNOWN', reason: 'OFFLINE_RULE_NOT_VALIDATED' };
    const ids = profile.navigationError ? [] : liveAnchorRoomIds(profile);
    pub.push({ key: t.key, at, profileHttp: profile.httpStatus ?? null, roomHttp: room?.httpStatus ?? null,
      profileIdentityVerified: d.profileIdentityVerified === true, liveBadgeSeen: ids.length > 0,
      roomIdentityVerified: d.roomPageIdentityVerified === true,
      ownerAnchorScope: liveAnchorScope(profile).scope,
      profileSignals: { titleExact: profileEvidence.titleExact, idExact: profileEvidence.idExact,
        finalUrlExact: profileEvidence.finalUrlExact, multipleVisibleIds: profileEvidence.multipleVisibleIds },
      state: d.state, reason: d.reason, stop: reasonStop });
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
  console.log('R321_STOP_EVIDENCE ' + JSON.stringify(stopEvidence));
  console.log('R316_RPA_BLOCKED ' + JSON.stringify(Object.fromEntries([...blocked].sort((a,b)=>b[1]-a[1]).slice(0,40))));
  console.log('R319_CORE_CDN_ALLOWED ' + JSON.stringify(Object.fromEntries([...allowedCoreCdn].sort((a,b)=>b[1]-a[1]))));
  // Retain a SANITIZED, account-key-only summary as a short-lived GitHub artifact.
  await fs.writeFile('out/r316-rpa-public.json', JSON.stringify({
    schemaVersion:319, mode:approvedCoreStatic ? 'APPROVED_TWO_CORE_CDNS_JS_CSS_ONE_PASS' : 'DEFAULT_BLOCKED_ONE_PASS', at:new Date().toISOString(),
    checked:pub, stopped, stopEvidence,
    approvedCoreCdnCount:Object.fromEntries([...allowedCoreCdn].sort((a,b)=>b[1]-a[1])),
    blockedHostsAndTypes:Object.fromEntries([...blocked].sort((a,b)=>b[1]-a[1]).slice(0,40)),
    formalOpeningRatePercent:null, formalFullDurationRatePercent:null,
  },null,2)+'\n');
  if(stopped) process.exitCode = 3;
}
