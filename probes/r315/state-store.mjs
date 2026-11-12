/**
 * Offline candidate selection only. A CANDIDATE is not proof of provenance and
 * is never sufficient for restore or skipping a scan. The caller must separately
 * verify GitHub API metadata, event and workflow commit SHA, artifact identity,
 * downloaded bytes and hash, source evidence, and trust policy.
 */
const ID = /^[1-9]\d*$/;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
// Hard ceiling only; independent platform policy should be more restrictive.
const ABSOLUTE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const time = value => {
  if (typeof value !== 'string' || !ISO.test(value)) return NaN;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : NaN;
};
const validId = value => typeof value === 'string' && ID.test(value);

export function selectRestorableState({ candidates, completeListing, expected, now, maxAgeMs, trustedMaxAgeMs } = {}) {
  const nowMs = time(now);
  if (completeListing !== true || !Array.isArray(candidates) || !expected ||
      !['jd', 'douyin'].includes(expected.platform) || typeof expected.repository !== 'string' ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(expected.repository) ||
      typeof expected.defaultBranch !== 'string' || !expected.defaultBranch ||
      typeof expected.workflow !== 'string' || !expected.workflow ||
      !Number.isInteger(expected.schemaVersion) || expected.schemaVersion < 1 ||
      !Number.isFinite(nowMs) || !Number.isSafeInteger(trustedMaxAgeMs) || trustedMaxAgeMs < 1 ||
      trustedMaxAgeMs > ABSOLUTE_MAX_AGE_MS || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1 ||
      maxAgeMs > trustedMaxAgeMs) return { status: 'UNKNOWN' };
  const valid = [];
  for (const item of candidates) {
    if (!item || typeof item !== 'object' || !item.run || !item.artifact || !item.state) continue;
    const { run, artifact, state } = item;
    const created = time(run.createdAt), ended = time(run.completedAt), uploaded = time(artifact.createdAt);
    const expires = time(artifact.expiresAt), observed = time(state.observedAt);
    if (run.repository !== expected.repository || run.headRepository !== expected.repository ||
        run.branch !== expected.defaultBranch || run.workflow !== expected.workflow ||
        run.status !== 'completed' || run.conclusion !== 'success' ||
        !validId(run.id) || !validId(run.attempt) || artifact.runId !== run.id || artifact.runAttempt !== run.attempt ||
        state.runId !== run.id || state.runAttempt !== run.attempt || state.platform !== expected.platform ||
        state.schemaVersion !== expected.schemaVersion || artifact.uploadComplete !== true || artifact.expired !== false ||
        state.sourceReadOk !== true || state.schemaValidated !== true || state.identityValidated !== true ||
        state.redactedStateReady !== true ||
        ![created, ended, uploaded, expires, observed].every(Number.isFinite) ||
        created > observed || observed > uploaded || uploaded > ended || ended > nowMs || expires <= nowMs ||
        nowMs - observed > maxAgeMs) continue;
    valid.push({ item, observed });
  }
  if (!valid.length) return { status: 'UNKNOWN' };
  valid.sort((a, b) => b.observed - a.observed);
  // A tie between separate runs has no independently established order.
  if (valid.length > 1 && valid[0].observed === valid[1].observed) return { status: 'UNKNOWN' };
  const { run, state } = valid[0].item;
  return {
    status: 'CANDIDATE',
    reference: { runId: run.id, runAttempt: run.attempt, observedAt: state.observedAt },
    independentVerificationRequired: true,
    usableForRestoreOrSkip: false,
  };
}
