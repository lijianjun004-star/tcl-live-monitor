// R3.25: "did each Douyin account broadcast today (Beijing day)?" from probe receipts, offline only.
// Evidence: (a) profile AND room page identity (ledger LIVE), or (b) the VERIFIED profile showing a live
// link to the account's OWN room (owner-scoped, or the single live link equal to its registered room).
// No sighting is never "did not broadcast". All keys and values below are synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { importReceipt, buildDailyBroadcast, buildSummary, beijingDay, broadcastDay } from '../../probes/r322/observation-ledger.mjs';
import { renderLedger } from '../../probes/r322/render-ledger.mjs';
import { documentShape } from '../../probes/lib/douyin.mjs';

const row = (key, at, extra = {}) => ({ key, at, state: 'UNKNOWN', reason: 'NO_LIVE_BADGE_NOT_PROOF_OF_OFFLINE',
  profileIdentityVerified: true, roomIdentityVerified: false, liveBadgeSeen: false, ownerAnchorScope: 'NO_OWNER_HEADER_LIVE_ANCHOR', ...extra });
const badge = (key, at, scope = 'REGISTERED_ROOM_LIVE_ANCHOR') => row(key, at, { liveBadgeSeen: true, ownerAnchorScope: scope,
  reason: 'LIVE_BADGE_BUT_ROOM_PAGE_NOT_CROSS_VERIFIED' });
const receipt = (at, checked) => ({ schemaVersion: 319, at, checked });
const ledgerOf = (...receipts) => receipts.reduce((l, r) => importReceipt(l, r, { evidenceKind: 'synthetic' }), null);

test('own-room badge flag: derived from the probe fields only, kept only when true', () => {
  const l = ledgerOf(receipt('2026-11-13T15:40:10Z', [
    badge('acct-a', '2026-11-13T15:39:37Z'),                                        // registered room: own
    badge('acct-b', '2026-11-13T15:39:40Z', 'OWNER_HEADER_LIVE_ANCHOR'),            // owner-scoped: own
    badge('acct-c', '2026-11-13T15:39:41Z', 'NO_OWNER_HEADER_LIVE_ANCHOR'),         // live link not tied to the account
    badge('acct-d', '2026-11-13T15:39:42Z', 'AMBIGUOUS_OWNER_LIVE_ANCHORS'),
    { ...badge('acct-e', '2026-11-13T15:39:43Z'), profileIdentityVerified: false },  // unverified profile
    { ...row('acct-f', '2026-11-13T15:39:44Z'), ownRoomLiveBadge: true },          // a receipt cannot assert it
    { key: 'acct-g', at: '2026-11-13T15:39:45Z', state: 'NOT_RUN', reason: 'STOPPED_AFTER_ACCESS_LIMIT' },
  ]));
  const flags = Object.fromEntries(l.observations.map(o => [o.key, o.ownRoomLiveBadge === true]));
  assert.deepEqual(flags, { 'acct-a': true, 'acct-b': true, 'acct-c': false, 'acct-d': false, 'acct-e': false, 'acct-f': false, 'acct-g': false });
  for (const o of l.observations) if (!o.ownRoomLiveBadge) assert.equal('ownRoomLiveBadge' in o, false);
  // never upgrades the state: profile-only evidence is not LIVE
  assert.equal(l.observations.find(o => o.key === 'acct-a').state, 'UNKNOWN');
  // ledger round trip stays valid; tampered stored flags are rejected
  assert.doesNotThrow(() => buildSummary(JSON.parse(JSON.stringify(l))));
  const tamper = (fn) => { const c = JSON.parse(JSON.stringify(l)); fn(c.observations); return () => buildDailyBroadcast(c); };
  assert.throws(tamper(o => { o.find(x => x.key === 'acct-c').ownRoomLiveBadge = false; }), /LEDGER_INPUT_INVALID/);
  assert.throws(tamper(o => { o.find(x => x.key === 'acct-c').ownRoomLiveBadge = 'yes'; }), /LEDGER_INPUT_INVALID/);
  assert.throws(tamper(o => { const x = o.find(y => y.key === 'acct-a'); x.profileIdentityVerified = false; }), /LEDGER_INPUT_INVALID/);
});

test('R3.22 ledgers (no badge fields at all) stay valid and readable', () => {
  const old = ledgerOf(receipt('2026-11-12T14:05:00Z', [{ key: 'acct-a', at: '2026-11-12T14:04:00Z', state: 'LIVE', reason: 'PROFILE_LIVE_BADGE_AND_ROOM_PAGE_IDENTITY',
    profileIdentityVerified: true, roomIdentityVerified: true }]));
  assert.equal('ownRoomLiveBadge' in old.observations[0], false);
  assert.deepEqual(buildDailyBroadcast(old).map(d => [d.date, d.status, d.evidence]), [['2026-11-12', 'BROADCAST_SEEN', 'PROFILE_AND_ROOM_PAGE_IDENTITY']]);
});

