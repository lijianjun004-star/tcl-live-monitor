// Read-only identity check of candidate Douyin profiles by secUid (public guest profile page).
// Records name / 抖音号 / certification line / live badge. Stops on challenge. Candidates only.
import fs from 'node:fs/promises';
import { chromium } from 'playwright';
import { CHALLENGE_RE, liveAnchorRoomIds } from './lib/douyin.mjs';
const cfg = JSON.parse(await fs.readFile('config/r096-douyin-candidates.json', 'utf8'));
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'zh-CN' });
const results = [];
for (const c of cfg.candidates) {
  if (!/^MS4wLjABAAAA[\w-]{20,}$/.test(c.secUid)) continue;
  const page = await ctx.newPage(); const r = { state: 'UNKNOWN', scoringEligible: false, candidateId: c.candidateId, geminiName: c.geminiName };
  try {
    const resp = await page.goto(`https://www.douyin.com/user/${c.secUid}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    r.http = resp?.status() ?? null; await page.waitForTimeout(6000);
    const s = await page.evaluate(() => ({ title: document.title, text: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 2500),
      liveRoomAnchors: [...document.querySelectorAll('a[href]')].map(a => ({ href: a.href, text: (a.innerText || '').replace(/\s+/g, ' ').slice(0, 70) })).filter(x => /live\.douyin\.com\/\d/.test(x.href)).slice(0, 10) }));
    r.title = s.title; r.challenged = CHALLENGE_RE.test(s.title + s.text);
    r.name = /^(.*)的抖音 - 抖音$/.exec(s.title)?.[1] || null;
    r.douyinId = /抖音号[:：]\s*([\w.-]{3,32})/.exec(s.text)?.[1] || null;
    r.cert = (/([^ ]{2,40}(有限公司|股份公司|集团|工作室|个体工商户))/.exec(s.text) || [])[1] || null;
    r.followers = /粉丝\s*([\d.]+万?)/.exec(s.text)?.[1] || null;
    r.liveNow = liveAnchorRoomIds(s).length > 0; r.liveRoomIds = liveAnchorRoomIds(s);
    r.ip = /IP属地[:：]\s*(\S{2,6})/.exec(s.text)?.[1] || null;
    if (!r.name) r.textHead = s.text.slice(0, 200);
  } catch (e) { r.error = String(e).slice(0, 150); }
  results.push(r); await page.close();
  console.log(JSON.stringify(r));
  if (r.challenged) { console.log('STOP: challenge'); break; }
  await new Promise(res => setTimeout(res, 5000));
}
await browser.close();
await fs.writeFile('candidate-verify.json', JSON.stringify({ at: new Date().toISOString(), results }, null, 1));
