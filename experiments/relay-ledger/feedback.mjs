// Offline adapter contract. No credentials are loaded, no signer is provisioned,
// and no GitHub callback or Worker route is installed by this module.
import {createHash, createHmac, timingSafeEqual} from 'node:crypto';

export const TARGET = Object.freeze({
  repository: 'lijianjun004-star/tcl-live-monitor',
  workflow: 'jd-r33-backup.yml',
  ref: 'main',
});
export const identifier = x => typeof x === 'string' && /^[A-Za-z0-9_-]{1,96}$/.test(x);
export const timestamp = x => Number.isSafeInteger(x) && x >= 0 && x <= 8640000000000000;
export const exactKeys = (x, keys) => x !== null && typeof x === 'object' && !Array.isArray(x) &&
  Object.keys(x).sort().join() === [...keys].sort().join();
export const canonical = x => {
  if (Array.isArray(x)) return '[' + x.map(canonical).join(',') + ']';
  if (x !== null && typeof x === 'object') return '{' + Object.keys(x).sort()
    .map(k => JSON.stringify(k) + ':' + canonical(x[k])).join(',') + '}';
  return JSON.stringify(x);
};
export const hash = x => createHash('sha256').update(canonical(x)).digest('hex');
export const validTarget = x => exactKeys(x, ['repository', 'workflow', 'ref', 'headSha']) &&
  Object.entries(TARGET).every(([k, v]) => x[k] === v) &&
  typeof x.headSha === 'string' && /^[a-f0-9]{40}$/.test(x.headSha);
export const validRun = x => exactKeys(x, ['runId', 'runAttempt']) &&
  typeof x.runId === 'string' && /^[1-9][0-9]{0,19}$/.test(x.runId) &&
  Number.isSafeInteger(x.runAttempt) && x.runAttempt > 0;

const common = ['schemaVersion', 'keyId', 'nonce', 'issuedAt', 'expiresAt',
  'expectedRevision', 'action', 'attemptId', 'target', 'run'];
const extra = {
  RUN_BOUND: [],
  SOURCE_RESULT: ['outcome', 'evidenceRef', 'reviewDelayMs'],
  REVIEW_RELEASE: ['reviewRef', 'expectedStateHash'],
};

/** The supplied key map is a trust boundary, NOT an assertion of human approval.
 * Messages must be signed by the separately approved trusted correlation service.
 * Test keys are synthetic; this candidate never loads a key from process.env. */
export function verifyFeedback(envelope, {keys, now, maxLifetimeMs = 300_000} = {}) {
  const deny = () => { throw Error('RELAY_FEEDBACK_UNAUTHENTICATED'); };
  if (!exactKeys(envelope, ['payload', 'signature']) ||
      !envelope.payload || !Object.hasOwn(extra, envelope.payload.action)) return deny();
  const p = envelope.payload;
  if (!exactKeys(p, [...common, ...extra[p.action]]) || p.schemaVersion !== 1 ||
      !identifier(p.keyId) || !identifier(p.nonce) || !identifier(p.attemptId) ||
      !timestamp(now) || !timestamp(p.issuedAt) || !timestamp(p.expiresAt) ||
      p.issuedAt > now || p.expiresAt < now || p.expiresAt <= p.issuedAt ||
      !Number.isSafeInteger(maxLifetimeMs) || maxLifetimeMs < 1 ||
      p.expiresAt - p.issuedAt > maxLifetimeMs ||
      !Number.isSafeInteger(p.expectedRevision) || p.expectedRevision < 0 ||
      !validTarget(p.target) || !validRun(p.run) ||
      typeof envelope.signature !== 'string' || !/^[a-f0-9]{64}$/.test(envelope.signature)) return deny();
  if (p.action === 'SOURCE_RESULT' &&
      (!['SUCCESS', 'FAILURE'].includes(p.outcome) || !identifier(p.evidenceRef) ||
       (p.outcome === 'SUCCESS' ? p.reviewDelayMs !== null :
         !Number.isSafeInteger(p.reviewDelayMs) || p.reviewDelayMs <= 0 ||
         !timestamp(now + p.reviewDelayMs)))) return deny();
  if (p.action === 'REVIEW_RELEASE' &&
      (!identifier(p.reviewRef) || typeof p.expectedStateHash !== 'string' ||
       !/^[a-f0-9]{64}$/.test(p.expectedStateHash))) return deny();
  // Own-property lookup prevents key identifiers such as __proto__ from selecting
  // inherited properties. Require raw key bytes, never a casually coerced string.
  if (!keys || !Object.hasOwn(keys, p.keyId)) return deny();
  const key = keys[p.keyId];
  if (!exactKeys(key, ['secret', 'actions']) || !Buffer.isBuffer(key.secret) ||
      key.secret.length < 32 || key.secret.length > 128 || !Array.isArray(key.actions) ||
      !key.actions.includes(p.action)) return deny();
  const expected = createHmac('sha256', key.secret).update('tcl-relay-feedback-v1\n' + canonical(p)).digest();
  if (!timingSafeEqual(expected, Buffer.from(envelope.signature, 'hex'))) return deny();
  return structuredClone(p);
}
