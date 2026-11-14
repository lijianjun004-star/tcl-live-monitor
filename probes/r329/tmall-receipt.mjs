// R3.29 pure mapping: one Tmall/Taobao live-detail verdict (probes/lib/tmall.mjs) -> one ledger receipt row.
// Identity comes from the API response itself (account id + shop name + room number). No free text.
const ID_OK_REASONS = new Set(['AMBIGUOUS_STATUS', 'UNRECOGNIZED_STATUS']);
// Signals that the platform wants verification / is limiting access: stop the whole run at once.
const LIMIT = /RGV587|USER_VALIDATE|ILLEGAL_ACCESS|FLOW_LIMIT|TRAFFIC_LIMIT|SESSION_EXPIRED|NEED_LOGIN/i;
export const isAccessLimit = v => Array.isArray(v?.apiRet) && v.apiRet.some(x => LIMIT.test(String(x)));
export const isLimitUrl = url => { try { const h = new URL(url).hostname; return /(^|\.)login\.(taobao|tmall)\.com$/.test(h) || /punish|captcha|sec\.taobao/i.test(url); } catch { return false; } };
const token = x => { const s = String(x || '').toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 100); return /^[A-Z]/.test(s) ? s : 'UNSPECIFIED'; };
export function toReceiptRow(key, at, verdict) {
  const v = verdict || { state: 'UNKNOWN', reason: 'NO_LIVE_DETAIL_RESPONSE' };
  const idOk = v.state === 'LIVE' || v.state === 'OFFLINE' || ID_OK_REASONS.has(v.reason);
  const reason = v.state === 'LIVE' ? 'TMALL_LIVE_DETAIL_ROOM_AND_STREAM_ON' : v.state === 'OFFLINE' ? 'TMALL_LIVE_DETAIL_ROOM_AND_STREAM_OFF' : token(v.reason);
  return { key, at: new Date(at).toISOString(), state: ['LIVE', 'OFFLINE', 'UNKNOWN'].includes(v.state) ? v.state : 'UNKNOWN', reason,
    profileIdentityVerified: idOk, roomIdentityVerified: idOk,
    // The API says "room and stream off" for this exact account. Kept as evidence; the ledger still shows
    // UNKNOWN until the offline rule is validated against a confirmed real end of broadcast.
    offlineEvidence: v.state === 'OFFLINE', offlineRuleValidated: false,
    sourceStartTime: v.state === 'LIVE' && typeof v.sourceStartTime === 'string' ? v.sourceStartTime : null };
}