test('daily status per account and Beijing day: seen / not seen in samples / unknown', () => {
  const l = ledgerOf(
    receipt('2026-11-13T03:00:30Z', [row('acct-a', '2026-11-13T03:00:00Z'), row('acct-b', '2026-11-13T03:00:10Z'),
      { key: 'acct-c', at: '2026-11-13T03:00:20Z', state: 'UNKNOWN', reason: 'STOPPED_HTTP_403', profileIdentityVerified: false }]),
    receipt('2026-11-13T09:00:30Z', [badge('acct-a', '2026-11-13T09:00:00Z'), row('acct-b', '2026-11-13T09:00:10Z'),
      { key: 'acct-c', at: '2026-11-13T09:00:20Z', state: 'NOT_RUN', reason: 'STOPPED_AFTER_ACCESS_LIMIT' }]),
    receipt('2026-11-13T12:00:30Z', [{ ...row('acct-a', '2026-11-13T12:00:00Z'), state: 'LIVE', reason: 'PROFILE_LIVE_BADGE_AND_ROOM_PAGE_IDENTITY', roomIdentityVerified: true,
      liveBadgeSeen: true, ownerAnchorScope: 'REGISTERED_ROOM_LIVE_ANCHOR' }, row('acct-b', '2026-11-13T12:00:10Z')]));
  const d = Object.fromEntries(buildDailyBroadcast(l).map(x => [x.key, x]));
  assert.deepEqual([d['acct-a'].status, d['acct-a'].evidence, d['acct-a'].firstSeenAt, d['acct-a'].lastSeenAt, d['acct-a'].verifiedSamples],
    ['BROADCAST_SEEN', 'PROFILE_AND_ROOM_PAGE_IDENTITY', '2026-11-13T09:00:00.000Z', '2026-11-13T12:00:00.000Z', 3]);
  assert.deepEqual([d['acct-b'].status, d['acct-b'].evidence, d['acct-b'].verifiedSamples, d['acct-b'].firstVerifiedSampleAt, d['acct-b'].lastVerifiedSampleAt],
    ['NOT_SEEN_IN_SAMPLES', null, 3, '2026-11-13T03:00:10.000Z', '2026-11-13T12:00:10.000Z']);
  assert.deepEqual([d['acct-c'].status, d['acct-c'].samples, d['acct-c'].verifiedSamples], ['UNKNOWN', 2, 0]);
  for (const x of Object.values(d)) assert.equal(x.latestDay, true);
});

test('broadcast day runs 06:00 to 06:00 Beijing time: after-midnight sightings belong to the previous day', () => {
  assert.equal(beijingDay('2026-11-13T15:59:59Z'), '2026-11-13');
  assert.equal(beijingDay('2026-11-13T16:00:01Z'), '2026-11-14');
  assert.equal(broadcastDay('2026-11-13T17:11:00Z'), '2026-11-13');   // 01:11 Beijing on 11-14 -> the 11-13 session
  assert.equal(broadcastDay('2026-11-13T21:59:59Z'), '2026-11-13');   // 05:59:59
  assert.equal(broadcastDay('2026-11-13T22:00:00Z'), '2026-11-14');   // 06:00:00
  assert.equal(broadcastDay('2026-11-13T22:30:00Z'), '2026-11-14');
  const l = ledgerOf(receipt('2026-11-14T00:00:30Z', [badge('acct-a', '2026-11-13T17:11:00Z'), row('acct-a', '2026-11-14T00:00:01Z')]));
  assert.deepEqual(buildDailyBroadcast(l).map(x => [x.date, x.status, x.latestDay]),
    [['2026-11-14', 'NOT_SEEN_IN_SAMPLES', true], ['2026-11-13', 'BROADCAST_SEEN', false]]);
});

test('offline view: daily section, honest labels, still no scripts or links', () => {
  const l = ledgerOf(receipt('2026-11-13T09:00:30Z', [badge('acct-a', '2026-11-13T09:00:00Z'), row('acct-b', '2026-11-13T09:00:10Z')]));
  const html = renderLedger(l);
  assert.match(html, /每日开播（北京时间）/);
  assert.match(html, /已开播/); assert.match(html, /采样中未见开播/); assert.match(html, /当天结果可能随后续采样变化/);
  assert.match(html, /已核验主页上，本账号直播间显示"直播中"|已核验主页上，本账号直播间显示&quot;直播中&quot;/);
  assert.doesNotMatch(html, /没播|>未开播|<script|src=|href=|https?:\/\//i);
});

test('CLI daily report prints keys, statuses and counts only', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r325-'));
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, JSON.stringify(ledgerOf(receipt('2026-11-13T09:00:30Z', [badge('acct-a', '2026-11-13T09:00:00Z')]))));
  const r = spawnSync(process.execPath, ['probes/r325/daily-report.mjs', file], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.deepEqual(JSON.parse(lines.at(-1).replace('R325_DAILY_SUMMARY ', '')), { days: 1, broadcastSeen: 1, notSeenInSamples: 0, unknown: 0 });
  assert.equal(JSON.parse(lines[0].replace('R325_DAILY ', '')).evidence, 'PROFILE_OWN_ROOM_LIVE_BADGE');
  assert.equal(spawnSync(process.execPath, ['probes/r325/daily-report.mjs'], { encoding: 'utf8' }).status, 2);
});

test('raw HTML replay markers: wording count and key names only', () => {
  const t = { accountName: 'SYNTH_ACCOUNT', profileUrl: 'https://www.douyin.com/user/SYNTHETIC_SEC_UID_0001' };
  const s = documentShape('<div>直播回放</div><script id="RENDER_DATA">' + encodeURIComponent(JSON.stringify({ user: { live_replay_list: [{ title: 'SECRET_TITLE' }], replay_visible: true } })) + '</script>', t);
  assert.equal(s.replayText, 1);
  assert.deepEqual(s.replayKeys.sort(), ['live_replay_list', 'replay_visible']);
  assert.doesNotMatch(JSON.stringify(s), /SECRET_TITLE|SYNTH_ACCOUNT|SYNTHETIC_SEC_UID/);
  assert.deepEqual([documentShape('', t).replayText, documentShape('', t).replayKeys], [0, []]);
});
