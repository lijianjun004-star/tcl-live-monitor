import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { classifyTmall, pickBest } from '../probes/lib/tmall.mjs';
import { decideDouyin } from '../probes/lib/douyin.mjs';
import { classifyTclOps, liveMinutesDelta, trackSessionGap } from '../probes/lib/tcl-ops.mjs';
import { normalizeOpsCatalog, publicTargetsFromConfig, assembleRegistry, targetsToTagged } from '../probes/lib/ops-room-registry.mjs';
import { auditThreePlatformCoverage } from '../probes/lib/coverage-audit.mjs';
import { mergeLiveObservations } from '../probes/lib/merge-live-observations.mjs';

const readJson = rel => JSON.parse(fs.readFileSync(new URL(rel, import.meta.url), 'utf8'));

test('R096-BUG-01A: classifyTmall never coerces null, empty string, or boolean roomStatus/streamStatus into OFFLINE', () => {
  const target = { accountId: '1015493951', displayName: 'TCL照明官方旗舰', roomNumber: '128789' };
  for (const bad of [null, '', false, '   ', undefined, NaN]) {
    const res = classifyTmall({
      ret: ['SUCCESS::调用成功'],
      data: {
        roomNum: '128789',
        roomStatus: bad,
        streamStatus: bad,
        liveId: '0',
        broadCaster: { accountId: '1015493951', accountName: 'TCL照明官方旗舰', roomNum: '128789' }
      }
    }, target);
    assert.equal(res.state, 'UNKNOWN', `bad status ${String(bad)} must be UNKNOWN, not OFFLINE`);
    assert.equal(res.reason, 'UNRECOGNIZED_STATUS');
  }
});

test('R096-BUG-01B: pickBest fails closed to CONFLICTING_LIVE_DETAIL_RESPONSES when one page load emits both LIVE and OFFLINE', () => {
  const res = pickBest([
    { state: 'LIVE', reason: null },
    { state: 'OFFLINE', reason: null, offlineEvidence: true }
  ]);
  assert.equal(res.state, 'UNKNOWN');
  assert.equal(res.reason, 'CONFLICTING_LIVE_DETAIL_RESPONSES');
});

test('R096-BUG-01C: decideDouyin refuses OFFLINE when room page identity is not verified even if status=4 and endedText exist', () => {
  const target = { accountName: 'TCL官方旗舰店', displayDouyinId: '79013748820', roomId: '31878890513' };
  const profile = { httpStatus: 200, title: 'TCL官方旗舰店的抖音 - 抖音', bodyExcerpt: '抖音号：79013748820', douyinIdsInPage: ['79013748820'], liveRoomAnchors: [] };
  const wrongRoom = { httpStatus: 200, title: '别的直播间 - 抖音直播', bodyExcerpt: '直播已结束', metaDescription: '欢迎来到别的直播间', statusFields: [{ field: 'data.room.status', value: 4 }] };
  const d = decideDouyin(profile, wrongRoom, target, { offlineRuleValidated: true });
  assert.equal(d.state, 'UNKNOWN');
  assert.notEqual(d.state, 'OFFLINE');
});

