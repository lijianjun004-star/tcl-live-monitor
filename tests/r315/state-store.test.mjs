import test from 'node:test';
import assert from 'node:assert/strict';
import { selectRestorableState } from '../../probes/r315/state-store.mjs';

const now = '2026-11-12T10:00:00.000Z';
const expected = { platform:'jd', repository:'owner/repo', defaultBranch:'main', workflow:'pilot.yml', schemaVersion:1 };
const candidate = () => ({
  run:{ repository:'owner/repo', headRepository:'owner/repo', branch:'main', workflow:'pilot.yml', status:'completed', conclusion:'success', id:'1', attempt:'1', createdAt:'2026-11-12T09:00:00.000Z', completedAt:'2026-11-12T09:05:00.000Z' },
  artifact:{ runId:'1', runAttempt:'1', uploadComplete:true, expired:false, createdAt:'2026-11-12T09:04:00.000Z', expiresAt:'2026-11-13T09:04:00.000Z' },
  state:{ runId:'1', runAttempt:'1', platform:'jd', schemaVersion:1, observedAt:'2026-11-12T09:03:00.000Z', sourceReadOk:true, schemaValidated:true, identityValidated:true, redactedStateReady:true },
});
const choose = (candidates, options = {}) => selectRestorableState({ candidates, completeListing:true, expected, now, maxAgeMs:3600000, trustedMaxAgeMs:3600000, ...options });

test('selects a complete matching candidate and rejects incomplete listing', () => {
  const c = candidate();
  assert.equal(choose([c]).status, 'CANDIDATE');
  assert.equal(choose([c], { completeListing:false }).status, 'UNKNOWN');
  assert.equal(choose([]).status, 'UNKNOWN');
});

test('rejects mismatched claimed metadata, run status, upload, platform and IDs', () => {
  const mutations = [
    c => c.run.repository='other/repo', c => c.run.headRepository='fork/repo', c => c.run.branch='feature',
    c => c.run.workflow='wrong.yml', c => c.run.status='in_progress', c => c.run.conclusion='failure',
    c => c.run.conclusion='cancelled', c => c.artifact.uploadComplete=false, c => c.artifact.expired=true,
    c => c.state.platform='douyin', c => c.state.schemaVersion=2, c => c.state.runId='2',
    c => c.artifact.runAttempt='2', c => c.state.identityValidated=false, c => delete c.state.sourceReadOk,
  ];
  for (const mutate of mutations) { const c = candidate(); mutate(c); assert.equal(choose([c]).status, 'UNKNOWN'); }
});

test('rejects expired, future, stale or out-of-order times', () => {
  const mutations = [ c => c.artifact.expiresAt=now, c => c.state.observedAt='2026-11-12T10:01:00.000Z',
    c => c.state.observedAt='2026-11-12T08:59:00.000Z', c => c.run.completedAt='2026-11-12T09:03:30.000Z',
    c => c.artifact.createdAt='invalid', c => c.artifact.createdAt='2026-99-99T99:99:99.000Z', c => c.run.completedAt='2026-11-12T10:01:00.000Z' ];
  for (const mutate of mutations) { const c = candidate(); mutate(c); assert.equal(choose([c]).status, 'UNKNOWN'); }
  assert.equal(choose([candidate()], { maxAgeMs:1000 }).status, 'UNKNOWN');
});

test('chooses latest qualifying claimed observation, rejects ambiguity at equal times', () => {
  const a = candidate(), b = candidate();
  b.run.id='2'; b.artifact.runId='2'; b.state.runId='2';
  assert.equal(choose([a,b]).status, 'UNKNOWN');
  b.state.observedAt='2026-11-12T09:04:00.000Z';
  assert.equal(choose([a,b]).reference.runId, '2');
});

test('requires a separately configured bounded trusted age limit', () => {
  for (const options of [
    { trustedMaxAgeMs:undefined }, { trustedMaxAgeMs:0 }, { trustedMaxAgeMs:Infinity },
    { trustedMaxAgeMs:Number.MAX_SAFE_INTEGER }, { trustedMaxAgeMs:86400001 },
    { trustedMaxAgeMs:3599999 }, { maxAgeMs:Number.MAX_SAFE_INTEGER },
  ]) assert.equal(choose([candidate()], options).status, 'UNKNOWN');
  assert.equal(choose([candidate()], { maxAgeMs:3600000, trustedMaxAgeMs:86400000 }).status, 'CANDIDATE');
});

test('returns only a non-authoritative minimal reference, never the source item', () => {
  const c = candidate();
  c.state.secret = 'private-room-or-session';
  c.artifact.extra = 'private-artifact-details';
  const result = choose([c]);
  assert.deepEqual(result, {
    status:'CANDIDATE',
    reference:{runId:'1', runAttempt:'1', observedAt:'2026-11-12T09:03:00.000Z'},
    independentVerificationRequired:true, usableForRestoreOrSkip:false,
  });
  assert.equal(JSON.stringify(result).includes('private'), false);
});
