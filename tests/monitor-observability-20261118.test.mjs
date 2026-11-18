import test from 'node:test';
import assert from 'node:assert/strict';
import * as douyin from '../probes/lib/douyin.mjs';
import {buildDailyBroadcast, importReceipt} from '../probes/r322/observation-ledger.mjs';

test('a successful HTTP response can render either no text or text with no identity field', () => {
  const classify = douyin.profileRenderSignals;
  const empty = {httpStatus: 200, title: '', bodyExcerpt: ' ', douyinIdsInPage: []};
  const noIdentity = {...empty, bodyExcerpt: 'SYNTHETIC_VISIBLE_TEXT'};
  const visibleId = {...noIdentity, douyinIdsInPage: ['SYNTHETIC_DO_NOT_EMIT']};
  assert.deepEqual(classify(empty), {visibleBodyTextPresent: false, visibleDouyinIdPresent: false});
  assert.deepEqual(classify(noIdentity), {visibleBodyTextPresent: true, visibleDouyinIdPresent: false});
  assert.deepEqual(classify(visibleId), {visibleBodyTextPresent: true, visibleDouyinIdPresent: true});
  assert.doesNotMatch(JSON.stringify(classify(visibleId)), /SYNTHETIC/);
  const target = {accountName:'FIXTURE', displayDouyinId:'different-id', profileUrl:'https://www.douyin.com/user/SYNTHETIC'};
  assert.equal(douyin.decideDouyin(visibleId, null, target, {strictRoomOwner:true}).state, 'UNKNOWN');
});

test('a Tmall stop keeps the other shops represented without reporting they were attempted', () => {
  const at = '2026-11-18T08:04:09.000Z';
  const attempted = '2026-11-18T08:04:06.000Z';
  const checked = [
    {key: 'synthetic-a', at: attempted, state: 'UNKNOWN', reason: 'STOPPED_API_ACCESS_LIMIT'},
    ...Array.from({length:8}, (_,i) => ({
      key: 'synthetic-skipped-'+i, at, state: 'NOT_RUN', reason: 'STOPPED_AFTER_ACCESS_LIMIT',
    })),
  ];
  const beforeStop = {key: checked[0].key, at:'2026-11-18T07:00:00.000Z', state:'UNKNOWN',
    reason:'NO_LIVE_DETAIL_RESPONSE'};
  const seeded = importReceipt(null, {schemaVersion:319, platform:'tmall', at:beforeStop.at, checked:[beforeStop]},
    {platform:'tmall', evidenceKind:'synthetic'});
  const ledger = importReceipt(seeded, {schemaVersion:319, platform:'tmall', at, checked},
    {platform:'tmall', evidenceKind:'synthetic'});
  const rows = buildDailyBroadcast(ledger);
  assert.equal(rows.length, 9);
  for (const r of rows) {
    const wasAttempted = r.key === checked[0].key;
    assert.equal(r.status, 'UNKNOWN');
    assert.equal(r.samples, wasAttempted ? 2 : 1);
    assert.equal(r.attemptedSamples, wasAttempted ? 2 : 0);
    assert.equal(r.notRunSamples, wasAttempted ? 0 : 1);
    assert.equal(r.lastAttemptedSampleAt, wasAttempted ? attempted : null);
    assert.equal(r.verifiedSamples, 0);
    assert.equal(r.lastVerifiedSampleAt, null);
  }
});

test('a stored NOT_RUN cannot supply positive broadcast evidence', () => {
  const at = '2026-11-18T08:04:09.000Z';
  const ledger = importReceipt(null, {schemaVersion:319, at, checked:[{
    key:'synthetic-skipped', at, state:'NOT_RUN', reason:'STOPPED_AFTER_ACCESS_LIMIT',
    profileIdentityVerified:true,
  }]}, {platform:'douyin', evidenceKind:'synthetic'});
  ledger.observations[0].ownRoomLiveBadge = true;
  assert.throws(() => buildDailyBroadcast(ledger), /LEDGER_INPUT_INVALID/);
});
