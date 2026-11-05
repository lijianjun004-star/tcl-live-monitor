import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normalizeOpsCatalog, publicTargetsFromConfig, assembleRegistry, targetsToTagged } from '../probes/lib/ops-room-registry.mjs';
import { mergeLiveObservations } from '../probes/lib/merge-live-observations.mjs';
import { auditThreePlatformCoverage } from '../probes/lib/coverage-audit.mjs';

const readJson = rel => JSON.parse(fs.readFileSync(new URL(rel, import.meta.url), 'utf8'));

test('R091-BUG-01: mergeLiveObservations fails closed to SHARED_PUBLIC_ROOM_ID_CONFLICT when two public Douyin accounts share the same LIVE observedRoomId', () => {
  const catalogRaw = readJson('../fixtures/ops-catalog-safe-20261105.json');
  const cfg = readJson('../config/probe-targets.json');
  const opsCatalog = normalizeOpsCatalog(catalogRaw.roomsResponse, catalogRaw.shopsResponse);
  const registry = assembleRegistry({ opsCatalog, configuredTargets: targetsToTagged(cfg), asOf: '2026-11-05T14:09:43.737Z' });
  const now = Date.parse('2026-11-05T14:09:43.737Z');

  const publicReport = {
    schemaVersion: 1,
    observations: [
      {
        platform: 'douyin',
        accountId: 'tcl-douyin-flagship',
        at: '2026-11-05T14:08:00.000Z',
        state: 'LIVE',
        profileIdentityVerified: true,
        roomPageIdentityVerified: true,
        observedRoomId: '7390000000000000001',
        checkedRoomId: '7390000000000000001'
      },
      {
        platform: 'douyin',
        accountId: 'tcl-douyin-flagship-tv-live',
        at: '2026-11-05T14:08:00.000Z',
        state: 'LIVE',
        profileIdentityVerified: true,
        roomPageIdentityVerified: true,
        observedRoomId: '7390000000000000001',
        checkedRoomId: '7390000000000000001'
      }
    ]
  };

  const view = mergeLiveObservations(registry, { publicReport, now, maxAgeMinutes: 12 });
  const r1 = view.rows.find(r => r.key === 'public:douyin:tcl-douyin-flagship');
  const r2 = view.rows.find(r => r.key === 'public:douyin:tcl-douyin-flagship-tv-live');
  assert.equal(r1.currentStatus, 'UNKNOWN');
  assert.equal(r2.currentStatus, 'UNKNOWN');
  assert.equal(r1.currentReason, 'SHARED_PUBLIC_ROOM_ID_CONFLICT');
  assert.equal(r2.currentReason, 'SHARED_PUBLIC_ROOM_ID_CONFLICT');
  assert.equal(view.byPlatform.douyin.LIVE, 0);
});

test('R091-BUG-02: mergeLiveObservations preserves JD UNKNOWN reason instead of overwriting with FRESH_JD_OPS_OBSERVATION', () => {
  const catalogRaw = readJson('../fixtures/ops-catalog-safe-20261105.json');
  const cfg = readJson('../config/probe-targets.json');
  const jdReport = readJson('../fixtures/jd-all-safe-report-20261105.json');
  const opsCatalog = normalizeOpsCatalog(catalogRaw.roomsResponse, catalogRaw.shopsResponse);
  const registry = assembleRegistry({ opsCatalog, configuredTargets: targetsToTagged(cfg), asOf: jdReport.checkedAt });
  const view = mergeLiveObservations(registry, { jdReport, now: Date.parse(jdReport.checkedAt), maxAgeMinutes: 12 });

  const room16 = view.rows.find(r => r.key === 'ops:jd:16');
  assert.equal(room16.currentStatus, 'UNKNOWN');
  assert.notEqual(room16.currentReason, 'FRESH_JD_OPS_OBSERVATION');
  assert.equal(room16.currentReason, 'DAILY_DATA_MISSING_OR_INVALID');
});

