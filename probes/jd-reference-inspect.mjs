// Read-only inspection of the TCL-provided JD live inspection page (user-requested).
// GET navigation only: no form submission, no clicks on action buttons, no credentials.
// All captured content goes to ./out and is ENCRYPTED before leaving the runner.
import fs from 'node:fs/promises';
import { chromium } from 'playwright';
const URL0 = process.env.TARGET_URL;
await fs.mkdir('out', { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
const page = await ctx.newPage();
const net = [];
page.on('response', async res => {
  const req = res.request(); const type = req.resourceType();
  const entry = { method: req.method(), url: res.url(), status: res.status(), type, ct: res.headers()['content-type'] || '' };
  if ((type === 'xhr' || type === 'fetch') && /json|text/.test(entry.ct)) { try { entry.sample = (await res.text()).slice(0, 6000); } catch {} }
  if (type === 'script' && new URL(res.url()).host === new URL(URL0).host) { try { entry.scriptSize = (await res.body()).length; } catch {} }
  net.push(entry);
});
const snap = async name => {
  await page.waitForTimeout(2500);
  const info = await page.evaluate(() => ({
    title: document.title, url: location.href,
    text: document.body.innerText.slice(0, 30000),
    nav: [...document.querySelectorAll('a,button,[role=tab],[role=menuitem],.el-menu-item,.ant-menu-item,.nav-link,li')].map(e => (e.innerText || '').trim()).filter(t => t && t.length < 40).slice(0, 300),
    links: [...document.querySelectorAll('a[href]')].map(a => a.href).slice(0, 200),
    headers: [...document.querySelectorAll('th')].map(e => e.innerText.trim()).slice(0, 200),
    selects: [...document.querySelectorAll('select')].map(s => ({ name: s.name || s.id, options: [...s.options].map(o => o.value + '=' + o.text).slice(0, 100) })),
    inputs: [...document.querySelectorAll('input')].map(i => ({ name: i.name || i.id, type: i.type, value: i.type === 'password' ? '' : i.value })).slice(0, 50),
  }));
  await fs.writeFile(`out/${name}.json`, JSON.stringify(info, null, 1));
  await page.screenshot({ path: `out/${name}.jpg`, type: 'jpeg', quality: 45, fullPage: true });
  return info;
};
await page.goto(URL0, { waitUntil: 'networkidle', timeout: 45000 }).catch(e => console.log('nav', String(e).slice(0, 120)));
const main = await snap('main');
// visit same-host GET links (read-only pages), at most 12
const host = new URL(URL0).host; const seen = new Set([main.url]);
const targets = main.links.filter(h => { try { const u = new URL(h); return u.host === host && !/logout|delete|del|remove|edit|save|submit|export/i.test(h); } catch { return false; } });
let n = 0;
for (const h of targets) { if (seen.has(h) || n >= 12) continue; seen.add(h); n++;
  await page.goto(h, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {}); await snap('page' + n); }
await fs.writeFile('out/network.json', JSON.stringify(net, null, 1));
await browser.close();
console.log('pages', n + 1, 'requests', net.length);
