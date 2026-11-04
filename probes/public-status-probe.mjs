// Read-only public guest status probe for user-approved targets only.
// Manual trigger only (workflow_dispatch). No login, cookies, tokens, signatures, captcha
// handling, request replay or scheduled cron. Output: probe-report.json (no raw payloads).
//
// Usage: node probes/public-status-probe.mjs [--rounds N] [--interval-min M]
import fs from 'node:fs/promises';
import { chromium } from 'playwright';
import { LIVE_PAGE, LIVE_DETAIL_HOST, LIVE_DETAIL_PATH, parseJSONOrJSONP, classifyTmall, pickBest } from './lib/tmall.mjs';
import { decideDouyin, liveAnchorRoomIds, profileIdentity } from './lib/douyin.mjs';
import { sanitizeEndpoint, extractStatusFields } from './lib/safe-network.mjs';

const arg = (name, def) => { const i = process.argv.indexOf(name); return i > 0 ? Number(process.argv[i + 1]) : def; };
const ROUNDS = Math.min(Math.max(arg('--rounds', 1), 1), 12);
const INTERVAL_MIN = Math.min(Math.max(arg('--interval-min', 5), 1), 15);
const cfg = JSON.parse(await fs.readFile('config/probe-targets.json', 'utf8'));
if (cfg.schemaVersion !== 1) throw Error('bad config');
if (!cfg.tmall.every(t => t.userConfirmed === true)) throw Error('tmall target not user-confirmed');
if (!cfg.douyin.every(t => t.scopeApproved === true)) throw Error('douyin target not approved');
for (const t of cfg.douyin) {
  const u = new URL(t.profileUrl);
  if (u.protocol !== 'https:' || u.hostname !== 'www.douyin.com' || !u.pathname.startsWith('/user/') || !/^\d{5,24}$/.test(t.roomId)) throw Error('bad douyin target');
}
const OFFLINE_RULE_VALIDATED = cfg.douyinOfflineRuleValidated === true;

async function snapshot(page, url, captureStatus) {
  const out = { checkedAt: new Date().toISOString(), httpStatus: null, statusFields: [] };
  const pending = [];
  if (captureStatus) page.on('response', res => {
    let type; try { type = res.request().resourceType(); } catch { return; }
    if (type !== 'fetch' && type !== 'xhr') return;
    const ep = sanitizeEndpoint(res.url());
    if (!ep || !/webcast|\/room/i.test(ep.pathname) || pending.length > 30) return;
    pending.push((async () => {
      try {
        if (res.status() !== 200 || !/json|text\/plain/i.test(String(res.headers()['content-type'] || ''))) return;
        const body = await res.body(); if (body.length > 600000) return;
        for (const f of extractStatusFields(JSON.parse(body.toString('utf8')))) out.statusFields.push({ endpoint: ep.pathname.slice(0, 60), ...f });
      } catch {}
    })());
  });
  try {
    const r = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    out.httpStatus = r?.status() ?? null;
    await page.waitForTimeout(5000);
    Object.assign(out, await page.evaluate(() => ({
      title: String(document.title || '').slice(0, 150),
      bodyExcerpt: String(document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 1000),
      metaDescription: String(document.querySelector('meta[name="description"]')?.content || '').slice(0, 200),
      liveRoomAnchors: [...document.querySelectorAll('a[href]')].map(a => ({ href: a.href, text: String(a.innerText || a.textContent || '').replace(/\s+/g, ' ').slice(0, 70) }))
        .filter(x => /^https:\/\/live\.douyin\.com\/\d{5,24}/.test(x.href)).slice(0, 15),
    })));
    await Promise.allSettled(pending);
    try { const u = new URL(page.url()); out.finalUrl = u.origin + u.pathname; } catch {}
  } catch (e) { out.navigationError = String(e?.message || e).slice(0, 160); }
  return out;
}

async function probeTmall(context, t) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const page = await context.newPage(); const samples = []; const pending = [];
    page.on('response', res => {
      try {
        const u = new URL(res.url());
        if (u.hostname !== LIVE_DETAIL_HOST || u.pathname !== LIVE_DETAIL_PATH) return;
        pending.push(res.text().then(x => samples.push(classifyTmall(parseJSONOrJSONP(x), t))).catch(() => samples.push({ state: 'UNKNOWN', reason: 'API_RESPONSE_PARSE_ERROR' })));
      } catch {}
    });
    let nav = null;
    try { const r = await page.goto(LIVE_PAGE + encodeURIComponent(t.accountId), { waitUntil: 'domcontentloaded', timeout: 25000 }); nav = r?.status() ?? null; await page.waitForTimeout(7000); await Promise.allSettled(pending); }
    catch { nav = 'NAV_ERROR'; } finally { await page.close().catch(() => {}); }
    const best = pickBest(samples);
    const row = { platform: 'tmall', accountId: t.key, at: Date.now(), attempt, http: nav, responses: samples.length,
      ...(best || { state: 'UNKNOWN', reason: 'NO_LIVE_DETAIL_RESPONSE' }) };
    if (row.state === 'LIVE' || row.state === 'OFFLINE' || attempt === 2) return row;
  }
}

