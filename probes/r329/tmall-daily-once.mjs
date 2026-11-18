// R3.29: ONE read-only pass over the registered Tmall/Taobao shops (public guest live page, mobile viewport).
// No login, no cookies supplied, no signature forging, no request replay: it only reads the live-detail JSON
// the public page itself requests. Stops at once on any verification / login / access-limit signal.
import fs from 'node:fs/promises';
import { chromium } from 'playwright';
import { LIVE_PAGE, parseJSONOrJSONP, classifyTmall, pickBest } from '../lib/tmall.mjs';
import { toReceiptRow, isAccessLimit, isLimitUrl } from './tmall-receipt.mjs';
import { isLiveDetailUrl, responseLimit, selectTargets, endpointEvidence } from '../r334/tmall-network.mjs';
if (process.env.R329_TMALL_ONCE !== 'REGISTERED_SHOPS_ONE_PASS') throw Error('R329_NOT_ARMED');
const cfg = JSON.parse(await fs.readFile('config/probe-targets.json', 'utf8'));
const targets = selectTargets(cfg.tmall, process.env.R334_TMALL_SINGLE_TARGET);
if (!Array.isArray(targets) || targets.length === 0 || targets.length > 12) throw Error('TMALL_TARGET_LIMIT');
for (const t of targets) {
  if (!(t.userConfirmed === true || t.scopeApproved === true)) throw Error('TMALL_TARGET_NOT_APPROVED');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(String(t.key)) || !/^\d{5,16}$/.test(String(t.accountId)) || !t.displayName ||
    (t.roomNumber != null && !/^\d{3,12}$/.test(String(t.roomNumber)))) throw Error('TMALL_TARGET_INVALID');
}
const checked = [], diagnostics = [], startedAt = new Date().toISOString();
let stopped = null;
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'zh-CN', serviceWorkers: 'block' });
  for (const t of targets) {
    if (stopped) {
      const skipped = { key: t.key, at: new Date().toISOString(), state: 'NOT_RUN', reason: 'STOPPED_AFTER_ACCESS_LIMIT' };
      checked.push(skipped);
      // A distinct record keeps the skipped shop auditable without advancing attempt freshness.
      console.log('R329_TMALL_NOT_RUN ' + JSON.stringify(skipped));
      continue;
    }
    const page = await context.newPage(), samples = [], pending = [], endpoints = [];
    let http = null, limit = null;
    const stop = reason => { limit ||= reason; void page.close().catch(() => {}); };
    page.on('response', res => {
      try {
        const navigation = res.request().isNavigationRequest() && res.request().frame() === page.mainFrame();
        if (navigation) http = res.status();
        const evidence = endpointEvidence(res.url(), res.status());
        if (evidence && endpoints.length < 30 && !endpoints.some(e => e.path === evidence.path && e.http === evidence.http)) endpoints.push(evidence);
        const denied = responseLimit({ url: res.url(), status: res.status(), navigation });
        if (denied) { stop(denied); return; }
        if (navigation && isLimitUrl(res.url())) { stop('LOGIN_OR_VERIFICATION_REDIRECT'); return; }
        if (!isLiveDetailUrl(res.url())) return;
        pending.push(res.text().then(x => {
          const sample = classifyTmall(parseJSONOrJSONP(x), t);
          samples.push(sample);
          if (isAccessLimit(sample)) stop('API_ACCESS_LIMIT');
        }).catch(() => samples.push({ state: 'UNKNOWN', reason: 'API_RESPONSE_PARSE_ERROR' })));
      } catch {}
    });
    try {
      const r = await page.goto(LIVE_PAGE + encodeURIComponent(t.accountId), { waitUntil: 'domcontentloaded', timeout: 25000 });
      http = r?.status() ?? null;
      await page.waitForTimeout(7000); await Promise.allSettled(pending);
      if (isLimitUrl(page.url())) limit = 'LOGIN_OR_VERIFICATION_REDIRECT';
    } catch { http ??= 'NAV_ERROR'; } finally { await page.close().catch(() => {}); }
    const best = pickBest(samples);
    if (!limit && samples.some(isAccessLimit)) limit = 'API_ACCESS_LIMIT';
    const row = toReceiptRow(t.key, Date.now(), limit ? { state: 'UNKNOWN', reason: 'STOPPED_' + limit } : best);
    checked.push(row);
    diagnostics.push({ key: t.key, http, reason: row.reason, responses: samples.length, endpoints });
    console.log('R329_TMALL ' + JSON.stringify({ key: row.key, state: row.state, reason: row.reason, http, responses: samples.length,
      identityVerified: row.profileIdentityVerified, sourceStartTime: row.sourceStartTime, apiRet: best?.apiRet ?? null }));
    if (limit) stopped = limit;
    await new Promise(r => setTimeout(r, 3000));
  }
  await context.close();
} finally {
  await browser.close();
  await fs.mkdir('out', { recursive: true });
  await fs.writeFile('out/tmall-receipt.json', JSON.stringify({ schemaVersion: 319, platform: 'tmall', startedAt, at: new Date().toISOString(), stopped, checked }));
  await fs.writeFile('out/tmall-diagnostics.json', JSON.stringify({ startedAt, stopped, diagnostics }, null, 2));
  console.log('R329_TMALL_STOPPED ' + JSON.stringify(stopped));
}
process.exit(stopped ? 3 : 0);
