// Local, OFFLINE ledger adapter. It deliberately has no dispatch function and
// is not imported by the Worker. All results keep dispatch:false.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {bootstrapSimulation, transition, stateHash} from './model.mjs';
import {canonical, hash, identifier, timestamp, exactKeys, validTarget, validRun,
  verifyFeedback} from './feedback.mjs';

const MAX_BYTES = 2 * 1024 * 1024;
const reject = code => { throw Error('RELAY_' + code); };
const isRevision = n => Number.isSafeInteger(n) && n >= 0;
const deny = (reason, snapshot) => ({accepted: false, dispatch: false, reason, snapshot});
const entryExists = file => {
  try { fs.lstatSync(file); return true; }
  catch (e) { if (e.code === 'ENOENT') return false; throw e; }
};

function checkDirectory(directory) {
  const absolute = path.resolve(directory);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) reject('UNTRUSTED_DIRECTORY');
  }
  const normalize = p => process.platform === 'win32' ? p.toLowerCase() : p;
  if (normalize(fs.realpathSync.native(absolute)) !== normalize(absolute)) reject('DIRECTORY_ALIAS');
  return absolute;
}

function readRegular(file) {
  let fd;
  try {
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_BYTES) reject('STATE_INVALID');
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || before.dev !== opened.dev || before.ino !== opened.ino || opened.size > MAX_BYTES) reject('STATE_INVALID');
    const bytes = Buffer.alloc(opened.size + 1);
    const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
    if (count !== opened.size) reject('STATE_INVALID');
    return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes.subarray(0, count)));
  } catch { reject('STATE_MISSING_OR_INVALID'); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

function syncDirectory(directory) {
  let fd;
  try { fd = fs.openSync(directory, 'r'); fs.fsyncSync(fd); return 'FILE_AND_DIRECTORY_SYNC'; }
  catch (e) {
    // Windows Node cannot fsync directory entries. Never advertise power-loss
    // durability on this path; the adapter remains an offline candidate.
    if (process.platform === 'win32' && ['EPERM', 'EACCES', 'EISDIR', 'EINVAL'].includes(e.code)) return 'FILE_SYNC_ONLY';
    throw e;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function validSnapshot(s) {
  try {
    if (!exactKeys(s, ['schemaVersion', 'revision', 'lastAt', 'model', 'target', 'lease', 'boundRun', 'nonces', 'feedbackAudit', 'digest']) ||
        s.schemaVersion !== 1 || !isRevision(s.revision) || !Array.isArray(s.nonces) ||
        s.nonces.length > 1000 || s.nonces.some(n => !identifier(n)) ||
        new Set(s.nonces).size !== s.nonces.length || !Array.isArray(s.feedbackAudit) ||
        s.feedbackAudit.length !== s.nonces.length) return false;
    for (const [index, e] of s.feedbackAudit.entries()) {
      if (!exactKeys(e, ['at', 'action', 'keyId', 'nonce', 'attemptId', 'target', 'run', 'payloadHash', 'previous']) ||
          !timestamp(e.at) || e.at > s.lastAt ||
          !['RUN_BOUND', 'SOURCE_RESULT', 'REVIEW_RELEASE'].includes(e.action) ||
          !identifier(e.keyId) || e.nonce !== s.nonces[index] || !identifier(e.attemptId) ||
          !validTarget(e.target) || !validRun(e.run) || typeof e.payloadHash !== 'string' || !/^[a-f0-9]{64}$/.test(e.payloadHash) ||
          e.previous !== (index ? hash(s.feedbackAudit[index - 1]) : null) ||
          (index > 0 && e.at < s.feedbackAudit[index - 1].at)) return false;
    }
    stateHash(s.model);
    if (!timestamp(s.lastAt) || s.lastAt < s.model.lastAt) return false;
    if (s.target === null) {
      if (s.lease !== null || s.boundRun !== null || s.model.attemptId !== null) return false;
    } else if (!validTarget(s.target) ||
        !exactKeys(s.lease, ['owner', 'expiresAt']) || !identifier(s.lease.owner) ||
        !timestamp(s.lease.expiresAt) || !identifier(s.model.attemptId) ||
        (s.boundRun !== null && !validRun(s.boundRun))) return false;
    const {digest, ...body} = s;
    return digest === hash(body);
  } catch { return false; }
}

function seal(snapshot) {
  const {digest: ignored, ...body} = snapshot;
  return {...body, digest: hash(body)};
}

/** Existing parent directories must be user-controlled and on one local volume.
 * This protects cooperating processes, accidental corruption and process death.
 * It is not a security boundary against a malicious local directory owner, NFS,
 * snapshot rollback, or a compromised feedback signer. */
export class LocalRelayStore {
  constructor(directory, {fault = () => {}} = {}) {
    this.directory = path.resolve(directory);
    this.fault = fault;
  }

  static create(directory, {now, reviewRef, fault} = {}) {
    const store = new LocalRelayStore(directory, {fault});
    // Explicit initialization only. Missing storage never silently bootstraps.
    const model = bootstrapSimulation({now, reviewRef});
    checkDirectory(path.dirname(store.directory));
    try { fs.mkdirSync(store.directory, {mode: 0o700}); }
    catch { reject('INITIALIZATION_REQUIRES_NEW_DIRECTORY'); }
    const lock = store.#acquire();
    try {
      const snapshot = seal({schemaVersion: 1, revision: 0, lastAt: now, model,
        target: null, lease: null, boundRun: null, nonces: [], feedbackAudit: []});
      store.#publish(snapshot, lock);
      store.#release(lock);
      return store;
    } catch { reject('INITIALIZATION_UNCERTAIN_REVIEW_REQUIRED'); }
  }

  #acquire() {
    checkDirectory(this.directory);
    const identity = fs.lstatSync(this.directory);
    const location = path.join(this.directory, 'writer.lock');
    try { fs.mkdirSync(location, {mode: 0o700}); }
    catch { reject('LOCKED_REVIEW_REQUIRED'); }
    const owner = randomUUID();
    // A crash at ANY point leaves the lock. No expiry, PID check or later caller
    // is permitted to delete an unknown owner's lock or clear pending state.
    const fd = fs.openSync(path.join(location, 'owner'), 'wx', 0o600);
    try { fs.writeFileSync(fd, owner); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    syncDirectory(location);
    syncDirectory(this.directory);
    this.fault('LOCK_PERSISTED');
    const lock = {owner, dev: identity.dev, ino: identity.ino};
    this.#assertLock(lock);
    return lock;
  }

  #assertLock(lock) {
    checkDirectory(this.directory);
    const current = fs.lstatSync(this.directory);
    if (current.dev !== lock.dev || current.ino !== lock.ino) reject('DIRECTORY_CHANGED_REVIEW_REQUIRED');
    const location = path.join(this.directory, 'writer.lock');
    checkDirectory(location);
    if (fs.readFileSync(path.join(location, 'owner'), 'utf8') !== lock.owner) reject('LOCK_OWNER_CHANGED');
  }

  #release(lock) {
    this.#assertLock(lock);
    this.fault('BEFORE_UNLOCK');
    this.#assertLock(lock);
    const location = path.join(this.directory, 'writer.lock');
    fs.unlinkSync(path.join(location, 'owner'));
    fs.rmdirSync(location);
    syncDirectory(this.directory);
  }

  #publish(snapshot, lock) {
    if (!validSnapshot(snapshot)) reject('STATE_INVALID');
    this.#assertLock(lock);
    // The legacy simulator hashes insertion-ordered JSON. Preserve that byte
    // ordering inside model; the outer snapshot digest is canonical separately.
    const bytes = Buffer.from(JSON.stringify(snapshot) + '\n');
    if (bytes.length > MAX_BYTES) reject('CAPACITY_REVIEW_REQUIRED');
    const temporary = path.join(this.directory, '.snapshot-' + randomUUID() + '.tmp');
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try {
      this.fault('TEMP_CREATED');
      this.#assertLock(lock);
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
      this.fault('TEMP_SYNCED');
    } finally { fs.closeSync(fd); }
    this.#assertLock(lock);
    fs.renameSync(temporary, path.join(this.directory, 'snapshot.json'));
    const durability = syncDirectory(this.directory);
    this.fault('SNAPSHOT_PUBLISHED');
    this.#assertLock(lock);
    return durability;
  }

  #loadUnlocked() {
    const snapshot = readRegular(path.join(this.directory, 'snapshot.json'));
    if (!validSnapshot(snapshot)) reject('STATE_MISSING_OR_INVALID');
    return snapshot;
  }

  read() {
    checkDirectory(this.directory);
    if (entryExists(path.join(this.directory, 'writer.lock'))) reject('LOCKED_REVIEW_REQUIRED');
    const snapshot = this.#loadUnlocked();
    if (entryExists(path.join(this.directory, 'writer.lock'))) reject('LOCKED_REVIEW_REQUIRED');
    return snapshot;
  }

  #mutate(expectedRevision, change) {
    const lock = this.#acquire();
    try {
      const previous = this.#loadUnlocked();
      if (!isRevision(expectedRevision) || expectedRevision !== previous.revision) {
        this.#release(lock);
        return deny('CAS_CONFLICT', previous);
      }
      const result = change(structuredClone(previous));
      if (!result.accepted) {
        this.#release(lock);
        return {...result, dispatch: false, snapshot: previous};
      }
      const snapshot = seal({...result.snapshot, revision: previous.revision + 1, lastAt: result.at});
      const durability = this.#publish(snapshot, lock);
      this.#release(lock);
      return {accepted: true, dispatch: false, reason: result.reason,
        snapshot, durability, productionReady: false};
    } catch (e) {
      // An exception/write failure retains lock and prior or complete new
      // snapshot. No cleanup path silently releases an uncertain reservation.
      if (/^RELAY_[A-Z_]+$/.test(e.message)) throw e;
      reject('STORAGE_UNCERTAIN_REVIEW_REQUIRED');
    }
  }

  reserve({expectedRevision, attemptId, slotMs, now, target, leaseOwner, leaseUntil} = {}) {
    return this.#mutate(expectedRevision, s => {
      if (!validTarget(target) || !identifier(leaseOwner) || !timestamp(now) ||
          now < s.lastAt || !timestamp(leaseUntil) || leaseUntil <= now) return deny('INVALID_RESERVATION');
      if (s.model.events.some(e => e.kind === 'SIMULATED_RESERVATION' && e.attemptId === attemptId)) return deny('ATTEMPT_ID_REUSED');
      const r = transition(s.model, {type: 'RESERVE', attemptId, slotMs, now});
      return r.accepted ? {accepted: true, at: now, reason: 'OFFLINE_RESERVATION_PERSISTED',
        snapshot: {...s, model: r.state, target: structuredClone(target),
          lease: {owner: leaseOwner, expiresAt: leaseUntil}, boundRun: null}} : deny(r.reason);
    });
  }

  recordTransport({expectedRevision, attemptId, now, leaseOwner, outcome} = {}) {
    return this.#mutate(expectedRevision, s => {
      if (!timestamp(now) || now < s.lastAt || !s.lease || leaseOwner !== s.lease.owner ||
          now >= s.lease.expiresAt || !['ACCEPTED', 'UNCERTAIN'].includes(outcome)) return deny('LEASE_INVALID_OR_EXPIRED');
      const r = transition(s.model, {type: outcome, attemptId, now});
      return r.accepted ? {accepted: true, at: now, reason: 'OFFLINE_TRANSPORT_' + outcome,
        snapshot: {...s, model: r.state}} : deny(r.reason);
    });
  }

  applyFeedback(envelope, {keys, now, maxLifetimeMs} = {}) {
    // Verify BEFORE acquiring the writer lock. Invalid untrusted messages do
    // not modify state or create persistent denial-of-service locks.
    const p = verifyFeedback(envelope, {keys, now, maxLifetimeMs});
    return this.#mutate(p.expectedRevision, s => {
      if (now < s.lastAt) return deny('REVERSED_TIME');
      if (s.nonces.includes(p.nonce)) return deny('FEEDBACK_REPLAY');
      if (s.nonces.length >= 1000) return deny('CAPACITY_REVIEW_REQUIRED');
      if (p.attemptId !== s.model.attemptId || canonical(p.target) !== canonical(s.target)) return deny('FEEDBACK_CORRELATION_MISMATCH');
      const audit = {at: now, action: p.action, keyId: p.keyId, nonce: p.nonce,
        attemptId: p.attemptId, target: p.target, run: p.run, payloadHash: hash(p),
        previous: s.feedbackAudit.length ? hash(s.feedbackAudit.at(-1)) : null};
      const traced = {...s, nonces: [...s.nonces, p.nonce], feedbackAudit: [...s.feedbackAudit, audit]};
      if (p.action === 'RUN_BOUND') {
        if (!['PENDING', 'REVIEW_REQUIRED'].includes(s.model.mode) || s.boundRun || now < s.model.lastAt) return deny('RUN_BINDING_CONFLICT');
        if (s.feedbackAudit.some(e => e.action === 'RUN_BOUND' && canonical(e.run) === canonical(p.run))) return deny('RUN_ALREADY_BOUND_TO_PRIOR_ATTEMPT');
        return {accepted: true, at: now, reason: 'AUTHENTICATED_OFFLINE_RUN_BOUND',
          snapshot: {...traced, boundRun: p.run}};
      }
      if (canonical(s.boundRun) !== canonical(p.run)) return deny('FEEDBACK_RUN_MISMATCH');
      const r = p.action === 'SOURCE_RESULT' ? transition(s.model, {
        type: 'SOURCE_RESULT', attemptId: p.attemptId, now,
        feedbackReviewed: true, runId: p.run.runId, outcome: p.outcome,
        evidenceRef: p.evidenceRef, reviewDelayMs: p.reviewDelayMs,
      }) : transition(s.model, {type: 'REVIEW_RELEASE', now,
        expectedStateHash: p.expectedStateHash, reviewRef: p.reviewRef});
      return r.accepted ? {accepted: true, at: now, reason: 'AUTHENTICATED_OFFLINE_' + p.action,
        snapshot: {...traced, model: r.state}} : deny(r.reason);
    });
  }
}
