// R3.22 review (Claude): offline regressions for defects found by feeding REAL probe output
// (produced offline against a loopback stand-in) into the R3.22 ledger. Synthetic IDs only.
//   node --test tests/r322/claude-r322-review.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { importReceipt, buildSummary } from '../../probes/r322/observation-ledger.mjs';
import { renderLedger } from '../../probes/r322/render-ledger.mjs';
import { decideDouyin, profileIdentityEvidence } from '../../probes/lib/douyin.mjs';

// The exact public-row shape probes/r316/douyin-rpa-two-once.mjs prints (values synthetic).
const probeRow = (key, at, extra = {}) => ({ key, at, profileHttp: 200, roomHttp: null, profileIdentityVerified: true, liveBadgeSeen: false,
  roomIdentityVerified: false, ownerAnchorScope: 'NO_OWNER_HEADER_LIVE_ANCHOR',
  profileSignals: { titleExact: true, idExact: true, finalUrlExact: true, multipleVisibleIds: false },
  state: 'UNKNOWN', reason: 'NO_LIVE_BADGE_NOT_PROOF_OF_OFFLINE', stop: null, ...extra });
const probeReceipt = (checked, at) => ({ schemaVersion: 319, mode: 'DEFAULT_BLOCKED_ONE_PASS', at, checked, stopped: null, stopEvidence: null,
  approvedCoreCdnCount: {}, blockedHostsAndTypes: {}, formalOpeningRatePercent: null, formalFullDurationRatePercent: null });

test('a verified profile without a live badge (the most common real outcome) imports; old probe wording is mapped', () => {
  for (const reason of ['NO_LIVE_BADGE_NOT_PROOF_OF_OFFLINE', 'NO_LIVE_BADGE; not proof of offline']) {
    const l = importReceipt(null, probeReceipt([probeRow('K-1', '2026-11-13T12:00:00.000Z', { reason })], '2026-11-13T12:00:05.000Z'), { evidenceKind: 'synthetic' });
    assert.equal(l.observations[0].state, 'UNKNOWN');
    assert.equal(l.observations[0].reason, 'NO_LIVE_BADGE_NOT_PROOF_OF_OFFLINE');
    assert.equal(l.observations[0].reportedReason, 'NO_LIVE_BADGE_NOT_PROOF_OF_OFFLINE');
    assert.deepEqual(importReceipt(l, probeReceipt([probeRow('K-1', '2026-11-13T12:00:00.000Z', { reason })], '2026-11-13T12:00:05.000Z'), { evidenceKind: 'synthetic' }), l);
  }
  // only that exact legacy string is mapped: other free text is still rejected
  for (const reason of ['NO_LIVE_BADGE; something else', 'see https://example.invalid/x', 'no_live_badge'])
    assert.throws(() => importReceipt(null, probeReceipt([probeRow('K-1', '2026-11-13T12:00:00.000Z', { reason })], '2026-11-13T12:00:05.000Z'), { evidenceKind: 'synthetic' }), /LEDGER_INPUT_INVALID/);
});

test('identity library now emits the canonical token for a verified profile with no badge', () => {
  const t = { accountName: '示例店', displayDouyinId: '10000000001', profileUrl: 'https://www.douyin.com/user/SYNTHETIC' };
  const p = { httpStatus: 200, title: '示例店的抖音 - 抖音', bodyExcerpt: '', douyinIdsInPage: ['10000000001'], finalHost: 'www.douyin.com', finalPath: '/user/SYNTHETIC', liveRoomAnchors: [] };
  assert.equal(decideDouyin(p, null, t, { strictRoomOwner: true }).reason, 'NO_LIVE_BADGE_NOT_PROOF_OF_OFFLINE');
});

test('probe never truncates finalPath below the longest APPROVED profile path (exact-path identity)', () => {
  const src = fs.readFileSync('probes/r316/douyin-rpa-two-once.mjs', 'utf8');
  const n = Number(/finalPath: f\.pathname\.slice\(0, (\d+)\)/.exec(src)?.[1]);
  const reg = JSON.parse(fs.readFileSync('config/probe-targets.json', 'utf8'));
  const longest = Math.max(...reg.douyin.filter(x => x.scopeApproved === true).map(x => new URL(x.profileUrl).pathname.length));
  assert.ok(longest > 80, 'registry really contains approved paths longer than the old 80-char cut');
  assert.ok(n >= longest, `slice(${n}) must keep the full ${longest}-char path`);
  // what the old cut did: an 82-char path can never match exactly
  const path82 = '/user/' + 'A'.repeat(76);
  const t = { accountName: '示例店', displayDouyinId: '10000000001', profileUrl: 'https://www.douyin.com' + path82 };
  const page = finalPath => ({ httpStatus: 200, title: '示例店的抖音 - 抖音', bodyExcerpt: '', douyinIdsInPage: ['10000000001'], finalHost: 'www.douyin.com', finalPath });
  assert.equal(profileIdentityEvidence(page(path82.slice(0, 80)), t).verified, false);
  assert.equal(profileIdentityEvidence(page(path82.slice(0, n)), t).verified, true);
});

test('NOT_RUN is a record, not an observation: counted separately in summary and page', () => {
  const r = probeReceipt([probeRow('K-1', '2026-11-13T08:22:10.049Z', { state: 'UNKNOWN', reason: 'STOPPED_HTTP_403', profileHttp: 403, profileIdentityVerified: false }),
    { key: 'K-2', at: '2026-11-13T08:22:18.658Z', state: 'NOT_RUN', reason: 'STOPPED_AFTER_ACCESS_LIMIT' }], '2026-11-13T08:22:18.681Z');
  const l = importReceipt(null, r, { evidenceKind: 'synthetic' });
  const s = buildSummary(l);
  assert.deepEqual(s.rooms.map(x => [x.key, x.executedCount, x.notRunCount]), [['K-1', 1, 0], ['K-2', 0, 1]]);
  const html = renderLedger(l);
  assert.match(html, /实际观察次数<\/span><strong>1<\/strong><span class="muted">另有 1 条未执行/);
  assert.match(html, /K-2<\/h3><span class="badge NOT_RUN">未执行<\/span><dl><dt>记录时间<\/dt>/);   // never "observed"
  assert.doesNotMatch(html, /<script|src=|href=|https?:\/\//i);
});

test('session clues show the longest sampling gap; a single sighting says so instead of "0 s"', () => {
  const live = (at) => probeRow('K-1', at, { state: 'LIVE', reason: 'PROFILE_LIVE_BADGE_AND_ROOM_PAGE_IDENTITY', roomIdentityVerified: true, liveBadgeSeen: true });
  const l = importReceipt(null, probeReceipt([live('2026-11-13T12:00:00.000Z'), live('2026-11-13T12:10:00.000Z'), live('2026-11-13T14:10:00.000Z')], '2026-11-13T14:10:01.000Z'), { evidenceKind: 'synthetic' });
  const [s] = buildSummary(l).sessions;
  assert.equal(s.maxSampleGapSeconds, 7200); assert.equal(s.hasSamplingGaps, true); assert.equal(s.durationSeconds, null);
  assert.match(renderLedger(l), /最长采样间隔<\/dt><dd>120 分钟/);
  const one = importReceipt(null, probeReceipt([live('2026-11-13T12:00:00.000Z')], '2026-11-13T12:00:01.000Z'), { evidenceKind: 'synthetic' });
  assert.match(renderLedger(one), /最长采样间隔<\/dt><dd>—（只有一次观察）/);
});
