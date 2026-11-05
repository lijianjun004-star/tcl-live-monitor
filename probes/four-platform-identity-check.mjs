// Read-only reverse identity check: given a public platform ID, read the name the platform itself
// shows on its public guest page. Results are candidates only (never monitoring/scoring input).
// No login, cookies, tokens, signatures or captcha handling. A platform is skipped for the rest of
// the run as soon as it shows a challenge or login wall.
import fs from 'node:fs/promises';
import { chromium } from 'playwright';
import { LIVE_PAGE, LIVE_DETAIL_HOST, LIVE_DETAIL_PATH, parseJSONOrJSONP } from './lib/tmall.mjs';
import { CHALLENGE_RE } from './lib/douyin.mjs';

const cfg = JSON.parse(await fs.readFile('config/identity-check-targets.json', 'utf8'));
const WALL_RE = /(验证码|安全验证|滑块|captcha|请登录|登录后|扫码登录|passport\.jd\.com|login\.taobao\.com|login\.m\.taobao\.com|risk|风控)/i;
const ID_RE = /^\d{5,16}$/;
const clean = s => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
const out = [];
const blocked = new Set();
const emit = r => { out.push(r); console.log('id-check ' + JSON.stringify(r)); };

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'zh-CN',
  userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36' });
const desktop = await browser.newContext({ viewport: { width: 1366, height: 900 }, locale: 'zh-CN' });

async function pageInfo(ctx, url, waitMs = 6000) {
  const page = await ctx.newPage();
  try {
    const r = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(waitMs);
    const s = await page.evaluate(() => ({ title: document.title, text: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 1500),
      userLinks: [...document.querySelectorAll('a[href*="/user/MS4wLjABAAAA"]')].map(a => ({ href: a.href, text: (a.innerText || '').replace(/\s+/g, ' ').slice(0, 60) })).slice(0, 8) }));
    let finalHost = null; try { finalHost = new URL(page.url()).host; } catch {}
    return { http: r?.status() ?? null, finalHost, finalPath: (() => { try { return new URL(page.url()).pathname.slice(0, 60); } catch { return null; } })(), ...s };
  } catch (e) { return { error: String(e?.message || e).slice(0, 120) }; }
  finally { await page.close().catch(() => {}); }
}
const walled = i => !!(i.error ? false : (WALL_RE.test(`${i.title} ${i.finalHost} ${i.finalPath}`) || CHALLENGE_RE.test(`${i.title} ${i.text?.slice(0, 300)}`)));

