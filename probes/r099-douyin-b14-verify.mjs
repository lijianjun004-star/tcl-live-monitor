// R0.9.9 B14: read-only identity + status verification of 14 Douyin candidates by secUid.
// Identity is what the platform itself shows for the secUid (title name + 抖音号 on the page);
// claimed names/IDs are only compared, never trusted. Status reuses decideDouyin (two-page
// corroboration). Never emits OFFLINE (offline rule not validated). Candidates never score.
// Stops the whole Douyin run on the first access cue (captcha / login redirect); the rest = NOT_RUN.
import fs from 'node:fs/promises';
import { chromium } from 'playwright';
import { decideDouyin, liveAnchorRoomIds } from './lib/douyin.mjs';
import { accessCue } from './lib/access-cue.mjs';
import { platformNameFromTitle } from './lib/r099-identity.mjs';

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? Number(process.argv[i + 1]) : d; };
const ROUNDS = Math.min(Math.max(arg('--rounds', 2), 1), 4);
const INTERVAL_MIN = Math.min(Math.max(arg('--interval-min', 5), 1), 15);
const { candidates } = JSON.parse(await fs.readFile('config/r099-douyin-b14.json', 'utf8'));
const SEC_RE = /^MS4wLjABAAAA[\w-]{20,}$/;
const BRAND_RE = /(TCL|雷鸟|FFALCON|RayNeo)/i;
const norm = s => String(s || '').replace(/\s+/g, '');


const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
// Same context as the historical passing Douyin probe (mobile viewport, no UA override).
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'zh-CN' });
async function snapshot(url) {
  const page = await ctx.newPage();
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(6000);
    const data = await page.evaluate(() => {
      const text = document.body?.innerText || '';
      return {
        title: document.title, bodyExcerpt: text.replace(/\s+/g, ' ').slice(0, 3000),
        metaDescription: document.querySelector('meta[name="description"]')?.content || '',
        douyinIdsInPage: [...text.matchAll(/抖音号[:：]\s*([A-Za-z0-9._-]{3,32})/g)].map(m => m[1]),
        liveRoomAnchors: [...document.querySelectorAll('a[href]')].filter(a => /^https:\/\/live\.douyin\.com\/\d/.test(a.href))
          .map(a => ({ href: a.href, text: (a.innerText || a.textContent || '').replace(/\s+/g, ' ').slice(0, 60) })).slice(0, 15),
      };
    });
    const final = new URL(page.url());
    return { httpStatus: resp?.status() ?? null, finalHost: final.hostname, finalPath: final.pathname.slice(0, 80), ...data };
  } catch (e) { return { httpStatus: null, navigationError: String(e?.message || e).slice(0, 120) }; }
  finally { await page.close().catch(() => {}); }
}

