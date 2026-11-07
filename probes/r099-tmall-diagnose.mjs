// R0.9.9 Tmall consecutive API_ERROR diagnosis (read-only, public guest live page).
// Logs every mtop live-detail ret code per page load so the failure cause is evidence, not a guess.
// ARM=baseline : behaviour of public-status-probe (new browser context per round, immediate 2nd attempt).
// ARM=fix      : one persistent context for the whole run (like a returning visitor), one page load per
//                account per round, 8 s spacing, and cool-down (skip rest of round) on throttle/validation
//                codes. Never solves captchas, never forges tokens/signatures, never replays requests.
import fs from 'node:fs/promises';
import { chromium } from 'playwright';
import { LIVE_PAGE, LIVE_DETAIL_HOST, LIVE_DETAIL_PATH, parseJSONOrJSONP, classifyTmall, pickBest } from './lib/tmall.mjs';
import { classifyMtopSequence } from './lib/r099-identity.mjs';

const ARM = process.env.ARM === 'baseline' ? 'baseline' : 'fix';
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? Number(process.argv[i + 1]) : d; };
const ROUNDS = Math.min(Math.max(arg('--rounds', 4), 1), 8), INTERVAL_MIN = Math.min(Math.max(arg('--interval-min', 5), 1), 15);
const cfg = JSON.parse(await fs.readFile('config/probe-targets.json', 'utf8'));
const targets = cfg.tmall.filter(t => /^\d{5,16}$/.test(String(t.accountId)));
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const newCtx = () => browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'zh-CN',
  userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36' });

async function loadOnce(ctx, t) {
  const page = await ctx.newPage(); const raw = []; const pending = [];
  page.on('response', res => { try { const u = new URL(res.url()); if (u.hostname === LIVE_DETAIL_HOST && u.pathname === LIVE_DETAIL_PATH) pending.push(res.text().then(x => raw.push(x)).catch(() => {})); } catch {} });
  let http = null;
  try { const r = await page.goto(LIVE_PAGE + encodeURIComponent(t.accountId), { waitUntil: 'domcontentloaded', timeout: 25000 }); http = r?.status() ?? null; await page.waitForTimeout(8000); await Promise.allSettled(pending); }
  catch { http = 'NAV_ERROR'; } finally { await page.close().catch(() => {}); }
  const samples = [], codes = [];
  for (const x of raw) { try { const j = parseJSONOrJSONP(x); for (const c of (j.ret || []).slice(0, 2)) codes.push(String(c).split('::')[0]); samples.push(classifyTmall(j, t)); } catch { codes.push('PARSE_ERROR'); } }
  const hasTokenCookie = (await ctx.cookies('https://h5api.m.taobao.com')).some(c => c.name === '_m_h5_tk'); // presence only, value never read
  return { http, responses: raw.length, seq: classifyMtopSequence(codes), best: pickBest(samples), hasTokenCookie };
}

const rows = []; let ctx = ARM === 'fix' ? await newCtx() : null;
try {
  for (let r = 1; r <= ROUNDS; r++) {
    const t0 = Date.now(); let cooling = null;
    if (ARM === 'baseline') ctx = await newCtx();
    for (const t of targets) {
      if (cooling) { rows.push({ arm: ARM, round: r, key: t.key, state: 'NOT_RUN', reason: 'COOLDOWN_AFTER_THROTTLE', cooledBy: cooling }); console.log('tmall ' + JSON.stringify(rows.at(-1))); continue; }
      let res = await loadOnce(ctx, t), attempts = 1;
      if (ARM === 'baseline' && !(res.best && ['LIVE', 'OFFLINE'].includes(res.best.state))) { res = await loadOnce(ctx, t); attempts = 2; }
      const row = { arm: ARM, round: r, key: t.key, accountId: t.accountId, at: new Date().toISOString(), attempts, http: res.http, responses: res.responses,
        mtop: res.seq.kind, codes: res.seq.codes.slice(0, 6), hasTokenCookie: res.hasTokenCookie,
        state: res.best?.state || 'UNKNOWN', reason: res.best ? res.best.reason : 'NO_LIVE_DETAIL_RESPONSE',
        observedName: res.best?.observed?.name || null, roomNumber: res.best?.observed?.roomNumber || null,
        roomStatus: res.best?.roomStatus ?? null, streamStatus: res.best?.streamStatus ?? null };
      rows.push(row); console.log('tmall ' + JSON.stringify(row));
      if (ARM === 'fix' && res.seq.kind === 'THROTTLED_OR_VALIDATION') cooling = { key: t.key, codes: res.seq.codes.slice(0, 3) };
      if (ARM === 'fix') await new Promise(x => setTimeout(x, 8000));
    }
    if (ARM === 'baseline') { await ctx.close(); ctx = null; }
    if (r < ROUNDS) await new Promise(x => setTimeout(x, Math.max(0, t0 + INTERVAL_MIN * 60000 - Date.now())));
  }
} finally {
  if (ctx) await ctx.close().catch(() => {});
  await browser.close();
  const by = {}; for (const x of rows) { const k = `r${x.round}`; (by[k] ||= { LIVE: 0, OFFLINE: 0, UNKNOWN: 0, NOT_RUN: 0 })[x.state]++; }
  console.log('summary ' + JSON.stringify({ arm: ARM, rounds: by }));
  await fs.writeFile(`r099-tmall-${ARM}.json`, JSON.stringify({ arm: ARM, rows }, null, 1));
}
