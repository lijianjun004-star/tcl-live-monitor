// Read-only public guest discovery of TCL-related Douyin accounts/live rooms.
// Guest search pages only; stops on login wall / captcha (no bypass). Results are CANDIDATES only.
import fs from 'node:fs/promises';
import { chromium } from 'playwright';
import { CHALLENGE_RE } from './lib/douyin.mjs';
const KEYWORDS = String(process.env.KEYWORDS || 'TCL直播间').split(',').map(s => s.trim()).filter(Boolean).slice(0, 10);
const LOGIN_RE = /(登录后查看更多|请先登录|扫码登录|登录抖音)/;
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, locale: 'zh-CN' });
const report = { startedAt: new Date().toISOString(), keywords: KEYWORDS, searches: [], accounts: {} };
const add = (secUid, o) => { if (!/^MS4wLjABAAAA[\w-]{20,}$/.test(secUid)) return; const a = report.accounts[secUid] ||= { secUid, names: [], liveRoomIds: [], douyinIds: [], seenIn: [] };
  for (const k of ['names', 'liveRoomIds', 'douyinIds', 'seenIn']) for (const v of o[k] || []) if (v && !a[k].includes(v)) a[k].push(v); };
for (const kw of KEYWORDS) {
  for (const type of ['user', 'live']) {
    const page = await ctx.newPage(); const s = { kw, type };
    try {
      const r = await page.goto(`https://www.douyin.com/search/${encodeURIComponent(kw)}?type=${type}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      s.http = r?.status() ?? null; await page.waitForTimeout(8000);
      for (let i = 0; i < 3; i++) { await page.mouse.wheel(0, 2500); await page.waitForTimeout(1500); }
      const snap = await page.evaluate(() => ({ title: document.title, text: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 3000),
        links: [...document.querySelectorAll('a[href]')].map(a => ({ href: a.href, text: (a.innerText || '').replace(/\s+/g, ' ').slice(0, 120) })) }));
      s.title = snap.title; s.challenged = CHALLENGE_RE.test(snap.title + snap.text); s.loginWall = LOGIN_RE.test(snap.text);
      s.linkCount = snap.links.length; s.textHead = snap.text.slice(0, 300);
      let n = 0;
      for (const l of snap.links) {
        const m = /douyin\.com\/user\/(MS4wLjABAAAA[\w-]+)/.exec(l.href); if (!m) continue;
        const name = l.text.split(' ')[0]; if (!/tcl|雷鸟|ffalcon|乐华/i.test(l.text)) continue;
        const did = /抖音号[:：]\s*([\w.-]{3,32})/.exec(l.text)?.[1];
        add(m[1], { names: [name], douyinIds: did ? [did] : [], seenIn: [`${type}:${kw}`] }); n++;
      }
      for (const l of snap.links) {
        const m = /live\.douyin\.com\/(\d{5,24})/.exec(l.href); if (!m || !/tcl|雷鸟|ffalcon/i.test(l.text)) continue;
        report.liveLinks ||= []; report.liveLinks.push({ roomId: m[1], text: l.text, kw });
      }
      s.tclAccountsFound = n;
    } catch (e) { s.error = String(e).slice(0, 150); }
    report.searches.push(s); await page.close();
    if (s.challenged) break;
  }
}
await browser.close();
report.completedAt = new Date().toISOString();
await fs.writeFile('discovery-report.json', JSON.stringify(report, null, 1));
console.log('SEARCHES'); for (const s of report.searches) console.log(JSON.stringify({ kw: s.kw, type: s.type, http: s.http, title: s.title, challenged: s.challenged, loginWall: s.loginWall, links: s.linkCount, tcl: s.tclAccountsFound, error: s.error, head: (s.textHead || '').slice(0, 160) }));
console.log('ACCOUNTS'); for (const a of Object.values(report.accounts)) console.log(JSON.stringify(a));
console.log('LIVE_LINKS'); for (const l of report.liveLinks || []) console.log(JSON.stringify(l));