const rows = []; let stopped = null;
try {
  for (let r = 1; r <= ROUNDS; r++) {
    const t0 = Date.now();
    for (const c of candidates) {
      const base = { round: r, key: c.key, secUid: c.secUid, claimedNames: c.claimedNames, claimedDouyinId: c.claimedDouyinId, claimedRoomId: c.claimedRoomId,
        scoringEligible: false, ownershipVerified: false };
      if (stopped) { rows.push({ ...base, at: new Date().toISOString(), state: 'NOT_RUN', reason: 'DOUYIN_PAUSED_AFTER_ACCESS_CUE', stoppedBy: stopped }); continue; }
      if (!SEC_RE.test(c.secUid)) { rows.push({ ...base, state: 'NOT_RUN', reason: 'INVALID_SECUID' }); continue; }
      const profile = await snapshot(c.profileUrl);
      let cue = accessCue({ ...profile, text: profile.bodyExcerpt });
      const platformName = platformNameFromTitle(profile.title);
      const pageIds = [...new Set(profile.douyinIdsInPage || [])];
      // roomId = claimed id so decideDouyin's roomIdChanged compares against the claim (run 42354838292 mislabelled every LIVE as changed)
      const observed = { accountName: platformName, displayDouyinId: pageIds.length === 1 ? pageIds[0] : null, roomId: c.claimedRoomId || undefined };
      let room = null, d;
      if (cue) { stopped = { key: c.key, round: r, ...cue }; d = { state: 'UNKNOWN', reason: 'ACCESS_CUE_STOPPED' }; }
      else if (profile.navigationError) d = { state: 'UNKNOWN', reason: 'PROFILE_NAVIGATION_ERROR' };
      else if (!platformName || !observed.displayDouyinId) d = { state: 'UNKNOWN', reason: !platformName ? 'PROFILE_TITLE_NOT_RECOGNIZED' : (pageIds.length ? 'MULTIPLE_DOUYIN_IDS_ON_PAGE' : 'DOUYIN_ID_NOT_ON_PAGE') };
      else {
        const ids = liveAnchorRoomIds(profile);
        if (ids[0]) {
          await new Promise(res => setTimeout(res, 5000));
          room = await snapshot(`https://live.douyin.com/${ids[0]}`);
          cue = accessCue({ ...room, text: room.bodyExcerpt });
          if (cue) stopped = { key: c.key, round: r, page: 'room', ...cue };
        }
        d = stopped ? { state: 'UNKNOWN', reason: 'ACCESS_CUE_STOPPED' } : decideDouyin(profile, room, observed);
        if (d.state === 'OFFLINE') d = { ...d, state: 'UNKNOWN', reason: 'OFFLINE_RULE_NOT_VALIDATED' }; // belt and braces
      }
      const row = { ...base, at: new Date().toISOString(),
        identity: { http: profile.httpStatus ?? null, finalHost: profile.finalHost ?? null, finalPath: profile.finalPath ?? null,
          platformName, douyinIdOnPage: observed.displayDouyinId, douyinIdsOnPage: pageIds.slice(0, 3),
          brandMatch: platformName ? BRAND_RE.test(platformName) : null,
          claimNameMatch: platformName ? c.claimedNames.some(n => norm(n) === norm(platformName)) : null,
          claimDouyinIdMatch: c.claimedDouyinId && observed.displayDouyinId ? c.claimedDouyinId === observed.displayDouyinId : null,
          ip: /IP属地[:：]\s*(\S{2,6})/.exec(profile.bodyExcerpt || '')?.[1] || null,
          followers: /粉丝\s*([\d.]+万?)/.exec(profile.bodyExcerpt || '')?.[1] || null },
        liveRoomIds: liveAnchorRoomIds(profile), roomHttp: room?.httpStatus ?? null, roomTitle: room?.title ?? null,
        roomIdMatchesClaim: c.claimedRoomId && d.observedRoomId ? c.claimedRoomId === d.observedRoomId : null,
        state: d.state, reason: d.reason, stopEvidence: cue || null };
      rows.push(row);
      console.log('b14 ' + JSON.stringify({ round: r, key: c.key, http: row.identity.http, name: platformName, douyinId: observed.displayDouyinId,
        brand: row.identity.brandMatch, nameMatch: row.identity.claimNameMatch, idMatch: row.identity.claimDouyinIdMatch, ip: row.identity.ip,
        followers: row.identity.followers, live: row.liveRoomIds, roomTitle: row.roomTitle, state: row.state, reason: row.reason, stop: row.stopEvidence?.kind || null }));
      await new Promise(res => setTimeout(res, 5000));
    }
    if (r < ROUNDS && !stopped) await new Promise(res => setTimeout(res, Math.max(0, t0 + INTERVAL_MIN * 60000 - Date.now())));
  }
} finally {
  await browser.close();
  await fs.writeFile('r099-douyin-b14.json', JSON.stringify({ at: new Date().toISOString(), rounds: ROUNDS, stopped, rows }, null, 1));
  console.log('stopped=' + JSON.stringify(stopped));
}
