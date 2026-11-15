// Official TOP read-only batch metadata client. No user session, browser cookies,
// automatic retry, default live IDs, or raw response/error logging.
import { createHmac } from 'node:crypto';

const METHOD = 'taobao.live.batchlives.get';
const ENDPOINT = 'https://gw.api.taobao.com/router/rest';
const MAX_BYTES = 1_000_000;
const PAIRS = ['TOP', 'TAOBAO', 'TMALL', 'TB'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const decimalId = value => {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  return typeof value === 'string' && /^[1-9]\d{0,23}$/.test(value) ? value : null;
};
const integerRaw = value => {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  return typeof value === 'string' && /^(?:0|[1-9]\d{0,15})$/.test(value) && Number.isSafeInteger(Number(value)) ? value : null;
};
const enumValue = (value, allowed) => allowed.find(item => value === item || value === String(item));

// Receipt descriptions of fields whose semantics are not yet verified. They state the form and digit
// count only and never echo a value (other than a tiny numeric enum), so unexpected data cannot leak.
// The digit count is evidence for a time unit, never a verified unit and never used for durations.
const unitEvidence = digits => digits === null ? null : digits === 10 ? 'LIKELY_SECONDS' : digits === 13 ? 'LIKELY_MILLISECONDS' : 'INCONCLUSIVE';

export function fieldShape(value) {
  const shape = (form, digits = null) => ({ form, digits, unitEvidence: unitEvidence(digits) });
  if (value === undefined) return shape('ABSENT');
  if (value === null) return shape('NULL');
  if (typeof value === 'boolean') return shape('BOOLEAN');
  if (Array.isArray(value)) return shape('ARRAY');
  if (typeof value === 'object') return shape('OBJECT');
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return shape('NUMBER_OTHER');
    if (!Number.isInteger(value)) return shape('NUMBER_FRACTIONAL');
    if (value < 0) return shape('NUMBER_NEGATIVE');
    if (!Number.isSafeInteger(value)) return shape('NUMBER_UNSAFE');
    return value === 0 ? shape('INTEGER_ZERO') : shape('INTEGER', String(value).length);
  }
  if (typeof value === 'string') {
    if (value === '0') return shape('NUMERIC_STRING_ZERO');
    return /^[1-9]\d{0,15}$/.test(value) && Number.isSafeInteger(Number(value)) ? shape('NUMERIC_STRING', value.length) : shape('STRING_OTHER');
  }
  return shape('OTHER');
}

export function enumToken(value, allowWords = false) {
  if (value === undefined) return 'ABSENT';
  if (value === null) return 'NULL';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  const text = typeof value === 'number' ? (Number.isSafeInteger(value) ? String(value) : null) : typeof value === 'string' ? value : null;
  if (text !== null && /^-?\d{1,4}$/.test(text)) return text;
  return allowWords && typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,23}$/.test(value) ? value : 'OTHER';
}

export function beijingTimestamp(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(date.getTime())) throw Error('INVALID_NOW');
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

export function signTopRequest(params, secret) {
  if (!object(params) || typeof secret !== 'string' || !secret) throw Error('INVALID_SIGNING_INPUT');
  const keys = Object.keys(params).filter(key => key !== 'sign' && params[key] !== '').sort();
  if (keys.some(key => !/^[A-Za-z0-9_]+$/.test(key) || typeof params[key] !== 'string')) throw Error('INVALID_SIGNING_INPUT');
  return createHmac('md5', secret).update(keys.map(key => key + params[key]).join(''), 'utf8').digest('hex').toUpperCase();
}

function credentials(env) {
  if (!object(env)) return null;
  for (const prefix of PAIRS) {
    const key = env[`${prefix}_APP_KEY`], secret = env[`${prefix}_APP_SECRET`];
    if (typeof key === 'string' && key.trim() && typeof secret === 'string' && secret.trim()) return { key, secret };
  }
  return null;
}

