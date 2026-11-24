/**
 * Fail-closed decision gate for already validated observations.
 * Callers must independently establish every evidence flag; this module does not
 * read a source, infer identity, calibrate an offline rule, or validate a schema.
 * The caller must pass an independent trusted evaluation clock and documented
 * source/observation age limits; evidence cannot supply its own upper bound.
 */
export function classifyObservation(evidence, policy) {
  const unknown = reason => ({ status: 'UNKNOWN', reason });
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return unknown('INVALID_EVIDENCE');
  const e = evidence;
  if (e.accessBlocked !== false || e.sourceValid !== true || e.schemaValid !== true) return unknown('SOURCE_NOT_TRUSTED');
  if (e.catalogComplete !== true) return unknown('CATALOG_NOT_COMPLETE');
  if (e.captureBound !== true || e.heartbeatValid !== true) return unknown('CAPTURE_NOT_TRUSTED');
  if (e.platformMatched !== true || e.identityVerified !== true) return unknown('IDENTITY_NOT_VERIFIED');
  if (e.conflictingEvidence !== false) return unknown('EVIDENCE_CONFLICT_OR_UNKNOWN');

  // Hard ceiling prevents absurd or overflowing policy values; callers must
  // choose tighter limits appropriate to the platform and sampling cadence.
  const MAX_POLICY_MINUTES = 24 * 60;
  const validLimit = value => Number.isFinite(value) && value >= 0 && value <= MAX_POLICY_MINUTES;
  if (!policy || typeof policy !== 'object' || Array.isArray(policy) ||
      !(policy.evaluatedAt instanceof Date) || !Number.isFinite(policy.evaluatedAt.getTime()) ||
      !validLimit(policy.maxObservationAgeMinutes) || !validLimit(policy.maxSourceAgeMinutes)) {
    return unknown('FRESHNESS_POLICY_NOT_VERIFIED');
  }
  // Require explicit timestamps and a source freshness limit no greater than
  // the independently configured limit. Future and replayed samples fail.
  if (typeof e.checkedAt !== 'string' || typeof e.sourceUpdatedAt !== 'string' ||
      !validLimit(e.maxAgeMinutes) || e.maxAgeMinutes > policy.maxSourceAgeMinutes) return unknown('FRESHNESS_NOT_VERIFIED');
  const parseTime = value => {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
    if (!match) return NaN;
    const [, year, month, day, hour, minute, second, zone] = match;
    const y = Number(year), m = Number(month), d = Number(day);
    const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (m < 1 || m > 12 || d < 1 || d > days[m - 1] || Number(hour) > 23 ||
        Number(minute) > 59 || Number(second) > 59 ||
        (zone !== 'Z' && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4, 6)) > 59))) return NaN;
    return Date.parse(value);
  };
  const checked = parseTime(e.checkedAt), updated = parseTime(e.sourceUpdatedAt);
  const evaluated = policy.evaluatedAt.getTime();
  if (!Number.isFinite(checked) || !Number.isFinite(updated) || updated > checked || checked > evaluated ||
      evaluated - checked > policy.maxObservationAgeMinutes * 60_000 ||
      evaluated - updated > e.maxAgeMinutes * 60_000) return unknown('FRESHNESS_NOT_VERIFIED');

  if (e.liveEvidence === true && e.offlineEvidence === true) return unknown('CONFLICTING_STATUS_EVIDENCE');
  if (e.liveEvidence === true && e.offlineEvidence === false) return { status: 'LIVE', reason: 'VERIFIED_CURRENT_LIVE_EVIDENCE' };
  if (e.offlineEvidence === true && e.liveEvidence === false && e.offlineRuleValidated === true)
    return { status: 'OFFLINE', reason: 'VALIDATED_OFFLINE_EVIDENCE' };
  return unknown('STATUS_NOT_VERIFIED');
}
