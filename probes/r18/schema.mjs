// R1.8 adapter boundary. Adapters attest only evidence they have actually checked.
export const SCHEMA_VERSION = 1;
export const TARGET_ACCOUNT_ID = '2050532947';
export const STATES = Object.freeze(['LIVE', 'OFFLINE', 'UNKNOWN']);
const id = value => value == null || value === '' ? null : /^[A-Za-z0-9._-]{1,160}$/.test(String(value)) ? String(value) : null;
const instant = value => value != null && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null;
export function validateIdentity(input = {}, expectedAccountId = input.platform === 'tmall' ? TARGET_ACCOUNT_ID : input.expected_account_id) {
  const expected = input.platform === 'tmall' ? TARGET_ACCOUNT_ID : expectedAccountId;
  return !!id(input.account_id) && !!id(expected) && String(input.account_id) === String(expected);
}
/** source_attested is a code boundary, never an assertion of platform realtime access. */
export function normalizeObservation(input = {}, { now = input.actual_check_at ?? new Date().toISOString(), maxAgeMs = 3_600_000, expectedAccountId } = {}) {
  const platform = ['tmall', 'jd', 'douyin'].includes(input.platform) ? input.platform : 'unknown';
  const account = id(input.account_id);
  const expected = id(platform === 'tmall' ? TARGET_ACCOUNT_ID : (expectedAccountId ?? input.expected_account_id));
  const actual = instant(input.actual_check_at);
  const planned = instant(input.planned_check_at);
  const observed = instant(input.observed_at ?? input.evidence_at ?? input.actual_check_at);
  let failure = input.failure_code == null ? null : /^[A-Z0-9_:-]{1,100}$/.test(String(input.failure_code)) ? String(input.failure_code) : 'SOURCE_FAILURE';
  let state = STATES.includes(input.state) ? input.state : 'UNKNOWN';
  let attested = input.source_attested === true;
  if (platform === 'unknown') failure = 'INVALID_PLATFORM';
  else if (!validateIdentity({ ...input, platform }, expected)) failure = 'ACCOUNT_MISMATCH';
  else if (!actual || !planned || !observed || !instant(now)) failure = 'INVALID_TIMESTAMP';
  else if (new Date(now) - new Date(observed) > maxAgeMs || new Date(observed) - new Date(now) > 60_000) failure = 'STALE_EVIDENCE';
  else if (failure) { /* Keep the adapter's safe failure code after identity/time validation. */ }
  else if (input.conflicting_evidence === true) failure = 'CONFLICTING_EVIDENCE';
  else if (input.recommended === true || input.is_recommendation === true) failure = 'RECOMMENDED_LIVE_NOT_TARGET';
  else if (state === 'UNKNOWN') failure = 'NO_VALID_TARGET_EVIDENCE';
  else if (!attested || !id(input.source_type)) failure = 'INVALID_SOURCE_ATTESTATION';
  else if (state === 'LIVE' && !id(input.live_id)) failure = 'NO_VALID_LIVE_ID';
  if (failure) { state = 'UNKNOWN'; attested = false; }
  if (state === 'UNKNOWN' && !failure) failure = 'NO_VALID_TARGET_EVIDENCE';
  return {
    schema_version: SCHEMA_VERSION, platform,
    store_key: `${platform}:accountId:${expected ?? account ?? 'unknown'}`,
    account_id: account, room_id: id(input.room_id), live_id: id(input.live_id), state,
    planned_check_at: planned, actual_check_at: actual, observed_at: observed,
    source_type: id(input.source_type) ?? 'unverified', source_attested: attested,
    failure_code: failure,
    evidence_ref: typeof input.evidence_ref === 'string' && /^[A-Za-z0-9._/-]{1,240}$/.test(input.evidence_ref) && !input.evidence_ref.includes('..') ? input.evidence_ref : null,
    exact_start_end: false, exact_start_end_time: false,
  };
}
