// R0.9.9 JD identity loop (read-only, public guest pages):
//   ops link-map SKU -> item.jd.com/<sku>.html -> shop name / shop id / self-operated tag / category path
//   -> mall.jd.com/index-<shopId>.html -> any public live entry (lives.jd.com / "直播") and its id.
// SKU is a product id and is never treated as a shop id. Stops JD on passport/risk/captcha pages.
import fs from 'node:fs/promises';
import { chromium } from 'playwright';
import { accessCue } from './lib/access-cue.mjs';

const cfg = JSON.parse(await fs.readFile('config/r099-jd-room-skus.json', 'utf8'));
const RISK_RE = /(验证|安全检测|访问频繁|risk|passport)/i;
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, locale: 'zh-CN' });
let stopped = null; const rows = [];

async function read(url, extract) {
  const page = await ctx.newPage();
  try {
    const r = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(6000);
    const final = new URL(page.url());
    const data = await page.evaluate(extract);
    const cue = accessCue({ title: data.title, text: data.text || '', finalHost: final.hostname, finalPath: final.pathname })
      || (/^(passport|cfe|risk)\./.test(final.hostname) || RISK_RE.test(final.pathname) ? { kind: 'JD_RISK_OR_LOGIN_REDIRECT', matched: final.hostname + final.pathname.slice(0, 40) } : null);
    return { http: r?.status() ?? null, finalHost: final.hostname, finalPath: final.pathname.slice(0, 60), cue, ...data };
  } catch (e) { return { error: String(e?.message || e).slice(0, 120) }; }
  finally { await page.close().catch(() => {}); }
}

const itemExtract = () => {
  const text = (document.body?.innerText || '').replace(/\s+/g, ' ');
  const shopLinks = [...document.querySelectorAll('a[href*="mall.jd.com/index-"], a[href*="//mall.jd.com/index-"]')]
    .map(a => ({ id: /index-(\d+)\.html/.exec(a.href)?.[1] || null, text: (a.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 40) })).filter(x => x.id).slice(0, 6);
  const crumbs = [...document.querySelectorAll('#crumb-wrap .item a, .crumb .item a, .crumb a')].map(a => (a.innerText || '').trim()).filter(Boolean).slice(0, 6);
  return { title: document.title.slice(0, 80), text: text.slice(0, 400), shopLinks, crumbs,
    selfOperated: /京东自营/.test(text.slice(0, 4000)), shopNameText: /([^\s]{2,30}(旗舰店|专卖店|自营店|专营店))/.exec(text)?.[1] || null };
};
const shopExtract = () => {
  const text = (document.body?.innerText || '').replace(/\s+/g, ' ');
  const live = [...document.querySelectorAll('a[href]')].filter(a => /lives\.jd\.com|live\.jd\.com|\/live\//.test(a.href) || /直播/.test(a.innerText || ''))
    .map(a => ({ href: a.href.slice(0, 120), text: (a.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 30) })).slice(0, 8);
  return { title: document.title.slice(0, 80), text: text.slice(0, 300), liveLinks: live };
};

try {
  const shopsSeen = new Map();
  for (const [roomId, skus] of Object.entries(cfg.roomSkus)) {
    for (const s of skus) {
      if (!/^\d{8,16}$/.test(s.sku)) continue;
      if (stopped) { rows.push({ roomId, sku: s.sku, result: 'NOT_RUN', reason: 'JD_PAUSED_AFTER_ACCESS_CUE' }); console.log('jd ' + JSON.stringify(rows.at(-1))); continue; }
      const it = await read(`https://item.jd.com/${s.sku}.html`, itemExtract);
      if (it.cue) stopped = { sku: s.sku, ...it.cue };
      const shopId = it.shopLinks?.[0]?.id || null;
      const row = { roomId, sku: s.sku, linkMapCategory: s.linkMapCategory, brandInTitle: s.brandInTitle,
        itemHttp: it.http, itemFinalHost: it.finalHost, itemTitle: it.title, crumbs: it.crumbs, selfOperated: it.selfOperated ?? null,
        shopId, shopLinkText: it.shopLinks?.[0]?.text || null, shopNameText: it.shopNameText || null, result: it.error ? 'NAV_ERROR' : it.cue ? 'ACCESS_CUE' : shopId ? 'SHOP_RESOLVED' : 'SHOP_NOT_FOUND', cue: it.cue || null };
      if (shopId && !stopped && !shopsSeen.has(shopId)) {
        await new Promise(r => setTimeout(r, 5000));
        const sh = await read(`https://mall.jd.com/index-${shopId}.html`, shopExtract);
        if (sh.cue) stopped = { shopId, ...sh.cue };
        shopsSeen.set(shopId, { shopTitle: sh.title, shopHttp: sh.http, shopFinalHost: sh.finalHost, liveLinks: sh.liveLinks || [], shopCue: sh.cue || null });
      }
      Object.assign(row, shopId ? shopsSeen.get(shopId) || {} : {});
      rows.push(row); console.log('jd ' + JSON.stringify(row));
      await new Promise(r => setTimeout(r, 5000));
    }
  }
} finally {
  await browser.close();
  await fs.writeFile('r099-jd-sku-shop.json', JSON.stringify({ at: new Date().toISOString(), stopped, rows }, null, 1));
  console.log('stopped=' + JSON.stringify(stopped));
}
