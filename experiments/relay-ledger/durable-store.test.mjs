import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createHmac} from 'node:crypto';
import {LocalRelayStore} from './durable-store.mjs';
import {canonical, TARGET, verifyFeedback} from './feedback.mjs';
import {stateHash} from './model.mjs';

const testRoot = path.join(os.tmpdir(), 'tcl-relay-ledger-tests');
fs.mkdirSync(testRoot, {recursive: true});
const target = {...TARGET, headSha: 'a'.repeat(40)};
// Public synthetic constants, intentionally unrelated to any real credential.
const keys = {
  'synthetic-feedback': {secret: Buffer.alloc(32, 42), actions: ['RUN_BOUND', 'SOURCE_RESULT']},
  'synthetic-review': {secret: Buffer.alloc(32, 24), actions: ['REVIEW_RELEASE']},
};
function fresh(t) {
  const parent = fs.mkdtempSync(path.join(testRoot, 'case-'));
  t.after(() => fs.rmSync(parent, {recursive: true, force: true}));
  const directory = path.join(parent, 'ledger');
  return {parent, directory, store: LocalRelayStore.create(directory, {now: 1000, reviewRef: 'synthetic-review'})};
}
const reserve = (store, overrides = {}) => store.reserve({expectedRevision: 0,
  attemptId: 'attempt-1', now: 1001, slotMs: 1001, target,
  leaseOwner: 'worker-1', leaseUntil: 2000, ...overrides});
function envelope(store, action, overrides = {}) {
  const s = store.read();
  const payload = {schemaVersion: 1,
    keyId: action === 'REVIEW_RELEASE' ? 'synthetic-review' : 'synthetic-feedback',
    nonce: 'nonce-' + s.revision, issuedAt: 1002, expiresAt: 2000,
    expectedRevision: s.revision, action, attemptId: 'attempt-1', target,
    run: {runId: '123456', runAttempt: 1},
    ...(action === 'SOURCE_RESULT' ? {outcome: 'SUCCESS', evidenceRef: 'fixture-proof', reviewDelayMs: null} : {}),
    ...(action === 'REVIEW_RELEASE' ? {reviewRef: 'fixture-review', expectedStateHash: stateHash(s.model)} : {}),
    ...overrides};
  return sign(payload);
}
function sign(payload) {
  return {payload, signature: createHmac('sha256', keys[payload.keyId].secret)
    .update('tcl-relay-feedback-v1\n' + canonical(payload)).digest('hex')};
}
const apply = (store, action, overrides = {}, now = 1003) =>
  store.applyFeedback(envelope(store, action, overrides), {keys, now});
function worker(directory, mode, value) {
  const proc = spawn(process.execPath, [fileURLToPath(new URL('./store-worker.mjs', import.meta.url)), directory, mode, value],
    {stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true});
  let output = '', errors = '';
  const ready = new Promise((resolve, reject) => {
    proc.stdout.on('data', b => {output += b; if (output.includes('READY\n')) resolve();});
    proc.on('error', reject);
  });
  proc.stderr.on('data', b => {errors += b;});
  const finished = new Promise((resolve, reject) => {
    proc.on('error', reject);
    proc.on('exit', code => resolve({code, output, errors}));
  });
  return {ready, finished, go: () => proc.stdin.end('GO\n')};
}

test('durable CAS rejects the second READY copy and survives fresh instances', t => {
  const {store, directory} = fresh(t);
  const old = store.read();
  const a = reserve(store, {attemptId: 'attempt-a', expectedRevision: old.revision});
  const b = reserve(new LocalRelayStore(directory), {attemptId: 'attempt-b', expectedRevision: old.revision});
  assert.equal([a, b].filter(r => r.accepted).length, 1);
  assert.equal(b.reason, 'CAS_CONFLICT');
  assert.equal(new LocalRelayStore(directory).read().model.mode, 'PENDING');
  assert.equal(a.dispatch, false);
  assert.equal(a.productionReady, false);
  assert.equal(a.durability, process.platform === 'win32' ? 'FILE_SYNC_ONLY' : 'FILE_AND_DIRECTORY_SYNC');
});

