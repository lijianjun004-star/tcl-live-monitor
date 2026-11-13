/** Offline, redacted observations only. Sample bounds never prove exact session times. */
const STATES = new Set(['LIVE', 'OFFLINE', 'UNKNOWN', 'NOT_RUN']);
const PLATFORMS = new Set(['douyin', 'jd', 'tmall']);
const KINDS = new Set(['real', 'synthetic']);
const KEY = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;
const REASON = /^[A-Z][A-Z0-9_]{0,119}$/;
const WEEK = 7 * 86400000;
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const fail = () => { throw new Error('LEDGER_INPUT_INVALID'); };
function iso(x) {
  if (typeof x !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(x)) fail();
  const n = Date.parse(x);
  if (!Number.isFinite(n) || new Date(n).toISOString().slice(0,19) !== x.slice(0,19)) fail();
  return new Date(n).toISOString();
}
// Exact reason strings emitted by older probe code that are not canonical tokens. Mapped, never
// pattern-matched, so free text can still never enter the ledger (R3.22 review, Claude).
const LEGACY_REASONS = new Map([['NO_LIVE_BADGE; not proof of offline', 'NO_LIVE_BADGE_NOT_PROOF_OF_OFFLINE']]);
function canonicalReason(x) {
  const r = typeof x === 'string' ? (LEGACY_REASONS.get(x) ?? x) : x;
  if (typeof r !== 'string' || !REASON.test(r)) fail();
  return r;
}
function normalizeRow(r, platform) {
  if (!object(r) || typeof r.key !== 'string' || !KEY.test(r.key) || !STATES.has(r.state)) fail();
  const reportedReason = canonicalReason(r.reason);
  for (const k of ['profileIdentityVerified','roomIdentityVerified','roomPageIdentityVerified','offlineEvidence','offlineRuleValidated'])
    if (r[k] !== undefined && typeof r[k] !== 'boolean') fail();
  const at = iso(r.at);
  const roomVerified = r.roomIdentityVerified === true || r.roomPageIdentityVerified === true;
  if (r.roomIdentityVerified !== undefined && r.roomPageIdentityVerified !== undefined && r.roomIdentityVerified !== r.roomPageIdentityVerified) fail();
  let state = r.state, reason = reportedReason;
  if (state === 'LIVE' && !(r.profileIdentityVerified === true && roomVerified)) {
    state = 'UNKNOWN'; reason = 'IDENTITY_NOT_VERIFIED';
  }
  if (state === 'OFFLINE' && !(r.offlineEvidence === true && r.offlineRuleValidated === true && r.profileIdentityVerified === true && roomVerified)) {
    state = 'UNKNOWN'; reason = 'OFFLINE_RULE_NOT_VALIDATED';
  }
  return { platform, key:r.key, at, state, reason, reportedState:r.state,reportedReason,
    profileIdentityVerified:r.profileIdentityVerified === true, roomIdentityVerified:roomVerified,
    offlineEvidence:r.offlineEvidence === true, offlineRuleValidated:r.offlineRuleValidated === true };
}
function readLedger(previous) {
  if (previous === null || previous === undefined) return null;
  if (!object(previous) || previous.schemaVersion !== 322 || !KINDS.has(previous.evidenceKind) ||
      !Array.isArray(previous.observations) || typeof previous.retentionTruncated !== 'boolean') fail();
  if (iso(previous.latestAt) !== previous.latestAt) fail();
  const seen = new Set();
  for (const r of previous.observations) {
    if (!object(r) || !PLATFORMS.has(r.platform)) fail();
    const normalized = normalizeRow({...r, state:r.reportedState,reason:r.reportedReason}, r.platform);
    if (JSON.stringify(normalized) !== JSON.stringify(r)) fail();
    const id = `${r.platform}:${r.key}:${r.at}`;
    if (seen.has(id) || r.at > previous.latestAt || Date.parse(r.at) < Date.parse(previous.latestAt) - WEEK) fail();
    seen.add(id);
  }
  return previous;
}
export function importReceipt(previous, receipt, {platform='douyin', evidenceKind='real'}={}) {
  if (!PLATFORMS.has(platform) || !KINDS.has(evidenceKind) || !object(receipt) || receipt.schemaVersion !== 319 || !Array.isArray(receipt.checked)) fail();
  const receiptAt = iso(receipt.at);
  if (receipt.evidenceKind !== undefined && receipt.evidenceKind !== evidenceKind) throw new Error('EVIDENCE_KIND_MISMATCH');
  const prior = readLedger(previous);
  if (prior && prior.evidenceKind !== evidenceKind) throw new Error('EVIDENCE_KIND_MISMATCH');
  const rows = receipt.checked.map(r => normalizeRow(r, platform));
  if (rows.some(r => r.at > receiptAt)) fail();
  const all = new Map();
  for (const r of [...(prior?.observations ?? []), ...rows]) {
    const id = `${r.platform}:${r.key}:${r.at}`, existing = all.get(id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(r)) throw new Error('OBSERVATION_CONFLICT');
    all.set(id, r);
  }
  const latestAt = [prior?.latestAt, receiptAt].filter(Boolean).sort().at(-1);
  const cutoff = Date.parse(latestAt) - WEEK;
  const observations = [...all.values()].filter(r => Date.parse(r.at) >= cutoff)
    .sort((a,b) => a.at.localeCompare(b.at) || a.platform.localeCompare(b.platform) || a.key.localeCompare(b.key));
  return {schemaVersion:322, evidenceKind, latestAt,
    retentionTruncated:prior?.retentionTruncated === true || observations.length < all.size, observations};
}
export function buildSummary(ledger) {
  const valid = readLedger(ledger);
  if (!valid) fail();
  const groups = new Map();
  for (const r of valid.observations) {
    const id = `${r.platform}:${r.key}`;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(r);
  }
  const rooms = [], sessions = [];
  for (const samples of groups.values()) {
    samples.sort((a,b) => a.at.localeCompare(b.at));
    const latest = samples.at(-1);
    // NOT_RUN means the page was never visited: it is a record, not an observation.
    const executedCount = samples.filter(x => x.state !== 'NOT_RUN').length;
    rooms.push({platform:latest.platform,key:latest.key,state:latest.state,lastObservedAt:latest.at,
      reason:latest.reason,observationCount:samples.length,executedCount,notRunCount:samples.length - executedCount,
      retentionTruncated:valid.retentionTruncated});
    let current = null, previousAt = null;
    for (const r of samples) {
      if (current && previousAt) {
        const gap = Date.parse(r.at) - Date.parse(previousAt);
        if (gap > 900000) current.hasSamplingGaps = true;
        current.maxSampleGapSeconds = Math.max(current.maxSampleGapSeconds, Math.round(gap / 1000));
      }
      previousAt = r.at;
      if (r.state === 'LIVE') {
        if (!current) {
          current = {platform:r.platform,key:r.key,firstSeenLiveAt:r.at,lastSeenLiveAt:r.at,
            firstSeenOfflineAt:null,exactStartAt:null,exactEndAt:null,durationSeconds:null,
            status:'END_UNCONFIRMED',hasUnknownObservations:false,hasSamplingGaps:false,samplingGapThresholdSeconds:900,maxSampleGapSeconds:0,continuityVerified:false,
            retentionTruncated:valid.retentionTruncated};
          sessions.push(current);
        } else current.lastSeenLiveAt = r.at;
      } else if (r.state === 'OFFLINE' && current) {
        current.firstSeenOfflineAt = r.at; current.status = 'OFFLINE_OBSERVED'; current = null;
      } else if (current) current.hasUnknownObservations = true;
    }
  }
  return {rooms:rooms.sort((a,b)=>a.platform.localeCompare(b.platform)||a.key.localeCompare(b.key)),sessions};
}
