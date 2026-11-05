/**
 * TCL Live Matrix R0.6: Unified Douyin Matrix Coverage, Deduplication,
 * Scoring-Denominator Separation & Ops Reconciliation Module.
 *
 * Consolidates R0.2 evaluate.mjs + reconcile.mjs into the R0.5/R0.6 repo-overlay:
 * 1) Supports alphanumeric displayDouyinId (e.g. 'TCLkongtiao', 'FoxsineZN', 'wlhnumber1');
 * 2) Accepts either explicit t.secUid or extracts secUid from t.profileUrl;
 * 3) Separates monitored accounts (scopeApproved=true) from KPI-scored accounts
 *    (scoringEligible=true), ensuring dealers/sub-brands never inflate/deflate
 *    corporate attendance denominators;
 * 4) Fails closed on shared physical roomId across multiple accounts;
 * 5) Reconciles unmapped third-party ops platform Douyin rows conservatively.
 */
const STATES = new Set(['LIVE', 'OFFLINE', 'UNKNOWN']);
const asId = (x) => String(x ?? '').trim();

const validTime = (x) => {
  if (typeof x === 'number' && Number.isFinite(x)) return x;
  if (typeof x === 'string' && x.trim()) {
    const n = Date.parse(x);
    if (Number.isFinite(n)) return n;
  }
  return null;
};

export function extractSecUid(target) {
  if (target?.secUid && /^MS4wLjABAAAA[A-Za-z0-9_\-]{20,}$/.test(asId(target.secUid))) {
    return asId(target.secUid);
  }
  if (target?.profileUrl) {
    try {
      const u = new URL(target.profileUrl);
      const m = /^\/user\/(MS4wLjABAAAA[A-Za-z0-9_\-]{20,})$/.exec(u.pathname);
      if (m) return m[1];
    } catch {}
  }
  return '';
}

export function validateMatrixTargets(targets) {
  if (!Array.isArray(targets)) throw new Error('TARGETS_NOT_ARRAY');
  const keys = new Set(), secUids = new Set(), displayIds = new Set();
  for (const t of targets) {
    if (!t || typeof t !== 'object') throw new Error('BAD_TARGET');
    if (t.scopeApproved !== true || (t.status !== undefined && t.status !== 'approved')) {
      throw new Error('UNAPPROVED_TARGET:' + asId(t.key));
    }
    const key = asId(t.key);
    const secUid = extractSecUid(t);
    const displayId = asId(t.displayDouyinId);
    if (!key || !/^MS4wLjABAAAA[A-Za-z0-9_\-]{20,}$/.test(secUid) || !/^[A-Za-z0-9._\-]{3,32}$/.test(displayId)) {
      throw new Error('INVALID_TARGET_ID:' + key);
    }
    if (keys.has(key)) throw new Error('DUPLICATE_TARGET_KEY:' + key);
    if (secUids.has(secUid) || displayIds.has(displayId.toLowerCase())) {
      throw new Error('DUPLICATE_ACCOUNT_IDENTITY:' + key);
    }
    keys.add(key);
    secUids.add(secUid);
    displayIds.add(displayId.toLowerCase());
  }
  return true;
}

function classifyObservation(o) {
  if (!o || !STATES.has(o.state)) return { state: 'UNKNOWN', reason: 'INVALID_OBSERVATION' };
  if (o.state === 'LIVE') {
    if (o.profileIdentityVerified !== true || o.roomPageIdentityVerified !== true || !/^\d{5,24}$/.test(asId(o.checkedRoomId || o.observedRoomId))) {
      return { state: 'UNKNOWN', reason: 'LIVE_EVIDENCE_NOT_CORROBORATED' };
    }
    return { state: 'LIVE', reason: 'CROSS_VERIFIED_LIVE' };
  }
  if (o.state === 'OFFLINE') {
    if (o.offlineEvidence !== true || o.offlineRuleValidated !== true || o.profileIdentityVerified !== true) {
      return { state: 'UNKNOWN', reason: 'OFFLINE_EVIDENCE_NOT_VALIDATED' };
    }
    return { state: 'OFFLINE', reason: 'CROSS_VERIFIED_OFFLINE' };
  }
  return { state: 'UNKNOWN', reason: asId(o.reason) || 'READER_UNKNOWN' };
}