test('R091-BUG-03: mergeLiveObservations reports explicit JD_CATEGORY_MAPPING_CONFLICT and retains observedAt for room 1', () => {
  const catalogRaw = readJson('../fixtures/ops-catalog-safe-20261105.json');
  const cfg = readJson('../config/probe-targets.json');
  const jdReport = readJson('../fixtures/jd-all-safe-report-20261105.json');
  const opsCatalog = normalizeOpsCatalog(catalogRaw.roomsResponse, catalogRaw.shopsResponse);
  const registry = assembleRegistry({ opsCatalog, configuredTargets: targetsToTagged(cfg), asOf: jdReport.checkedAt });
  const view = mergeLiveObservations(registry, { jdReport, now: Date.parse(jdReport.checkedAt), maxAgeMinutes: 12 });

  const room1 = view.rows.find(r => r.key === 'ops:jd:1');
  assert.equal(room1.currentStatus, 'UNKNOWN');
  assert.equal(room1.currentReason, 'JD_CATEGORY_MAPPING_CONFLICT');
  assert.equal(room1.observedAt, jdReport.checkedAt);
});

test('R091-BUG-04: auditThreePlatformCoverage rejects cross-key duplicate (platform, opsRoomId) and duplicate shop identities', () => {
  const catalogRaw = readJson('../fixtures/ops-catalog-safe-20261105.json');
  const cfg = readJson('../config/probe-targets.json');
  const opsCatalog = normalizeOpsCatalog(catalogRaw.roomsResponse, catalogRaw.shopsResponse);
  const registry = assembleRegistry({ opsCatalog, configuredTargets: targetsToTagged(cfg), asOf: '2026-11-05T14:09:43.737Z' });

  const dupRoomRegistry = {
    ...registry,
    entries: [
      ...registry.entries,
      {
        key: 'ops-history:douyin:10',
        source: 'ops-history-unmapped',
        platform: 'douyin',
        opsRoomId: '10',
        category: '彩电',
        currentStatus: 'UNKNOWN',
        verifiedExternalIdentity: false,
        scoringEligible: false
      }
    ]
  };
  assert.throws(() => auditThreePlatformCoverage({ registry: dupRoomRegistry, publicConfig: cfg }), /REGISTRY_IDENTITY_CONFLICT/);

  const dupShopRegistry = {
    ...registry,
    shops: [...registry.shops, { ...registry.shops[0] }]
  };
  assert.throws(() => auditThreePlatformCoverage({ registry: dupShopRegistry, publicConfig: cfg }), /SHOP_IDENTITY_CONFLICT/);
});

test('R091-BUG-05A: normalizeOpsCatalog flags empty or missing category on expected JD rooms as categoryMappingConflict', () => {
  const res = normalizeOpsCatalog(
    [{ id: 14, platform: '京东', category: '', shop_id: 14, bound_session_key: 'ok' }],
    [{ id: 14, platform: '京东', category: '彩电' }]
  );
  assert.equal(res.rooms[0].categoryMappingConflict, true);
  assert.ok(res.warnings.includes('CATEGORY_MAPPING_CONFLICT:14'));
});

test('R091-BUG-05B: preview/template.html validates sourceShops array before mutating doc and displays all-platform unmapped count', () => {
  const html = fs.readFileSync(new URL('../preview/template.html', import.meta.url), 'utf8');
  assert.ok(html.includes('raw.sourceShops!==undefined&&!Array.isArray(raw.sourceShops)'), 'must validate raw.sourceShops before assigning doc=raw');
  assert.ok(html.includes('内部待映射房间（全平台）'), 'must clearly indicate all-platform unmapped internal rooms');
});

test('R091-MATRIX: four-platform TCL & FFALCON matrix config is well-formed and enforces non-scoring candidate isolation', () => {
  const matrix = readJson('../config/four-platform-tcl-ffalcon-matrix.json');
  assert.equal(matrix.schemaVersion, 1);
  assert.equal(matrix.platforms.douyin.internalUnmappedOpsRooms.length, 10);
  assert.equal(matrix.platforms.jd.internalOpsRooms.length, 6);
  assert.ok(matrix.platforms.tmall.verifiedBrandFlagshipStores.length >= 9);
  assert.ok(matrix.platforms.taobao.observedEnterpriseOrSpecialtyStores.length >= 2);
  assert.ok(matrix.platforms.jd.verifiedBrandFlagshipStores.length >= 10);
  for (const c of matrix.platforms.douyin.additionalOfficialOrBrandCandidates) {
    assert.equal(c.scoringEligible, false);
  }
  for (const s of matrix.platforms.tmall.verifiedBrandFlagshipStores) {
    assert.equal(s.scoringEligible, false);
  }
  for (const s of matrix.platforms.jd.verifiedBrandFlagshipStores) {
    assert.equal(s.scoringEligible, false);
  }
});
