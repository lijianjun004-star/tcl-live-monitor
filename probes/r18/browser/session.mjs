/** Normal, user-owned browser sessions. No fingerprint changes, replay, or automatic challenges. */
import { homedir } from 'node:os';
import { resolve, join, dirname, relative, isAbsolute } from 'node:path';
import { existsSync, realpathSync, mkdirSync } from 'node:fs';

const ALLOWED_HOSTS = ['taobao.com', 'tmall.com', 'jd.com', 'douyin.com'];
const isAllowed = host => ALLOWED_HOSTS.some(suffix => host === suffix || host.endsWith(`.${suffix}`));

export function publicUrlSummary(value) {
  try {
    const url = new URL(value);
    return { protocol: url.protocol, hostname: url.hostname };
  } catch { return { protocol: null, hostname: null }; }
}

export function classifyAccess({ status = 200, url = '', text = '' } = {}) {
  // Security challenges take precedence over login and any live/offline text.
  if (status === 403 || /验证码|人机验证|安全验证|访问被拒绝|captcha|verify\s+you\s+are\s+human|security\s+check/i.test(text) || /\/punish|\/captcha|\/challenge/.test(url)) {
    return 'HUMAN_VERIFICATION_REQUIRED';
  }
  if (status === 429 || /访问过于频繁|操作频繁|请求频繁|too\s+many\s+requests|rate\s+limit/i.test(text)) return 'PLATFORM_THROTTLED';
  let loginHost = false;
  try { loginHost = /^(login|passport|login\.m)\./i.test(new URL(url).hostname); } catch {}
  if (status === 401 || loginHost || /请先登录|登录后查看|登录已失效|登录已过期|session\s+expired|sign\s+in\s+to\s+continue/i.test(text)) return 'AUTH_REQUIRED';
  if (status >= 400) return 'NETWORK_ERROR';
  return null;
}

function realExistingParent(path) {
  let existing = path;
  const suffix = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    suffix.unshift(existing.slice(parent.length + (parent.endsWith('/') ? 0 : 1)));
    existing = parent;
  }
  return resolve(realpathSync(existing), ...suffix);
}