function targetMap(targets) {
  if (!Array.isArray(targets) || !targets.length) return null;
  const map = new Map(), keys = new Set();
  for (const target of targets) {
    if (!object(target) || !(target.userConfirmed === true || target.scopeApproved === true)
      || typeof target.key !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(target.key)) return null;
    const accountId = decimalId(target.accountId);
    const roomNumber = target.roomNumber == null ? null : decimalId(target.roomNumber);
    if (!accountId || (target.roomNumber != null && !roomNumber) || map.has(accountId) || keys.has(target.key)) return null;
    keys.add(target.key); map.set(accountId, { key: target.key, accountId, roomNumber });
  }
  return map;
}

function errorClassification(code, subCode = null) {
  // Code 50 is the platform's generic remote-service error; only the sub code the official error page
  // itself shows for it (isv.invalid-parameter) is treated as a parameter error. Everything else stays generic.
  if (code === 50 && typeof subCode === 'string' && /^isv\.invalid-parameter(?![A-Za-z0-9])/.test(subCode)) return 'TOP_PARAMETER_ERROR';
  return ({ 7: 'TOP_RATE_LIMIT', 11: 'TOP_PERMISSION_DENIED', 12: 'TOP_PERMISSION_DENIED', 13: 'TOP_PERMISSION_DENIED',
    21: 'TOP_METHOD_ERROR', 22: 'TOP_METHOD_ERROR', 24: 'TOP_SIGNATURE_ERROR', 25: 'TOP_SIGNATURE_ERROR',
    26: 'TOP_SESSION_ERROR', 27: 'TOP_SESSION_ERROR', 28: 'TOP_CREDENTIAL_ERROR', 29: 'TOP_CREDENTIAL_ERROR',
    30: 'TOP_TIMESTAMP_ERROR', 31: 'TOP_TIMESTAMP_ERROR', 40: 'TOP_PARAMETER_ERROR', 41: 'TOP_PARAMETER_ERROR',
    43: 'TOP_PARAMETER_ERROR' })[code] || 'TOP_API_ERROR';
}

function safeErrorCode(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : null;
  return typeof value === 'string' && /^\d{1,8}$/.test(value) ? Number(value) : null;
}

// The sub code is a short machine identifier. Anything else (free text, URLs, values) is dropped, and the
// human-readable msg/sub_msg fields are never read.
const safeSubCode = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9._:-]{0,79}$/.test(value) ? value : null;
const hasBusinessError = value => value !== undefined && value !== null && value !== '' && value !== 0 && value !== '0';

async function cancelBody(response) {
  try { await response.body?.cancel?.(); } catch {}
}

async function readJSON(response) {
  const declared = response.headers?.get?.('content-length');
  if (declared !== null && declared !== undefined && Number(declared) > MAX_BYTES) {
    await cancelBody(response);
    throw Error('RESPONSE_TOO_LARGE');
  }
  if (!response.body || typeof response.body.getReader !== 'function') throw Error('INVALID_RESPONSE_BODY');
  const reader = response.body.getReader(), chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw Error('INVALID_RESPONSE_BODY');
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) throw Error('RESPONSE_TOO_LARGE');
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); }
  catch { throw Error('INVALID_RESPONSE_JSON'); }
}

const unknown = (liveId, reason) => ({ liveId, sourceState: 'UNKNOWN', reason, identityVerified: false,
  startTimeRaw: null, startTimeUnit: 'UNVERIFIED', endTimeRaw: null, endTimeUnit: 'MILLISECONDS', shape: null });

// Identity-verified registered sessions only. States how the platform actually encoded the status and time
// fields, including for sessions whose combination is rejected, so a first real response is never wasted.
const sessionShape = record => ({ deletionStatus: enumToken(record.status), roomStatus: enumToken(record.room_status),
  streamStatus: enumToken(record.stream_status), startTime: fieldShape(record.start_time), endTime: fieldShape(record.end_time) });