test('two real child processes race for a single reservation', async t => {
  const {directory, store} = fresh(t);
  const a = worker(directory, 'race', 'a'), b = worker(directory, 'race', 'b');
  await Promise.all([a.ready, b.ready]);
  a.go(); b.go();
  const results = await Promise.all([a.finished, b.finished]);
  for (const r of results) {assert.equal(r.code, 0, r.errors); assert.equal(r.errors, '');}
  const replies = results.map(r => JSON.parse(r.output.trim().split('\n').at(-1)));
  assert.equal(replies.filter(r => r.accepted).length, 1);
  assert.ok(replies.every(r => r.dispatch === false));
  assert.equal(store.read().revision, 1);
  assert.equal(store.read().model.mode, 'PENDING');
});

test('transport acceptance, timeout and expired lease never grant a second attempt', t => {
  const {store, directory} = fresh(t);
  reserve(store);
  assert.equal(store.recordTransport({expectedRevision: 1, attemptId: 'attempt-1', now: 1002,
    leaseOwner: 'wrong', outcome: 'ACCEPTED'}).accepted, false);
  const accepted = store.recordTransport({expectedRevision: 1, attemptId: 'attempt-1', now: 1002,
    leaseOwner: 'worker-1', outcome: 'ACCEPTED'});
  assert.equal(accepted.snapshot.model.mode, 'PENDING');
  const uncertain = store.recordTransport({expectedRevision: 2, attemptId: 'attempt-1', now: 1003,
    leaseOwner: 'worker-1', outcome: 'UNCERTAIN'});
  assert.equal(uncertain.snapshot.model.mode, 'REVIEW_REQUIRED');
  const reopened = new LocalRelayStore(directory);
  assert.equal(reserve(reopened, {expectedRevision: 3, attemptId: 'attempt-2', now: 9000, slotMs: 9000, leaseUntil: 10000}).accepted, false);
  assert.equal(reopened.recordTransport({expectedRevision: 3, attemptId: 'attempt-1', now: 9000,
    leaseOwner: 'worker-1', outcome: 'ACCEPTED'}).reason, 'LEASE_INVALID_OR_EXPIRED');
  assert.equal(reopened.read().model.mode, 'REVIEW_REQUIRED');
});

test('missing or corrupt storage never bootstraps and uncertainty stays locked', t => {
  const {store, directory, parent} = fresh(t);
  const before = fs.readFileSync(path.join(directory, 'snapshot.json'));
  assert.throws(() => LocalRelayStore.create(directory, {now: 1001, reviewRef: 'another'}), /INITIALIZATION_REQUIRES_NEW_DIRECTORY/);
  assert.deepEqual(fs.readFileSync(path.join(directory, 'snapshot.json')), before);
  assert.throws(() => new LocalRelayStore(path.join(parent, 'missing')).read());
  fs.writeFileSync(path.join(directory, 'snapshot.json'), '{PRIVATE_MARKER_BROKEN');
  assert.throws(() => store.read(), {message: 'RELAY_STATE_MISSING_OR_INVALID'});
  assert.throws(() => reserve(store), {message: 'RELAY_STATE_MISSING_OR_INVALID'});
  assert.throws(() => store.read(), {message: 'RELAY_LOCKED_REVIEW_REQUIRED'});
});

