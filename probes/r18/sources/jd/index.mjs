import { normalizeObservation } from '../../schema.mjs';
/** Public shop pages do not establish ops roomId -> platform liveId mappings. */
export function parsePublicSnapshot(snapshot = {}, { target = {}, planned_check_at, actual_check_at } = {}) {
  const account = String(target.account_id ?? '407681');
  const text = `${snapshot.title ?? ''} ${snapshot.text ?? ''}`;
  const failure = snapshot.error_code ?? (snapshot.http_status === 429 ? 'PLATFORM_THROTTLED' :
    /captcha|验证码|安全验证|滑块/i.test(text) ? 'CAPTCHA_OR_SECURITY_BLOCK' :
    /passport\.jd\.com|请登录|扫码登录/i.test(`${snapshot.final_host ?? ''} ${text}`) ? 'AUTH_REQUIRED' :
    snapshot.http_status !== 200 ? 'NETWORK_ERROR' : 'NO_VALID_TARGET_EVIDENCE');
  return normalizeObservation({ platform: 'jd', account_id: account, expected_account_id: account,
    state: 'UNKNOWN', source_type: 'public_shop_page', source_attested: false,
    room_id: null, live_id: null, failure_code: failure, planned_check_at, actual_check_at,
    evidence_ref: snapshot.evidence_ref });
}
export async function observe({ snapshot, capture, target, ...times } = {}) {
  // Capture is supplied by a normal browser/page reader; this adapter does not call private ops APIs.
  const page = snapshot ?? (capture ? await capture(target) : { error_code: 'SOURCE_NOT_CONFIGURED' });
  return parsePublicSnapshot(page, { target, ...times });
}