export function evaluateDouyinMatrix({ targets, observations, now = Date.now(), maxAgeMinutes = 12, candidateCount = 0 }) {
  validateMatrixTargets(targets);
  if (!Array.isArray(observations)) throw new Error('OBSERVATIONS_NOT_ARRAY');
  if (!Number.isFinite(now) || maxAgeMinutes <= 0 || !Number.isFinite(maxAgeMinutes)) throw new Error('BAD_TIME_WINDOW');
  const groups = new Map(targets.map(t => [t.key, []]));
  const rejects = [];
  for (const o of observations) {
    if (!groups.has(o?.accountId)) {
      rejects.push({ accountId: asId(o?.accountId), reason: 'UNAPPROVED_OR_UNKNOWN_ACCOUNT' });
      continue;
    }
    const at = validTime(o.at);
    if (at === null || at > now + 60_000 || now - at > maxAgeMinutes * 60_000) {
      rejects.push({ accountId: asId(o.accountId), reason: 'MISSING_FUTURE_OR_STALE_TIMESTAMP' });
      continue;
    }
    groups.get(o.accountId).push({ ...o, _at: at });
  }
  const accounts = [];
  for (const t of targets) {
    const name = asId(t.accountName || t.name);
    const scoringEligible = t.scoringEligible !== false;
    const latest = groups.get(t.key).sort((a, b) => b._at - a._at);
    if (!latest.length) {
      accounts.push({ key: t.key, name, scoringEligible, state: 'UNKNOWN', reason: 'NO_FRESH_EVIDENCE', observedAt: null, checkedRoomId: null });
      continue;
    }
    const freshest = latest.filter(x => x._at === latest[0]._at);
    const tie = freshest.map(x => classifyObservation(x));
    const roomIds = new Set(freshest.map(x => asId(x.checkedRoomId || x.observedRoomId)).filter(Boolean));
    let dec;
    if (new Set(tie.map(x => x.state)).size > 1 || roomIds.size > 1) {
      dec = { state: 'UNKNOWN', reason: 'CONFLICTING_SAME_TIME_OBSERVATIONS' };
    } else {
      dec = tie[0];
    }
    const latestId = asId(latest[0].checkedRoomId || latest[0].observedRoomId);
    accounts.push({
      key: t.key,
      name,
      scoringEligible,
      state: dec.state,
      reason: dec.reason,
      observedAt: new Date(latest[0]._at).toISOString(),
      checkedRoomId: latestId || null,
    });
  }
  const byRoom = new Map();
  for (const a of accounts) {
    if (a.state === 'LIVE' && a.checkedRoomId) {
      const list = byRoom.get(a.checkedRoomId) || [];
      list.push(a);
      byRoom.set(a.checkedRoomId, list);
    }
  }
  const conflicts = [];
  for (const [roomId, list] of byRoom) {
    if (list.length > 1) {
      for (const a of list) {
        a.state = 'UNKNOWN';
        a.reason = 'SHARED_ROOM_ID_ACCOUNT_CONFLICT';
      }
      conflicts.push({ roomId, accountKeys: list.map(x => x.key) });
    }
  }
  const counts = { LIVE: 0, OFFLINE: 0, UNKNOWN: 0 };
  const scoringCounts = { LIVE: 0, OFFLINE: 0, UNKNOWN: 0 };
  for (const a of accounts) {
    counts[a.state]++;
    if (a.scoringEligible) scoringCounts[a.state]++;
  }
  const total = accounts.length;
  const fresh = total - counts.UNKNOWN;
  const scoringTotal = accounts.filter(a => a.scoringEligible).length;
  const scoringFresh = scoringTotal - scoringCounts.UNKNOWN;
  return {
    generatedAt: new Date(now).toISOString(),
    sourceType: 'verified_external_observations_only',
    scope: 'configured_and_approved_accounts_only',
    monitoredAccounts: total,
    scoringEligibleAccounts: scoringTotal,
    monitorOnlyAccounts: total - scoringTotal,
    unverifiedCandidateAccounts: candidateCount,
    ...counts,
    scoringSummary: scoringCounts,
    knownStateCoveragePct: total ? Math.round((1000 * fresh) / total) / 10 : null,
    scoringKnownStateCoveragePct: scoringTotal ? Math.round((1000 * scoringFresh) / scoringTotal) / 10 : null,
    confirmedLiveLowerBound: counts.LIVE,
    possibleLiveUpperBoundWithinMonitored: counts.LIVE + counts.UNKNOWN,
    totalTclLiveRooms: 'UNKNOWN_NOT_ENUMERATED',
    conflicts,
    rejectedObservations: rejects,
    accounts,
  };
}

export function reconcileOpsDouyin({ approvedAccounts, opsRooms, verifiedBindings = [] }) {
  if (!Array.isArray(approvedAccounts) || !Array.isArray(opsRooms) || !Array.isArray(verifiedBindings)) {
    throw new Error('INVALID_INPUT');
  }
  const ids = new Set(approvedAccounts.map(x => x.key));
  const rowIds = new Set();
  for (const x of opsRooms) {
    if (!Number.isSafeInteger(x?.opsRoomRowId) || rowIds.has(x.opsRoomRowId)) {
      throw new Error('INVALID_OR_DUPLICATE_OPS_ROW');
    }
    rowIds.add(x.opsRoomRowId);
  }
  const mapped = new Map(), usedKeys = new Set();
  for (const b of verifiedBindings) {
    if (!rowIds.has(b.opsRoomRowId)) throw new Error('UNKNOWN_OPS_ROW');
    if (!ids.has(b.approvedAccountKey)) throw new Error('UNAPPROVED_ACCOUNT');
    if (b.identityVerified !== true || !/^https:\/\//.test(String(b.sourceUrl || ''))) {
      throw new Error('MISSING_VERIFIED_EVIDENCE');
    }
    if (mapped.has(b.opsRoomRowId) || usedKeys.has(b.approvedAccountKey)) {
      throw new Error('BINDING_CONFLICT');
    }
    mapped.set(b.opsRoomRowId, b.approvedAccountKey);
    usedKeys.add(b.approvedAccountKey);
  }
  return {
    opsRowCount: opsRooms.length,
    approvedPublicAccountCount: approvedAccounts.length,
    verifiedMappedRows: mapped.size,
    unmappedOpsRowIds: opsRooms.filter(x => !mapped.has(x.opsRoomRowId)).map(x => x.opsRoomRowId),
    uniqueTclOfficialAccountsAcrossBothSources: 'UNKNOWN_UNTIL_IDENTITY_CROSSWALK',
    inferredNewAccounts: 0,
  };
}