test('crashes at every publication stage keep old or whole new state and block recovery', async t => {
  for (const stage of ['LOCK_PERSISTED', 'TEMP_CREATED', 'TEMP_SYNCED', 'SNAPSHOT_PUBLISHED', 'BEFORE_UNLOCK']) {
    const {directory, store} = fresh(t);
    const child = worker(directory, 'crash', stage);
    await child.ready; child.go();
    const result = await child.finished;
    assert.equal(result.code, 73, result.errors);
    const raw = JSON.parse(fs.readFileSync(path.join(directory, 'snapshot.json'), 'utf8'));
    assert.ok([0, 1].includes(raw.revision));
    assert.equal(raw.model.mode, raw.revision === 0 ? 'READY' : 'PENDING');
    assert.throws(() => store.read(), /LOCKED_REVIEW_REQUIRED/);
    assert.throws(() => reserve(new LocalRelayStore(directory), {now: 999999, slotMs: 999999, leaseUntil: 1000000}), /LOCKED_REVIEW_REQUIRED/);
  }
});

test('write failure redacts the cause and never removes the durable lock', t => {
  const {directory} = fresh(t);
  const faulty = new LocalRelayStore(directory, {fault: stage => {
    if (stage === 'TEMP_SYNCED') throw Error('PRIVATE_TOKEN_AND_PATH');
  }});
  assert.throws(() => reserve(faulty), {message: 'RELAY_STORAGE_UNCERTAIN_REVIEW_REQUIRED'});
  assert.throws(() => new LocalRelayStore(directory).read(), /LOCKED_REVIEW_REQUIRED/);
});

test('authenticated state and replay data publish together or leave a persistent lock', t => {
  const {store, directory} = fresh(t);
  reserve(store); apply(store, 'RUN_BOUND');
  const message = envelope(store, 'SOURCE_RESULT');
  const faulty = new LocalRelayStore(directory, {fault: stage => {
    if (stage === 'SNAPSHOT_PUBLISHED') throw Error('PRIVATE_STORAGE_ERROR');
  }});
  assert.throws(() => faulty.applyFeedback(message, {keys, now: 1004}), /STORAGE_UNCERTAIN_REVIEW_REQUIRED/);
  const raw = JSON.parse(fs.readFileSync(path.join(directory, 'snapshot.json'), 'utf8'));
  assert.equal(raw.model.mode, 'READY');
  assert.ok(raw.nonces.includes(message.payload.nonce));
  assert.equal(raw.feedbackAudit.at(-1).run.runId, message.payload.run.runId);
  assert.throws(() => store.read(), /LOCKED_REVIEW_REQUIRED/);
  assert.throws(() => reserve(store, {expectedRevision: 3, now: 1005, slotMs: 1005}), /LOCKED_REVIEW_REQUIRED/);
});

test('abandoned or corrupt locks cannot be stolen based on PID or age', t => {
  const {store, directory} = fresh(t);
  fs.mkdirSync(path.join(directory, 'writer.lock'));
  fs.writeFileSync(path.join(directory, 'writer.lock', 'owner'), 'dead-process-stale');
  assert.throws(() => store.read(), /LOCKED_REVIEW_REQUIRED/);
  assert.throws(() => reserve(store, {now: 999999, slotMs: 999999, leaseUntil: 1000000}), /LOCKED_REVIEW_REQUIRED/);
});

test('directory replacement after locking is detected before snapshot publication', t => {
  const {directory, parent} = fresh(t);
  const displaced = path.join(parent, 'displaced-ledger');
  const store = new LocalRelayStore(directory, {fault: stage => {
    if (stage === 'LOCK_PERSISTED') {
      fs.renameSync(directory, displaced);
      fs.mkdirSync(directory);
      fs.writeFileSync(path.join(directory, 'sentinel'), 'unchanged');
    }
  }});
  assert.throws(() => reserve(store), /DIRECTORY_CHANGED_REVIEW_REQUIRED/);
  assert.equal(fs.readFileSync(path.join(directory, 'sentinel'), 'utf8'), 'unchanged');
  assert.equal(fs.existsSync(path.join(directory, 'snapshot.json')), false);
  assert.ok(fs.existsSync(path.join(displaced, 'writer.lock')));
  assert.throws(() => new LocalRelayStore(directory).read(), /STATE_MISSING_OR_INVALID/);
});

