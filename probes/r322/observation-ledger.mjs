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
// R3.25: the verified profile itself showed a live link to THIS account's own room (owner-scoped, or the
// single live link equal to its registered room). Profile-only evidence: never turned into LIVE, which
// still needs profile AND room page identity.
const OWN_ROOM_SCOPES = new Set(['OWNER_HEADER_LIVE_ANCHOR', 'REGISTERED_ROOM_LIVE_ANCHOR']);
function normalizeRow(r, platform, { stored = false } = {}) {
  if (!object(r) || typeof r.key !== 'string' || !KEY.test(r.key) || !STATES.has(r.state)) fail();
  const reportedReason = canonicalReason(r.reason);
  for (const k of ['profileIdentityVerified','roomIdentityVerified','roomPageIdentityVerified','offlineEvidence','offlineRuleValidated','liveBadgeSeen'])
    if (r[k] !== undefined && typeof r[k] !== 'boolean') fail();
  if (r.ownerAnchorScope !== undefined && (typeof r.ownerAnchorScope !== 'string' || !REASON.test(r.ownerAnchorScope))) fail();
  // Ledger rows keep only the derived flag, and only when true (R3.22 ledgers stay valid unchanged).
  // Receipt rows can never assert it directly: it is derived from the probe's own fields.
  if (stored && r.ownRoomLiveBadge !== undefined && r.ownRoomLiveBadge !== true) fail();
  const ownRoomLiveBadge = stored ? r.ownRoomLiveBadge === true
    : r.state !== 'NOT_RUN' && r.profileIdentityVerified === true && r.liveBadgeSeen === true && OWN_ROOM_SCOPES.has(r.ownerAnchorScope);
  if (ownRoomLiveBadge && r.profileIdentityVerified !== true) fail();
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
    offlineEvidence:r.offlineEvidence === true, offlineRuleValidated:r.offlineRuleValidated === true,
    ...(ownRoomLiveBadge ? { ownRoomLiveBadge: true } : {}) };
}
function readLedger(previous) {
  if (previous === null || previous === undefined) return null;
  if (!object(previous) || previous.schemaVersion !== 322 || !KINDS.has(previous.evidenceKind) ||
      !Array.isArray(previous.observations) || typeof previous.retentionTruncated !== 'boolean') fail();
  if (iso(previous.latestAt) !== previous.latestAt) fail();
  const seen = new Set();
  for (const r of previous.observations) {
    if (!object(r) || !PLATFORMS.has(r.platform)) fail();
    const normalized = normalizeRow({...r, state:r.reportedState,reason:r.reportedReason}, r.platform, { stored: true });
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

/** Beijing calendar day (YYYY-MM-DD) of an ISO instant. */
export function beijingDay(isoAt) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(isoAt));
}
/**
 * R3.28 broadcast day (user rule 2026-11-14): a sighting between 00:00 and 06:00 Beijing time belongs to the
 * PREVIOUS day's session (streams run past midnight; the next session starts after a gap).
 */
export const BROADCAST_DAY_START_HOUR = 6;
export function broadcastDay(isoAt) { return beijingDay(new Date(Date.parse(isoAt) - BROADCAST_DAY_START_HOUR * 3600e3).toISOString()); }
/**
 * R3.25 "did this account broadcast today?" per account and broadcast day (06:00 to 06:00 Beijing time).
 * BROADCAST_SEEN: at least one sample showed it live (strongest evidence reported).
 * NOT_SEEN_IN_SAMPLES: verified samples exist but none showed it live. NOT proof that it did not broadcast:
 *   a session between samples can be missed.
 * UNKNOWN: no verified sample that day (blocked, not run or identity not verified).
 */
export function buildDailyBroadcast(ledger) {
  const valid = readLedger(ledger);
  if (!valid) fail();
  const latestDay = broadcastDay(valid.latestAt);
  const groups = new Map();
  for (const r of valid.observations) {
    const id = `${r.platform}:${r.key}:${broadcastDay(r.at)}`;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(r);
  }
  const days = [];
  for (const rows of groups.values()) {
    rows.sort((a, b) => a.at.localeCompare(b.at));
    const verified = rows.filter(r => r.state !== 'NOT_RUN' && r.profileIdentityVerified === true);
    const dual = rows.filter(r => r.state === 'LIVE');            // ledger LIVE already needs both identities
    const badge = rows.filter(r => r.ownRoomLiveBadge === true);
    const seen = [...new Set([...dual, ...badge])].sort((a, b) => a.at.localeCompare(b.at));
    const date = broadcastDay(rows[0].at);
    days.push({ platform: rows[0].platform, key: rows[0].key, date,
      status: seen.length ? 'BROADCAST_SEEN' : verified.length ? 'NOT_SEEN_IN_SAMPLES' : 'UNKNOWN',
      evidence: dual.length ? 'PROFILE_AND_ROOM_PAGE_IDENTITY' : badge.length ? 'PROFILE_OWN_ROOM_LIVE_BADGE' : null,
      firstSeenAt: seen[0]?.at ?? null, lastSeenAt: seen.at(-1)?.at ?? null,
      samples: rows.length, verifiedSamples: verified.length,
      firstVerifiedSampleAt: verified[0]?.at ?? null, lastVerifiedSampleAt: verified.at(-1)?.at ?? null,
      latestDay: date === latestDay, retentionTruncated: valid.retentionTruncated });
  }
  return days.sort((a, b) => b.date.localeCompare(a.date) || a.platform.localeCompare(b.platform) || a.key.localeCompare(b.key));
}