test('R096-BUG-02: unified ops-room-registry and coverage-audit import all 9 verified Tmall targets (1 userConfirmed + 8 scopeApproved) and reject refuted IDs', () => {
  const cfg = readJson('../config/probe-targets.json');
  const catalogRaw = readJson('../fixtures/ops-catalog-safe-20261105.json');
  const opsCatalog = normalizeOpsCatalog(catalogRaw.roomsResponse, catalogRaw.shopsResponse);
  const registry = assembleRegistry({ opsCatalog, configuredTargets: targetsToTagged(cfg), asOf: '2026-11-06T00:00:00.000Z' });
  const audit = auditThreePlatformCoverage({ registry, publicConfig: cfg, asOf: '2026-11-06T00:00:00.000Z' });

  assert.equal(audit.counts.tmall.publicAccounts, 9);
  assert.equal(audit.counts.douyin.publicAccounts, 12);
  assert.equal(audit.counts.jd.opsRecords, 6);
  assert.equal(audit.counts.douyin.opsRecords, 10);
  assert.equal(audit.totalEvidenceRows, 37);

  // Only tcl-group (2050532947) has userConfirmed=true & scoringEligible=true among Tmall targets
  const tmallTargets = registry.entries.filter(x => x.platform === 'tmall' && x.source === 'public-probe-existing');
  assert.equal(tmallTargets.length, 9);
  assert.deepEqual(tmallTargets.filter(x => x.scoringEligible).map(x => x.platformAccountId), ['2050532947']);

  // Refuted Tmall IDs must be rejected if someone tries to inject them into config
  const poisoned = structuredClone(cfg);
  poisoned.tmall.push({ key: 'bad-suning', displayName: 'TCL电视官方旗舰店', accountId: '2616970884', roomNumber: '58638', scopeApproved: true });
  assert.throws(() => publicTargetsFromConfig(poisoned), /REFUTED_TMALL_ACCOUNT:2616970884/);
});

test('R096-BUG-05A: trackSessionGap detects GAP_OPENED and SESSION_BREAK_DURING_UNKNOWN across transient plain UNKNOWN polls', () => {
  const d = '2026-11-06';
  // Scenario 1: LIVE (s=1) -> plain UNKNOWN (API_ERROR) -> OFFLINE_CANDIDATE -> LIVE (s=2)
  let s = trackSessionGap(null, { date: d, state: 'LIVE', offlineCandidate: false, sessionCount: 1, at: 1000 }).next;
  let r2 = trackSessionGap(s, { date: d, state: 'UNKNOWN', offlineCandidate: false, sessionCount: null, at: 2000 });
  assert.equal(r2.event, null);
  let r3 = trackSessionGap(r2.next, { date: d, state: 'UNKNOWN', offlineCandidate: true, sessionCount: 1, at: 3000 });
  assert.equal(r3.event, 'GAP_OPENED', 'must open gap even if preceded by 1 plain UNKNOWN poll');
  let r4 = trackSessionGap(r3.next, { date: d, state: 'LIVE', offlineCandidate: false, sessionCount: 2, at: 4000 });
  assert.equal(r4.event, 'GAP_CLOSED_NEW_SESSION');

  // Scenario 2: LIVE (s=1) -> plain UNKNOWN (API_ERROR) -> LIVE (s=2) without offlineCandidate
  let p1 = trackSessionGap(null, { date: d, state: 'LIVE', offlineCandidate: false, sessionCount: 1, at: 1000 }).next;
  let p2 = trackSessionGap(p1, { date: d, state: 'UNKNOWN', offlineCandidate: false, sessionCount: null, at: 2000 }).next;
  let p3 = trackSessionGap(p2, { date: d, state: 'LIVE', offlineCandidate: false, sessionCount: 2, at: 3000 });
  assert.equal(p3.event, 'SESSION_BREAK_DURING_UNKNOWN');
});

test('R096-BUG-05B: trackSessionGap flags sessionCount regression (s1 < s0) as GAP_CLOSED_SESSION_REGRESSED instead of GAP_CLOSED_SAME_SESSION', () => {
  const d = '2026-11-06';
  let s1 = trackSessionGap(null, { date: d, state: 'LIVE', offlineCandidate: false, sessionCount: 3, at: 1000 }).next;
  let s2 = trackSessionGap(s1, { date: d, state: 'UNKNOWN', offlineCandidate: true, sessionCount: 3, at: 2000 }).next;
  let s3 = trackSessionGap(s2, { date: d, state: 'LIVE', offlineCandidate: false, sessionCount: 2, at: 3000 });
  assert.equal(s3.event, 'GAP_CLOSED_SESSION_REGRESSED');
});
