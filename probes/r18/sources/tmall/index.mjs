/** Normal public-page access only. No protected API requests or request replay. */
import { classifyTmall, parseJSONOrJSONP } from '../../../lib/tmall.mjs';

export const ACCOUNT_ID = '2050532947';
export const PAGE_URL = `https://h5.m.taobao.com/taolive/video.html?userId=${ACCOUNT_ID}`;
const SOURCE_NAME = 'TCL集团官方旗舰店';
const iso = value => new Date(value).toISOString();
const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const liveId = value => /^[1-9][0-9]{4,23}$/.test(String(value ?? ''));
const roomId = value => /^[0-9]{3,15}$/.test(String(value ?? ''));

function base(options = {}) {
  const actual = options.actual_check_at ?? new Date().toISOString();
  return {
    platform: 'tmall', store_key: `tmall:accountId:${ACCOUNT_ID}`,
    account_id: ACCOUNT_ID, room_id: null, live_id: null, state: 'UNKNOWN',
    planned_check_at: iso(options.planned_check_at ?? actual), actual_check_at: iso(actual),
    source_type: 'PUBLIC_PAGE', source_attested: false,
    failure_code: 'NO_VALID_TARGET_EVIDENCE', evidence_ref: options.evidence_ref ?? null,
    exact_start_end: false
  };
}

export function failureFromPage({ html = '', status = 200, final_url = '' } = {}) {
  if (status === 429) return 'PLATFORM_THROTTLED';
  if (status === 401) return 'AUTH_REQUIRED';
  if (status === 403) return 'CAPTCHA_OR_SECURITY_BLOCK';
  if (/captcha|punish|_____tmd_____|人机验证|滑动验证|安全验证|访问被拒绝|请完成验证/i.test(html) || /\/punish|captcha/i.test(final_url))
    return 'CAPTCHA_OR_SECURITY_BLOCK';
  if (/passport|login\.taobao\.com|login\.tmall\.com/i.test(final_url) || /请先登录|登录后查看|登录已过期/.test(html))
    return 'AUTH_REQUIRED';
  if (status >= 400) return 'NETWORK_ERROR';
  return 'NO_VALID_TARGET_EVIDENCE';
}

/** HTML labels/recommendation cards are insufficient for account-level live status. */
export function parsePage(options = {}) {
  return { ...base(options), failure_code: failureFromPage(options) };
}

function targetPage(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname === 'h5.m.taobao.com' &&
      parsed.pathname === '/taolive/video.html' && parsed.searchParams.get('userId') === ACCOUNT_ID;
  } catch { return false; }
}
function detailResponse(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname === 'h5api.m.taobao.com' &&
      parsed.pathname === '/h5/mtop.mediaplatform.live.livedetail/4.0/';
  } catch { return false; }
}

/**
 * Accept only an already received ordinary page response; this function never fetches it.
 * transport_attested must be set by the trusted browser capture layer, never imported
 * untrusted JSON. Callers must ensure the response belongs to this page load.
 */
export function parsePassiveResponse(options = {}) {
  const output = { ...base(options), source_type: 'PASSIVE_PAGE_RESPONSE' };
  const unknown = failure_code => ({ ...output, failure_code });
  if (options.recommended === true || options.is_recommendation === true)
    return unknown('RECOMMENDED_LIVE_NOT_TARGET');
  if (!targetPage(options.page_url) || !detailResponse(options.response_url))
    return unknown('INVALID_SOURCE_ATTESTATION');
  if (options.transport_attested !== true) return unknown('INVALID_SOURCE_ATTESTATION');
  if (options.status !== 200) return unknown(failureFromPage({ status: options.status ?? 0 }));
  if (!validTime(options.captured_at)) return unknown('STALE_EVIDENCE');
  const age = Date.parse(output.actual_check_at) - Date.parse(options.captured_at);
  if (age < 0 || age > (options.max_age_ms ?? 90000)) return unknown('STALE_EVIDENCE');
  let payload = options.payload;
  if (typeof payload === 'string') {
    try { payload = parseJSONOrJSONP(payload); } catch { return unknown('NO_VALID_TARGET_EVIDENCE'); }
  }
  const returns = Array.isArray(payload?.ret) ? payload.ret.join(' ') : '';
  if (/captcha|security|RGV587|USER_VALIDATE/i.test(returns)) return unknown('CAPTCHA_OR_SECURITY_BLOCK');
  if (/SESSION_EXPIRED|TOKEN_EXPIRED|LOGIN|AUTH/i.test(returns)) return unknown('AUTH_REQUIRED');
  if (/THROTTL|LIMITED|EXCEED/i.test(returns)) return unknown('PLATFORM_THROTTLED');
  const result = classifyTmall(payload, { accountId: ACCOUNT_ID, displayName: SOURCE_NAME });
  if (result.state === 'UNKNOWN') return unknown(result.reason === 'IDENTITY_MISMATCH' ? 'ACCOUNT_MISMATCH' : 'NO_VALID_TARGET_EVIDENCE');
  if (String(payload?.data?.accountId ?? '') !== ACCOUNT_ID) return unknown('ACCOUNT_MISMATCH');
  const room = result.observed?.roomNumber;
  if (!roomId(room) || (result.state === 'LIVE' && !liveId(result.liveId)))
    return unknown('NO_VALID_TARGET_EVIDENCE');
  return { ...output, room_id: String(room), live_id: result.state === 'LIVE' ? String(result.liveId) : null,
    state: result.state, source_attested: true, failure_code: null };
}

/** One ordinary GET, no retries, cookies, protected endpoint calls or API signatures. */
export async function observe(options = {}) {
  const fetcher = options.fetch_impl ?? globalThis.fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeout_ms ?? 15000);
  const actual = options.actual_check_at ?? new Date().toISOString();
  const args = { ...options, actual_check_at: actual };
  try {
    // Manual redirects avoid following a login/security redirect and stop this path.
    const response = await fetcher(PAGE_URL, { redirect: 'manual', signal: controller.signal,
      headers: { Accept: 'text/html' } });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location') ?? '';
      return parsePage({ ...args, final_url: location, status: response.status });
    }
    const html = await response.text();
    return parsePage({ ...args, html, status: response.status, final_url: response.url || PAGE_URL });
  } catch (error) {
    return { ...base(args), failure_code: error?.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK_ERROR' };
  } finally { clearTimeout(timeout); }
}