test('symlinked root or snapshot cannot redirect the state writer', t => {
  const {directory, parent, store} = fresh(t);
  const alias = path.join(parent, 'alias');
  try { fs.symlinkSync(directory, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (e) { if (['EPERM', 'EACCES'].includes(e.code)) return t.skip('OS refused synthetic symlink creation'); throw e; }
  assert.throws(() => new LocalRelayStore(alias).read(), /UNTRUSTED_DIRECTORY/);
  const snapshot = path.join(directory, 'snapshot.json'), separate = path.join(parent, 'separate.json');
  fs.renameSync(snapshot, separate);
  try {fs.symlinkSync(separate, snapshot);} catch (e) {
    if (['EPERM', 'EACCES'].includes(e.code)) return t.skip('OS refused synthetic file symlink creation'); throw e;
  }
  assert.throws(() => store.read(), /STATE_MISSING_OR_INVALID/);
});

test('unauthenticated reviewed boolean cannot release pending or alter storage', t => {
  const {store, directory} = fresh(t);
  reserve(store);
  const before = fs.readFileSync(path.join(directory, 'snapshot.json'));
  const attempt = {type: 'SOURCE_RESULT', attemptId: 'attempt-1', now: 1002,
    outcome: 'SUCCESS', feedbackReviewed: true, runId: 'run-1', evidenceRef: 'proof-1'};
  assert.throws(() => store.applyFeedback(attempt, {keys, now: 1002}), /FEEDBACK_UNAUTHENTICATED/);
  assert.deepEqual(fs.readFileSync(path.join(directory, 'snapshot.json')), before);
  assert.equal(store.read().model.mode, 'PENDING');
});

test('signature, key scope, freshness and payload tampering are rejected without writes', t => {
  const {store} = fresh(t); reserve(store);
  const valid = envelope(store, 'RUN_BOUND');
  const invalid = [
    {...valid, signature: '0'.repeat(64)},
    {...valid, payload: {...valid.payload, target: {...target, headSha: 'b'.repeat(40)}}},
    sign({...valid.payload, expiresAt: 1002}),
    sign({...valid.payload, issuedAt: 1004}),
    sign({...valid.payload, unexpected: 'PRIVATE_MARKER'}),
    envelope(store, 'REVIEW_RELEASE', {keyId: 'synthetic-feedback'}),
    {...valid, payload: {...valid.payload, keyId: '__proto__'}},
  ];
  for (const msg of invalid) assert.throws(() => store.applyFeedback(msg, {keys, now: 1003}), /FEEDBACK_UNAUTHENTICATED/);
  assert.throws(() => verifyFeedback(valid, {keys: {}, now: 1003}), /FEEDBACK_UNAUTHENTICATED/);
  assert.equal(store.read().revision, 1);
});

test('source feedback requires authenticated exact repository, workflow, ref, SHA, run and attempt', t => {
  const {store} = fresh(t); reserve(store);
  assert.equal(apply(store, 'SOURCE_RESULT').reason, 'FEEDBACK_RUN_MISMATCH');
  for (const targetChange of [{repository: 'other/repo'}, {workflow: 'other.yml'}, {ref: 'dev'}]) {
    assert.throws(() => apply(store, 'RUN_BOUND', {target: {...target, ...targetChange}}), /FEEDBACK_UNAUTHENTICATED/);
  }
  assert.equal(apply(store, 'RUN_BOUND', {target: {...target, headSha: 'b'.repeat(40)}}).reason, 'FEEDBACK_CORRELATION_MISMATCH');
  assert.equal(apply(store, 'RUN_BOUND', {attemptId: 'attempt-wrong'}).reason, 'FEEDBACK_CORRELATION_MISMATCH');
  assert.equal(apply(store, 'RUN_BOUND').accepted, true);
  assert.equal(apply(store, 'RUN_BOUND').reason, 'RUN_BINDING_CONFLICT');
  for (const run of [{runId: '123457', runAttempt: 1}, {runId: '123456', runAttempt: 2}]) {
    assert.equal(apply(store, 'SOURCE_RESULT', {run}).reason, 'FEEDBACK_RUN_MISMATCH');
  }
  assert.equal(apply(store, 'SOURCE_RESULT').snapshot.model.mode, 'READY');
  assert.equal(store.read().boundRun.runId, '123456');
});

test('authenticated nonce replay and stale revision are persisted across instances', t => {
  const {store, directory} = fresh(t); reserve(store);
  const binding = envelope(store, 'RUN_BOUND');
  assert.equal(store.applyFeedback(binding, {keys, now: 1003}).accepted, true);
  const next = new LocalRelayStore(directory);
  assert.equal(next.applyFeedback(binding, {keys, now: 1003}).reason, 'CAS_CONFLICT');
  assert.equal(apply(next, 'SOURCE_RESULT', {nonce: binding.payload.nonce}).reason, 'FEEDBACK_REPLAY');
  assert.equal(next.read().model.mode, 'PENDING');
});

test('attempt and run identities cannot be recycled across later opportunities', t => {
  const {store} = fresh(t);
  reserve(store); apply(store, 'RUN_BOUND'); apply(store, 'SOURCE_RESULT');
  assert.equal(reserve(store, {expectedRevision: 3, attemptId: 'attempt-2', now: 1010, slotMs: 1010}).accepted, true);
  assert.equal(apply(store, 'RUN_BOUND', {attemptId: 'attempt-2'}, 1011).reason, 'RUN_ALREADY_BOUND_TO_PRIOR_ATTEMPT');
  const run = {runId: '123457', runAttempt: 1};
  assert.equal(apply(store, 'RUN_BOUND', {attemptId: 'attempt-2', run}, 1011).accepted, true);
  assert.equal(apply(store, 'SOURCE_RESULT', {attemptId: 'attempt-2', run}, 1012).accepted, true);
  assert.equal(reserve(store, {expectedRevision: 6, attemptId: 'attempt-1', now: 1020, slotMs: 1020}).reason, 'ATTEMPT_ID_REUSED');
});

test('failure backoff requires separately authorized digest-bound review after expiry', t => {
  const {store, directory} = fresh(t); reserve(store); apply(store, 'RUN_BOUND');
  const failed = apply(store, 'SOURCE_RESULT', {outcome: 'FAILURE', reviewDelayMs: 100}, 1004);
  assert.equal(failed.snapshot.model.mode, 'SOURCE_BACKOFF');
  const reopened = new LocalRelayStore(directory);
  assert.equal(reserve(reopened, {expectedRevision: 3, attemptId: 'attempt-2', now: 1105, slotMs: 1105}).accepted, false);
  assert.equal(apply(reopened, 'REVIEW_RELEASE', {}, 1103).accepted, false);
  assert.equal(apply(reopened, 'REVIEW_RELEASE', {expectedStateHash: 'a'.repeat(64)}, 1105).accepted, false);
  assert.equal(apply(reopened, 'REVIEW_RELEASE', {}, 1105).snapshot.model.mode, 'READY');
  assert.equal(reserve(reopened, {expectedRevision: 4, attemptId: 'attempt-2', now: 1106, slotMs: 1106}).accepted, true);
  assert.equal(reopened.read().boundRun, null);
  assert.equal(reopened.read().feedbackAudit.length, 3);
  assert.equal(reopened.read().feedbackAudit[0].target.headSha, target.headSha);
  assert.equal(reopened.read().feedbackAudit[0].run.runAttempt, 1);
});

test('run binding and all later events enforce monotonic time', t => {
  const {store} = fresh(t); reserve(store);
  apply(store, 'RUN_BOUND', {}, 1100);
  assert.equal(apply(store, 'SOURCE_RESULT', {}, 1099).reason, 'REVERSED_TIME');
  assert.equal(store.recordTransport({expectedRevision: 2, attemptId: 'attempt-1', now: 1099,
    leaseOwner: 'worker-1', outcome: 'ACCEPTED'}).accepted, false);
});