async function probeDouyin(context, t) {
  const pp = await context.newPage(), rp = await context.newPage();
  try {
    const profile = await snapshot(pp, t.profileUrl, false);
    const ids = profileIdentity(profile, t) ? liveAnchorRoomIds(profile) : [];
    const roomId = ids[0] || t.roomId;
    const room = await snapshot(rp, `https://live.douyin.com/${roomId}`, true);
    const d = decideDouyin(profile, room, t, { offlineRuleValidated: OFFLINE_RULE_VALIDATED });
    return { platform: 'douyin', accountId: t.key, at: Date.now(), checkedRoomId: roomId, profileHttp: profile.httpStatus, roomHttp: room.httpStatus,
      profileTitle: profile.title, profileFinalUrl: profile.finalUrl, profileHasIdText: String(profile.bodyExcerpt || '').includes(t.displayDouyinId),
      roomTitle: room.title, ...d };
  } finally { await pp.close().catch(() => {}); await rp.close().catch(() => {}); }
}

const report = { schemaVersion: 1, startedAt: new Date().toISOString(), rounds: ROUNDS, intervalMinutes: INTERVAL_MIN,
  method: 'public guest pages + passive responses; no credentials; manual trigger only',
  douyinOfflineRuleValidated: OFFLINE_RULE_VALIDATED, observations: [] };
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
try {
  for (let r = 1; r <= ROUNDS; r++) {
    const roundStart = Date.now();
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'zh-CN',
      userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36' });
    for (const t of cfg.tmall) { try { report.observations.push({ round: r, ...await probeTmall(context, t) }); } catch (e) { report.observations.push({ round: r, platform: 'tmall', accountId: t.key, at: Date.now(), state: 'UNKNOWN', reason: 'PROBE_ERROR' }); } }
    // Douyin: same context as the historical passing script (no UA override).
    const dyContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'zh-CN' });
    for (const t of cfg.douyin) { try { report.observations.push({ round: r, ...await probeDouyin(dyContext, t) }); } catch (e) { report.observations.push({ round: r, platform: 'douyin', accountId: t.key, at: Date.now(), state: 'UNKNOWN', reason: 'PROBE_ERROR' }); } }
    await context.close(); await dyContext.close();
    console.log(`round ${r}/${ROUNDS}: ` + report.observations.filter(o => o.round === r).map(o => `${o.accountId}=${o.state}${o.offlineCandidate ? '(offline?)' : ''}`).join(' '));
    for (const o of report.observations.filter(o => o.round === r && o.platform === 'douyin' && o.state !== 'LIVE'))
      console.log(`  diag ${o.accountId}: http=${o.profileHttp} title="${o.profileTitle}" final=${o.profileFinalUrl} idText=${o.profileHasIdText} room="${o.roomTitle}" reason=${o.reason}`);
    if (r < ROUNDS) await new Promise(res => setTimeout(res, Math.max(0, roundStart + INTERVAL_MIN * 60000 - Date.now())));
  }
} finally { await browser.close(); }
report.completedAt = new Date().toISOString();
const summary = {};
for (const o of report.observations) {
  const s = summary[o.accountId] ||= { platform: o.platform, LIVE: 0, OFFLINE: 0, UNKNOWN: 0, offlineCandidates: 0, roomIdChanged: 0, reasons: {} };
  s[o.state]++; if (o.offlineCandidate) s.offlineCandidates++; if (o.roomIdChanged) s.roomIdChanged++;
  if (o.reason) s.reasons[o.reason] = (s.reasons[o.reason] || 0) + 1;
}
report.summary = summary;
await fs.writeFile('probe-report.json', JSON.stringify(report, null, 2) + '\n');
const md = ['| 账号 | 平台 | LIVE | OFFLINE | UNKNOWN | 停播候选 | 房间ID变化 | 原因 |', '|---|---|---|---|---|---|---|---|',
  ...Object.entries(summary).map(([k, s]) => `| ${k} | ${s.platform} | ${s.LIVE} | ${s.OFFLINE} | ${s.UNKNOWN} | ${s.offlineCandidates} | ${s.roomIdChanged} | ${Object.entries(s.reasons).map(([a, b]) => `${a}×${b}`).join('; ')} |`)].join('\n');
await fs.writeFile('probe-summary.md', `# 只读复测 ${report.startedAt}\n\n${md}\n\n快照不等于连续直播；UNKNOWN 不等于停播。\n`);
console.log(md);