export function resolveProfilePath(profileDir) {
  const path = realExistingParent(resolve(profileDir || join(homedir(), '.local/share/tcl-live-monitor/r18/profiles/default')));
  // Reject any ancestor repository, including symlinks into a checkout.
  let ancestor = path;
  while (true) {
    if (existsSync(join(ancestor, '.git'))) throw new Error('PROFILE_INSIDE_REPOSITORY');
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  // Also reject this project even if a user supplied a nested path before .git is present.
  const checkout = resolve(new URL('../../../', import.meta.url).pathname);
  const rel = relative(checkout, path);
  if (!rel || (!rel.startsWith('..') && !isAbsolute(rel))) throw new Error('PROFILE_INSIDE_REPOSITORY');
  return path;
}

export async function openSession({ profileDir, headless = false, playwrightModule, audit = () => {} } = {}) {
  const profile = resolveProfilePath(profileDir);
  let browser = playwrightModule;
  if (!browser) {
    try { browser = await import('playwright'); }
    catch { return { status: 'BLOCKED', failure_code: 'BROWSER_DEPENDENCY_UNAVAILABLE', context: null }; }
  }
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  try {
    const context = await browser.chromium.launchPersistentContext(profile, { headless });
    audit({ event: 'SESSION_OPENED', at: new Date().toISOString(), persistent: true });
    return { status: 'PASS', failure_code: null, context };
  } catch {
    audit({ event: 'SESSION_UNAVAILABLE', at: new Date().toISOString() });
    return { status: 'BLOCKED', failure_code: 'BROWSER_SESSION_UNAVAILABLE', context: null };
  }
}

export function watchResponses(page, { onResponse = () => {}, audit = () => {} } = {}) {
  const pending = new Set();
  const listener = response => {
    const task = (async () => {
      try {
        const summary = publicUrlSummary(response.url());
        if (!isAllowed(summary.hostname || '') || summary.protocol !== 'https:') return;
        const status = response.status();
        audit({ event: 'PASSIVE_RESPONSE', at: new Date().toISOString(), status, url: summary });
        const headers = response.headers();
        const declaredSize = Number(headers['content-length'] || 0);
        const endpoint = new URL(response.url());
        const isLiveDetail = endpoint.hostname === 'h5api.m.taobao.com' && endpoint.pathname === '/h5/mtop.mediaplatform.live.livedetail/4.0/';
        if ((!/application\/json/i.test(headers['content-type'] || '') && !isLiveDetail) || declaredSize > 1_000_000 || status !== 200) return;
        const body = await response.body();
        if (body.length > 1_000_000) return;
        // Raw response data is ephemeral. The consumer must validate identity and only persist a safe summary.
        const raw = body.toString('utf8');
        let data;
        try { data = JSON.parse(raw); } catch { if (!isLiveDetail) return; data = raw; }
        await onResponse({ data, status, url_summary: summary, captured_at: new Date().toISOString(),
          response_url: isLiveDetail ? `${endpoint.origin}${endpoint.pathname}` : endpoint.origin,
          page_url: page.url() });
      } catch { /* Unreadable responses are not evidence of OFFLINE. */ }
    })();
    pending.add(task);
    task.finally(() => pending.delete(task));
  };
  page.on('response', listener);
  return async () => {
    page.off('response', listener);
    await Promise.allSettled([...pending]);
  };
}

export async function safeBrowserCheck({ url, profileDir, planned_check_at, actual_check_at = new Date().toISOString(), account_id = '2050532947', platform = 'tmall', onPage, onResponse, audit = () => {}, playwrightModule, headless = false, timeoutMs = 30_000 } = {}) {
  const unknown = failure_code => ({ platform, store_key: `${platform}:accountId:${account_id}`, account_id, room_id: null, live_id: null, state: 'UNKNOWN', planned_check_at: planned_check_at || actual_check_at, actual_check_at, source_type: 'normal_persistent_browser', source_attested: false, failure_code, evidence_ref: null });
  const summary = publicUrlSummary(url);
  if (summary.protocol !== 'https:' || !isAllowed(summary.hostname || '')) return unknown('INVALID_PUBLIC_ENTRY');
  let opened;
  try { opened = await openSession({ profileDir, headless, playwrightModule, audit }); }
  catch { return unknown('INVALID_PROFILE_PATH'); }
  if (!opened.context) return unknown(opened.failure_code);
  const context = opened.context;
  let stop = async () => {};
  try {
    const page = await context.newPage();
    stop = watchResponses(page, { onResponse, audit });
    audit({ event: 'NAVIGATE', at: new Date().toISOString(), url: summary });
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    const text = (await page.locator('body').innerText({ timeout: timeoutMs })).slice(0, 250_000);
    const status = response?.status() || 0;
    const finalSummary = publicUrlSummary(page.url());
    if (finalSummary.protocol !== 'https:' || !isAllowed(finalSummary.hostname || '')) return unknown('INVALID_PUBLIC_ENTRY');
    if (!status) return unknown('NETWORK_ERROR');
    const failure = classifyAccess({ status, url: page.url(), text });
    if (failure) {
      audit({ event: 'ACCESS_BLOCKED', at: new Date().toISOString(), failure_code: failure });
      return unknown(failure);
    }
    // Finish already received passive responses before reducing their evidence.
    await stop();
    stop = async () => {};
    // The callback must independently attest target identity/state. Merely loading a page does not attest it.
    return onPage ? await onPage({ page, text, url: page.url(), status }) : unknown('NO_VALID_TARGET_EVIDENCE');
  } catch (error) {
    return unknown(error?.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK_ERROR');
  } finally {
    await stop();
    try { await context.close(); } catch { /* Cleanup failure cannot convert UNKNOWN to a valid state. */ }
    audit({ event: 'SESSION_CLOSED', at: new Date().toISOString() });
  }
}