function observation(record, id, targets) {
  const accountId = decimalId(record.account_id), target = targets.get(accountId);
  if (!target) return unknown(id, 'ACCOUNT_IDENTITY_MISMATCH');
  const nested = record.simple_broad_caster;
  if (nested !== undefined && nested !== null && (!object(nested)
    || (nested.account_id !== undefined && decimalId(nested.account_id) !== accountId))) return unknown(id, 'ACCOUNT_IDENTITY_CONFLICT');
  const base = { ...unknown(id, 'INVALID_SESSION_STATUS'), key: target.key, accountId, identityVerified: true, shape: sessionShape(record) };
  const deletion = enumValue(record.status, [100, -1]);
  if (deletion !== 100) return { ...base, reason: deletion === -1 ? 'SESSION_DELETED' : 'INVALID_DELETION_STATUS' };
  const room = enumValue(record.room_status, [0, 1, 2]), stream = enumValue(record.stream_status, [0, 1]);
  const state = room === 1 && stream === 1 ? 'LIVE' : room === 0 && stream === 0 ? 'PREVIEW' : room === 2 && stream === 0 ? 'REPLAY' : 'UNKNOWN';
  if (state === 'UNKNOWN') return base;
  const start = integerRaw(record.start_time), end = integerRaw(record.end_time);
  if (start === null || end === null || (state !== 'PREVIEW' && start === '0') || (state === 'REPLAY' && end === '0')) return { ...base, reason: 'INVALID_SESSION_TIMES' };
  return { ...base, sourceState: state, reason: 'SESSION_METADATA_VERIFIED', startTimeRaw: start, endTimeRaw: end };
}

// Sends exactly one signed official POST. It never retries, switches host, follows a redirect, or returns a raw
// body or platform message: every failure is a static reason plus, for a platform error response, the numeric
// code and a short machine sub code. Returns { ok: true, payload } or { ok: false, status, reason, exitCode }.
export async function sendTopRequest({ method, business, pair, fetchFn, date }) {
  const system = { method, app_key: pair.key, sign_method: 'hmac', timestamp: beijingTimestamp(date),
    v: '2.0', format: 'json', simplify: 'false' };
  system.sign = signTopRequest({ ...system, ...business }, pair.secret);
  const rejected = (status, reason, exitCode, extra = {}) => ({ ok: false, status, reason, exitCode, ...extra });
  let payload;
  try {
    const response = await fetchFn(`${ENDPOINT}?${new URLSearchParams(system)}`, {
      method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: new URLSearchParams(business).toString(), redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(20_000),
    });
    if (!response || !Number.isInteger(response.status)) return rejected('REJECTED', 'INVALID_HTTP_RESPONSE', 3);
    if (response.status < 200 || response.status >= 300) {
      await cancelBody(response);
      return rejected('REJECTED', 'HTTP_REJECTED', 3);
    }
    payload = await readJSON(response);
  } catch (error) {
    const reason = error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'REQUEST_TIMEOUT'
      : ['RESPONSE_TOO_LARGE', 'INVALID_RESPONSE_BODY', 'INVALID_RESPONSE_JSON'].includes(error?.message) ? error.message : 'NETWORK_OR_REDIRECT_ERROR';
    return rejected('REJECTED', reason, 3);
  }
  if (!object(payload)) return rejected('PARTIAL', 'TOP_RESPONSE_SCHEMA_INVALID', 4);
  if (payload.error_response !== undefined) {
    const code = safeErrorCode(payload.error_response?.code), subCode = safeSubCode(payload.error_response?.sub_code);
    return rejected('REJECTED', errorClassification(code, subCode), 3,
      { ...(code !== null && { apiErrorCode: code }), ...(subCode !== null && { apiSubCode: subCode }) });
  }
  return { ok: true, payload };
}

