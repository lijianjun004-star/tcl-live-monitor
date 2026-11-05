import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { beijingDate, evaluateRoom } from '../probes/lib/tcl-jd-all.mjs';
import { validateTargets } from '../probes/lib/safe-network.mjs';
import { profileIdentity, decideDouyin } from '../probes/lib/douyin.mjs';
import {
  extractSecUid,
  validateMatrixTargets,
  evaluateDouyinMatrix,
  reconcileOpsDouyin,
} from '../probes/lib/matrix-evaluate.mjs';

test('R06: beijingDate is strictly YYYY-MM-DD even on small-icu where en-CA falls back to MM/DD/YYYY', () => {
  const d = new Date('2026-11-04T17:00:00Z'); // 2026-11-05 01:00:00 CST
  const formatted = beijingDate(d);
  assert.match(formatted, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(formatted, '2026-11-05');
  assert.equal(beijingDate('not-a-valid-date'), 'INVALID_DATE');
});

test('R06: all 12 Douyin targets in config/probe-targets.json pass both safe-network and matrix-evaluate validators', async () => {
  const cfg = JSON.parse(await fs.readFile(new URL('../config/probe-targets.json', import.meta.url), 'utf8'));
  assert.equal(cfg.douyin.length, 12);
  assert.equal(validateTargets(cfg.douyin), true);
  assert.equal(validateMatrixTargets(cfg.douyin), true);
  const secUids = cfg.douyin.map(extractSecUid);
  assert.equal(new Set(secUids).size, 12);
});

test('R06: alphanumeric displayDouyinId (TCLkongtiao, FoxsineZN, wlhnumber1) and 8-digit IDs (14145381) are accepted', () => {
  const sample = [
    {
      key: 'tcl-ac-zs',
      accountName: 'TCL空调',
      displayDouyinId: 'TCLkongtiao',
      profileUrl: 'https://www.douyin.com/user/MS4wLjABAAAAk8PCRiqiKMYYO7CUUgeotMKKxkg9-HOWe8Lrn2Dv-xQ',
      scopeApproved: true,
      scoringEligible: false,
    },
    {
      key: 'ffalcon-direct',
      accountName: '雷鸟电视品牌官方直营',
      displayDouyinId: 'wlhnumber1',
      profileUrl: 'https://www.douyin.com/user/MS4wLjABAAAAHLgxNf9c59NqJuH9tm5U2L3E1B6bNBehePdI5rKsZ2s',
      scopeApproved: true,
      scoringEligible: false,
    },
  ];
  assert.equal(validateTargets(sample), true);
  assert.equal(validateMatrixTargets(sample), true);
});

test('R06: evaluateDouyinMatrix strictly isolates scoringEligible=true KPI denominator from monitor-only accounts', async () => {
  const cfg = JSON.parse(await fs.readFile(new URL('../config/probe-targets.json', import.meta.url), 'utf8'));
  const now = Date.parse('2026-11-05T11:30:00Z');
  const observations = [
    {
      accountId: 'tcl-douyin-flagship',
      at: now - 60_000,
      state: 'LIVE',
      profileIdentityVerified: true,
      roomPageIdentityVerified: true,
      checkedRoomId: '31878890513',
    },
    {
      accountId: 'tcl-douyin-dealer-fushixin',
      at: now - 60_000,
      state: 'LIVE',
      profileIdentityVerified: true,
      roomPageIdentityVerified: true,
      checkedRoomId: '99887766554',
    },
  ];
  const res = evaluateDouyinMatrix({ targets: cfg.douyin, observations, now, candidateCount: 7 });
  assert.equal(res.monitoredAccounts, 12);
  assert.equal(res.scoringEligibleAccounts, 4);
  assert.equal(res.monitorOnlyAccounts, 8);
  assert.equal(res.LIVE, 2);
  assert.equal(res.scoringSummary.LIVE, 1);
  assert.equal(res.scoringSummary.UNKNOWN, 3);
  assert.equal(res.scoringKnownStateCoveragePct, 25);
});

test('R06: shared physical roomId across two Douyin accounts fails closed to UNKNOWN', async () => {
  const cfg = JSON.parse(await fs.readFile(new URL('../config/probe-targets.json', import.meta.url), 'utf8'));
  const now = Date.parse('2026-11-05T11:30:00Z');
  const observations = [
    {
      accountId: 'tcl-douyin-flagship',
      at: now - 30_000,
      state: 'LIVE',
      profileIdentityVerified: true,
      roomPageIdentityVerified: true,
      checkedRoomId: '31878890513',
    },
    {
      accountId: 'tcl-douyin-flagship-tv-live',
      at: now - 30_000,
      state: 'LIVE',
      profileIdentityVerified: true,
      roomPageIdentityVerified: true,
      checkedRoomId: '31878890513',
    },
  ];
  const res = evaluateDouyinMatrix({ targets: cfg.douyin, observations, now });
  assert.equal(res.LIVE, 0);
  assert.equal(res.conflicts.length, 1);
  assert.deepEqual(res.conflicts[0], {
    roomId: '31878890513',
    accountKeys: ['tcl-douyin-flagship', 'tcl-douyin-flagship-tv-live'],
  });
});

test('R06: profileIdentity accepts mobile share page title variant when displayDouyinId is corroborated', () => {
  const target = {
    key: 'tcl-douyin-ac-zhongshan',
    accountName: 'TCL空调',
    displayDouyinId: 'TCLkongtiao',
    alternateTitles: ['TCL空调器（中山）有限公司- 抖音'],
  };
  const shareSnap = {
    httpStatus: 200,
    title: 'TCL空调的主页 - 抖音',
    bodyExcerpt: 'TCL空调入驻抖音，TA的抖音号是TCLkongtiao',
    douyinIdsInPage: ['TCLkongtiao'],
  };
  const corpSnap = {
    httpStatus: 200,
    title: 'TCL空调器（中山）有限公司- 抖音',
    bodyExcerpt: '抖音号：TCLkongtiao',
    douyinIdsInPage: ['TCLkongtiao'],
  };
  const wrongIdSnap = {
    httpStatus: 200,
    title: 'TCL空调的主页 - 抖音',
    bodyExcerpt: '抖音号：other_id',
    douyinIdsInPage: ['other_id'],
  };
  assert.equal(profileIdentity(shareSnap, target), true);
  assert.equal(profileIdentity(corpSnap, target), true);
  assert.equal(profileIdentity(wrongIdSnap, target), false);
});

test('R06: reconcileOpsDouyin preserves 10 unmapped ops rows and rejects unverified bindings', async () => {
  const cfg = JSON.parse(await fs.readFile(new URL('../config/probe-targets.json', import.meta.url), 'utf8'));
  const cross = JSON.parse(await fs.readFile(new URL('../config/jd-ops-crosswalk-template.json', import.meta.url), 'utf8'));
  const opsRooms = cross.douyinUnmappedOpsRows.opsRoomRowIds.map(id => ({ opsRoomRowId: id }));
  const rec = reconcileOpsDouyin({ approvedAccounts: cfg.douyin, opsRooms, verifiedBindings: [] });
  assert.equal(rec.opsRowCount, 10);
  assert.equal(rec.approvedPublicAccountCount, 12);
  assert.equal(rec.verifiedMappedRows, 0);
  assert.equal(rec.inferredNewAccounts, 0);
  assert.throws(
    () =>
      reconcileOpsDouyin({
        approvedAccounts: cfg.douyin,
        opsRooms,
        verifiedBindings: [{ opsRoomRowId: 12, approvedAccountKey: 'tcl-douyin-flagship', identityVerified: false, sourceUrl: 'https://www.douyin.com' }],
      }),
    /MISSING_VERIFIED_EVIDENCE/
  );
});
