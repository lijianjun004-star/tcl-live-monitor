import { decideDouyin } from '../../../lib/douyin.mjs';
import { normalizeObservation } from '../../schema.mjs';
/** Retains existing strict profile/room corroboration; no absent badge -> OFFLINE inference. */
export function parsePublicSnapshots(profile = {}, room = {}, { target = {}, planned_check_at, actual_check_at } = {}) {
  const account = String(target.displayDouyinId ?? target.account_id ?? 'unknown');
  const decision = decideDouyin(profile, room, target, { offlineRuleValidated: false });
  const text = `${profile.title ?? ''} ${profile.bodyExcerpt ?? ''} ${room.title ?? ''} ${room.bodyExcerpt ?? ''}`;
  let failure = profile.error_code ?? room.error_code ?? null;
  if (!failure && (profile.httpStatus === 429 || room.httpStatus === 429)) failure = 'PLATFORM_THROTTLED';
  if (!failure && /captcha|验证码|安全验证|滑块/i.test(text)) failure = 'CAPTCHA_OR_SECURITY_BLOCK';
  if (!failure && /请先登录后观看|登录后观看|扫码登录|请登录/.test(text)) failure = 'AUTH_REQUIRED';
  // Existing room URLs carry a room routing ID, not a proven dynamic session ID.
  // Until a passive payload's liveId/account association is audited, keep UNKNOWN.
  if (!failure) failure = 'NO_ATTESTED_DYNAMIC_LIVE_ID';
  return normalizeObservation({ platform: 'douyin', account_id: account, expected_account_id: account,
    room_id: decision.observedRoomId ?? null, live_id: null, state: 'UNKNOWN',
    source_type: 'public_profile_room', source_attested: false, failure_code: failure,
    planned_check_at, actual_check_at, evidence_ref: profile.evidence_ref ?? room.evidence_ref });
}
export async function observe({ profile, room, capture, target, ...times } = {}) {
  const pages = capture ? await capture(target) : { profile, room };
  return parsePublicSnapshots(pages.profile, pages.room, { target, ...times });
}