export async function runTopBatch({ env = {}, liveIdsInput = '', targets, fetchFn = globalThis.fetch, now = new Date() } = {}) {
  const pair = credentials(env), registered = targetMap(targets);
  const date = now instanceof Date ? now : new Date(now), validDate = Number.isFinite(date.getTime());
  const configured = typeof liveIdsInput === 'string' && liveIdsInput.trim().length > 0;
  const result = { schemaVersion: 334, source: 'TAOBAO_TOP', method: METHOD, at: validDate ? date.toISOString() : null,
    status: 'BLOCKED', reason: 'PREREQUISITES_MISSING', blockers: [], requestsSent: 0,
    credentialsConfigured: Boolean(pair), liveIdsConfigured: configured, requestedCount: 0,
    verifiedRecordCount: 0, verifiedLiveCount: 0, allRequestedVerified: false, observations: [], exitCode: 2 };
  if (!pair) result.blockers.push('TOP_CREDENTIALS_MISSING');
  if (!registered) result.blockers.push('APPROVED_TARGETS_INVALID_OR_MISSING');
  if (!validDate) result.blockers.push('INVALID_NOW');
  if (!configured) result.blockers.push('LIVE_IDS_MISSING');
  let ids = configured ? liveIdsInput.split(',').map(id => id.trim()) : [];
  if (configured && (!ids.length || ids.length > 30 || new Set(ids).size !== ids.length || ids.some(id => decimalId(id) !== id))) {
    result.blockers.push('LIVE_IDS_INVALID'); ids = [];
  }
  if (registered && ids.some(id => registered.has(id) || [...registered.values()].some(target => target.roomNumber === id))) result.blockers.push('LIVE_ID_IS_ACCOUNT_OR_ROOM_NUMBER');
  result.requestedCount = ids.length;
  if (typeof fetchFn !== 'function') result.blockers.push('FETCH_UNAVAILABLE');
  if (result.blockers.length) return result;

  const finish = (status, reason, exitCode) => Object.assign(result, { status, reason, exitCode });
  const sent = await sendTopRequest({ method: METHOD, business: { live_ids: ids.join(','), type: '1' }, pair, fetchFn, date });
  result.requestsSent = 1;
  if (!sent.ok) {
    if (sent.apiErrorCode !== undefined) result.apiErrorCode = sent.apiErrorCode;
    if (sent.apiSubCode !== undefined) result.apiSubCode = sent.apiSubCode;
    return finish(sent.status, sent.reason, sent.exitCode);
  }
  const payload = sent.payload;
  const root = payload.live_batchlives_get_response, data = root?.result;
  if (!object(root) || !object(data)) return finish('PARTIAL', 'TOP_RESPONSE_SCHEMA_INVALID', 4);
  if (data.success !== true) return finish('REJECTED', 'TOP_BUSINESS_REJECTED', 3);
  if (hasBusinessError(data.error_code) || (object(data.result_code) && hasBusinessError(data.result_code.error_code))) return finish('REJECTED', 'TOP_BUSINESS_ERROR', 3);
  if (data.result_code != null && !object(data.result_code)) return finish('PARTIAL', 'TOP_RESPONSE_SCHEMA_INVALID', 4);
  if (!object(data.live_list) || !Array.isArray(data.live_list.live_video_do)) return finish('PARTIAL', 'TOP_RESPONSE_SCHEMA_INVALID', 4);
  const rows = data.live_list.live_video_do, indexed = new Map();
  for (const row of rows) {
    const id = object(row) && decimalId(row.live_id);
    if (!id || !ids.includes(id) || indexed.has(id)) {
      result.observations = ids.map(id => unknown(id, 'BATCH_RECORD_ID_INVALID_OR_CONFLICTING'));
      return finish('PARTIAL', 'BATCH_RECORD_ID_INVALID_OR_CONFLICTING', 4);
    }
    indexed.set(id, row);
  }
  result.observations = ids.map(id => indexed.has(id) ? observation(indexed.get(id), id, registered) : unknown(id, 'SESSION_NOT_RETURNED'));
  result.verifiedRecordCount = result.observations.filter(row => row.identityVerified && row.sourceState !== 'UNKNOWN').length;
  result.verifiedLiveCount = result.observations.filter(row => row.identityVerified && row.sourceState === 'LIVE').length;
  result.allRequestedVerified = result.verifiedRecordCount === ids.length;
  return result.allRequestedVerified ? finish('VERIFIED', 'SESSION_METADATA_VERIFIED', 0) : finish('PARTIAL', 'SOME_SESSIONS_UNVERIFIED', 4);
}

// Shared with the manual structure probes, which reuse the same credentials, target registry and transport.
export { credentials as topCredentials, targetMap as topTargetMap, decimalId as topDecimalId, object as isPlainObject };
