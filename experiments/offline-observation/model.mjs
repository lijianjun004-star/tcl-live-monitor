/** Independent offline model. No transport, credentials, storage, or production caller. */
const platforms = new Set(['jd', 'tmall', 'douyin']);
const id = x => typeof x === 'string' && /^[A-Za-z0-9_-]{1,96}$/.test(x);
const key = x => JSON.stringify([x?.platform, x?.accountId]);
const instant = x => {
  if (typeof x !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(x)) return null;
  const ms = Date.parse(x);
  return Number.isFinite(ms) && new Date(ms).toISOString() === x ? ms : null;
};
const pick = (value, options) => options.includes(value) ? value : 'UNKNOWN';
const timeState = (value, now, limit) => {
  if (value == null) return 'MISSING';
  const t = instant(value);
  return t === null || t > now ? 'INVALID' : now - t > limit ? 'STALE' : 'FRESH';
};

/**
 * Reviewed bindings and evidence are caller assertions, NOT authentication.
 * Thresholds are mandatory offline evaluation inputs, not a polling schedule.
 * Every registered binding produces a row even when no observation exists.
 */
export function evaluateObservations({bindings, observations, now, maxObservationAgeMs, maxHeartbeatAgeMs} = {}) {
  const clock = instant(now);
  if (clock === null || ![maxObservationAgeMs,maxHeartbeatAgeMs].every(n => Number.isSafeInteger(n) && n > 0))
    throw new Error('INVALID_EVALUATION_CLOCK_OR_LIMIT');
  if (!Array.isArray(bindings) || !Array.isArray(observations) || bindings.length > 1000 || observations.length > 1000)
    throw new Error('INVALID_OR_OVERSIZED_INPUT');
  const bindingCounts = new Map(), samples = new Map();
  for (const b of bindings) bindingCounts.set(key(b), (bindingCounts.get(key(b)) || 0) + 1);
  for (const o of observations) {
    const k = key(o); samples.set(k, [...(samples.get(k) || []), o]);
  }
  const rows = bindings.map(b => {
    const validBinding = platforms.has(b?.platform) && [b?.accountId,b?.shopId,b?.entityRoomId].every(id);
    const row = {
      platform: platforms.has(b?.platform) ? b.platform : null,
      accountId: id(b?.accountId) ? b.accountId : null,
      shopId: id(b?.shopId) ? b.shopId : null,
      entityRoomId: id(b?.entityRoomId) ? b.entityRoomId : null,
      broadcastSessionId: null,
      identity: 'UNVERIFIED', sourceHealth: 'UNKNOWN', loginStatus: 'UNKNOWN',
      dataFreshness: 'MISSING', heartbeat: 'MISSING', broadcastState: 'UNKNOWN',
      evaluatedAt: now, receivedAt: null, observedAt: null, effectiveObservedAt: null,
      heartbeatAt: null, evidenceRef: null, reason: 'IDENTITY_UNVERIFIED',
    };
    if (bindingCounts.get(key(b)) > 1) return {...row, identity:'CONFLICT', reason:'DUPLICATE_ACCOUNT_BINDING'};
    if (!validBinding || b.reviewed !== true || !id(b.reviewRef)) return row;
    const reviewedAt = instant(b.reviewedAt), reviewExpiresAt = instant(b.reviewExpiresAt);
    if (reviewedAt === null || reviewExpiresAt === null || reviewedAt > clock || reviewExpiresAt <= clock || reviewExpiresAt <= reviewedAt)
      return {...row, reason:'IDENTITY_REVIEW_TIME_INVALID_OR_EXPIRED'};
    row.identity = 'REVIEWED_INPUT';
    const candidates = samples.get(key(b)) || [];
    if (candidates.length !== 1) return {...row, reason:candidates.length ? 'DUPLICATE_OBSERVATION' : 'MISSING_SAMPLE'};
    const o = candidates[0];
    if (o.shopId !== b.shopId || o.entityRoomId !== b.entityRoomId)
      return {...row, identity:'CONFLICT', reason:'IDENTITY_MISMATCH'};
    row.sourceHealth = pick(o.sourceHealth, ['AVAILABLE','UNAVAILABLE']);
    row.loginStatus = pick(o.loginStatus, ['OK','REQUIRED','EXPIRED','NOT_REQUIRED']);
    row.dataFreshness = timeState(o.observedAt,clock,maxObservationAgeMs);
    row.heartbeat = timeState(o.heartbeatAt,clock,maxHeartbeatAgeMs);
    const observed = instant(o.observedAt), received = instant(o.receivedAt), hb = instant(o.heartbeatAt);
    row.observedAt = observed !== null && observed <= clock ? o.observedAt : null;
    row.receivedAt = received !== null && received <= clock ? o.receivedAt : null;
    row.heartbeatAt = hb !== null && hb <= clock ? o.heartbeatAt : null;
    if (received === null || received > clock || observed === null || observed > received || hb === null || hb > received) {
      return {...row, reason:'INVALID_OR_MISSING_TIME'};
    }
    if (row.sourceHealth !== 'AVAILABLE') return {...row,reason:'SOURCE_NOT_AVAILABLE'};
    if (!['OK','NOT_REQUIRED'].includes(row.loginStatus)) return {...row,reason:'LOGIN_NOT_READY'};
    if (row.dataFreshness !== 'FRESH') return {...row,reason:'OBSERVATION_NOT_FRESH'};
    if (row.heartbeat !== 'FRESH') return {...row,reason:'HEARTBEAT_NOT_FRESH'};
    if (!id(o.evidenceRef) || o.evidenceReviewed !== true) return {...row,reason:'EVIDENCE_NOT_REVIEWED'};
    if (!['LIVE','OFFLINE'].includes(o.broadcastState)) return {...row,reason:'NO_EXPLICIT_BROADCAST_EVIDENCE'};
    // No heartbeat/no minutes/gaps/login errors can satisfy this negative-evidence gate.
    if (o.broadcastState === 'OFFLINE' && o.negativeEvidenceReviewed !== true)
      return {...row,reason:'NEGATIVE_EVIDENCE_NOT_REVIEWED'};
    if (o.broadcastSessionId != null && !id(o.broadcastSessionId)) return {...row,reason:'INVALID_SESSION_IDENTIFIER'};
    return {...row, broadcastSessionId:o.broadcastSessionId ?? null,
      broadcastState:o.broadcastState, effectiveObservedAt:o.observedAt,
      evidenceRef:o.evidenceRef, reason:'EXPLICIT_REVIEWED_INPUT'};
  });
  return {schemaVersion:1, mode:'OFFLINE_PROTOTYPE', rows,
    unmatchedObservationCount: observations.filter(o => !bindingCounts.has(key(o))).length,
    actualStartAt:null, actualEndAt:null, scoringEnabled:false};
}