// 1) Tmall / Taobao live account: the live page's own live-detail response names the broadcaster.
for (const t of cfg.tmallAccountIds) {
  if (!ID_RE.test(t.id)) { emit({ platform: 'tmall', id: t.id, result: 'INVALID_ID' }); continue; }
  if (blocked.has('tmall-live')) { emit({ platform: 'tmall', id: t.id, result: 'SKIPPED_PLATFORM_WALLED' }); continue; }
  const page = await mobile.newPage(); const seen = [];
  page.on('response', res => { try { const u = new URL(res.url()); if (u.hostname === LIVE_DETAIL_HOST && u.pathname === LIVE_DETAIL_PATH) seen.push(res.text().catch(() => '')); } catch {} });
  let nav = null;
  try { const r = await page.goto(LIVE_PAGE + encodeURIComponent(t.id), { waitUntil: 'domcontentloaded', timeout: 30000 }); nav = r?.status() ?? null; await page.waitForTimeout(8000); } catch { nav = 'NAV_ERROR'; }
  const bodies = await Promise.all(seen); await page.close().catch(() => {});
  let best = null;
  for (const b of bodies) {
    try {
      const j = parseJSONOrJSONP(b); const ret = (j.ret || []).map(x => String(x).split('::')[0]);
      const bc = j?.data?.broadCaster;
      const row = { ret: ret.slice(0, 2), accountId: bc ? String(bc.accountId ?? '') : null, name: bc ? clean(bc.accountName) : null,
        roomNum: bc ? String(bc.roomNum ?? j.data.roomNum ?? '') : null, roomStatus: j?.data?.roomStatus ?? null, streamStatus: j?.data?.streamStatus ?? null };
      if (!best || (row.name && !best.name)) best = row;
    } catch {}
  }
  const result = !best ? 'NO_LIVE_DETAIL_RESPONSE' : best.name ? (best.accountId === t.id ? 'NAME_RESOLVED' : 'ACCOUNT_ID_MISMATCH') : 'API_ERROR';
  emit({ platform: 'tmall', id: t.id, claimedName: t.claimedName, result, http: nav, ...(best || {}),
    live: best?.name ? (Number(best.roomStatus) === 1 && Number(best.streamStatus) === 1) : null });
}
// 1b) Same IDs as a seller user id on the mobile shop page (title = shop name), for those the live page could not name.
for (const t of cfg.tmallAccountIds) {
  if (blocked.has('taobao-shop')) break;
  if (out.find(r => r.platform === 'tmall' && r.id === t.id && r.result === 'NAME_RESOLVED')) continue;
  const i = await pageInfo(mobile, `https://shop.m.taobao.com/shop/shop_index.htm?user_id=${t.id}`);
  const wall = walled(i); if (wall) blocked.add('taobao-shop');
  emit({ platform: 'tmall-shop-by-userid', id: t.id, claimedName: t.claimedName, result: i.error ? 'NAV_ERROR' : wall ? 'WALLED' : 'PAGE_READ', http: i.http, finalHost: i.finalHost, title: clean(i.title), head: clean(i.text?.slice(0, 160)) });
}
// 2) Taobao shop subdomain.
for (const t of cfg.taobaoShopIds) {
  if (blocked.has('taobao-shop')) { emit({ platform: 'taobao', id: t.id, result: 'SKIPPED_PLATFORM_WALLED' }); continue; }
  const i = await pageInfo(desktop, `https://shop${t.id}.taobao.com/`);
  const wall = walled(i); if (wall) blocked.add('taobao-shop');
  emit({ platform: 'taobao', id: t.id, claimedName: t.claimedName, result: i.error ? 'NAV_ERROR' : wall ? 'WALLED' : 'PAGE_READ', http: i.http, finalHost: i.finalHost, title: clean(i.title), head: clean(i.text?.slice(0, 160)) });
}
// 3) JD shop pages (desktop mall page, then mobile shop page).
for (const t of cfg.jdShopIds) {
  if (!ID_RE.test(t.id)) { emit({ platform: 'jd', id: t.id, result: 'INVALID_ID' }); continue; }
  for (const [label, ctx, url] of [['mall', desktop, `https://mall.jd.com/index-${t.id}.html`], ['m', mobile, `https://shop.m.jd.com/?shopId=${t.id}`]]) {
    if (blocked.has('jd-' + label)) { emit({ platform: 'jd-' + label, id: t.id, result: 'SKIPPED_PLATFORM_WALLED' }); continue; }
    const i = await pageInfo(ctx, url);
    const wall = walled(i); if (wall) blocked.add('jd-' + label);
    emit({ platform: 'jd-' + label, id: t.id, claimedName: t.claimedName, result: i.error ? 'NAV_ERROR' : wall ? 'WALLED' : 'PAGE_READ', http: i.http, finalHost: i.finalHost, finalPath: i.finalPath, title: clean(i.title), head: clean(i.text?.slice(0, 160)) });
  }
}
// 4) Douyin public video page -> author profile link (secUid) -> profile 抖音号.
for (const t of cfg.douyinVideoIds) {
  if (!/^\d{15,22}$/.test(t.id)) { emit({ platform: 'douyin', id: t.id, result: 'INVALID_ID' }); continue; }
  if (blocked.has('douyin')) { emit({ platform: 'douyin', id: t.id, result: 'SKIPPED_PLATFORM_WALLED' }); continue; }
  const v = await pageInfo(desktop, `https://www.douyin.com/video/${t.id}`, 8000);
  if (walled(v)) { blocked.add('douyin'); emit({ platform: 'douyin', id: t.id, claimedAuthor: t.claimedAuthor, result: 'WALLED', title: clean(v.title) }); continue; }
  const link = (v.userLinks || []).find(l => l.text) || (v.userLinks || [])[0];
  const secUid = link ? /\/user\/(MS4wLjABAAAA[\w-]{20,})/.exec(link.href)?.[1] : null;
  let prof = null;
  if (secUid) {
    await new Promise(r => setTimeout(r, 3000));
    const p = await pageInfo(mobile, `https://www.douyin.com/user/${secUid}`, 6000);
    if (walled(p)) blocked.add('douyin');
    prof = { title: clean(p.title), douyinId: /抖音号[:：]\s*([A-Za-z0-9._-]{3,32})/.exec(p.text || '')?.[1] || null,
      ip: /IP属地[:：]\s*(\S{2,6})/.exec(p.text || '')?.[1] || null, followers: /粉丝\s*([\d.]+万?)/.exec(p.text || '')?.[1] || null, walled: walled(p) };
  }
  emit({ platform: 'douyin', id: t.id, claimedAuthor: t.claimedAuthor, result: secUid ? 'AUTHOR_RESOLVED' : (v.error ? 'NAV_ERROR' : 'AUTHOR_NOT_FOUND'),
    videoTitle: clean(v.title), authorText: link ? clean(link.text) : null, secUid, profile: prof });
  await new Promise(r => setTimeout(r, 3000));
}
await browser.close();
await fs.writeFile('identity-check-report.json', JSON.stringify({ at: new Date().toISOString(), blocked: [...blocked], results: out }, null, 1));
console.log('blocked=' + JSON.stringify([...blocked]));
