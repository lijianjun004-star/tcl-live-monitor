// R3.23: offline fixes for the LIVE path, from approved real run 43449924435 (no Douyin access here).
// Real pages: empty profile titles, and the account's own "直播中" link outside the guessed owner
// containers, so the room was never visited and the reason wrongly said "no live badge".
// All identifiers below are synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { liveAnchorScope, decideDouyin, roomIdentityEvidence, liveAnchorRoomIds } from '../../probes/lib/douyin.mjs';

const t = { accountName: 'SYNTH_ACCOUNT', displayDouyinId: 'synth_id_01', roomId: '20000000002',
  profileUrl: 'https://www.douyin.com/user/SYNTHETIC_SEC_UID_0001' };
const anchor = (id, ownerScoped = false, text = '直播中') => ({ href: 'https://live.douyin.com/' + id, ownerScoped, text });
const profile = (anchors = [], extra = {}) => ({ httpStatus: 200, title: '', finalHost: 'www.douyin.com',
  finalPath: '/user/SYNTHETIC_SEC_UID_0001', douyinIdsInPage: ['synth_id_01'], bodyExcerpt: '抖音号：synth_id_01',
  metaDescription: '', liveRoomAnchors: anchors, ...extra });
const room = (id, extra = {}) => ({ httpStatus: 200, finalHost: 'live.douyin.com', finalPath: '/' + id,
  title: 'SYNTH_ACCOUNT的抖音直播间 - 抖音直播', metaDescription: '欢迎来到SYNTH_ACCOUNT的抖音直播间', bodyExcerpt: '',
  ownerProfileLinks: [t.profileUrl], mainPlayerEndedText: '', ...extra });
const strict = { strictRoomOwner: true };

test('single-argument liveAnchorScope is unchanged (no registry fallback without a target)', () => {
  assert.deepEqual(liveAnchorScope(profile([anchor('20000000002')])), { scope: 'NO_OWNER_HEADER_LIVE_ANCHOR', roomId: null });
  assert.deepEqual(liveAnchorScope(profile([anchor('20000000002', true)])), { scope: 'OWNER_HEADER_LIVE_ANCHOR', roomId: '20000000002' });
  assert.deepEqual(liveAnchorScope(profile([anchor('20000000002', true), anchor('30000000003', true)])), { scope: 'AMBIGUOUS_OWNER_LIVE_ANCHORS', roomId: null });
  assert.deepEqual(liveAnchorScope(profile()), { scope: 'NO_OWNER_HEADER_LIVE_ANCHOR', roomId: null });
});

test('registry fallback: only when the ONE live link on the page is this account\'s registered room', () => {
  assert.deepEqual(liveAnchorScope(profile([anchor('20000000002')]), t), { scope: 'REGISTERED_ROOM_LIVE_ANCHOR', roomId: '20000000002' });
  // same id twice is still one room
  assert.equal(liveAnchorScope(profile([anchor('20000000002'), anchor('20000000002')]), t).scope, 'REGISTERED_ROOM_LIVE_ANCHOR');
  // a foreign room alone, or next to the registered one, never qualifies
  assert.deepEqual(liveAnchorScope(profile([anchor('30000000003')]), t), { scope: 'NO_OWNER_HEADER_LIVE_ANCHOR', roomId: null });
  assert.deepEqual(liveAnchorScope(profile([anchor('20000000002'), anchor('30000000003')]), t), { scope: 'NO_OWNER_HEADER_LIVE_ANCHOR', roomId: null });
  // no registered room id -> no fallback; link without "直播中" text is not a live badge
  assert.equal(liveAnchorScope(profile([anchor('20000000002')]), { ...t, roomId: undefined }).scope, 'NO_OWNER_HEADER_LIVE_ANCHOR');
  assert.equal(liveAnchorScope(profile([anchor('20000000002', false, '推荐')]), t).scope, 'NO_OWNER_HEADER_LIVE_ANCHOR');
  // a link to a non-room path or another host is ignored
  assert.equal(liveAnchorScope(profile([{ href: 'https://live.douyin.com.evil.test/20000000002', text: '直播中' }]), t).scope, 'NO_OWNER_HEADER_LIVE_ANCHOR');
  // owner-scoped evidence keeps precedence (room id may have changed), ambiguity is never resolved by the registry
  assert.deepEqual(liveAnchorScope(profile([anchor('40000000004', true), anchor('20000000002')]), t), { scope: 'OWNER_HEADER_LIVE_ANCHOR', roomId: '40000000004' });
  assert.equal(liveAnchorScope(profile([anchor('40000000004', true), anchor('50000000005', true), anchor('20000000002')]), t).scope, 'AMBIGUOUS_OWNER_LIVE_ANCHORS');
});

test('decideDouyin (strict): registered-room fallback still needs the room page to confirm the owner', () => {
  const p = profile([anchor('20000000002')]);
  const live = decideDouyin(p, room('20000000002'), t, strict);
  assert.deepEqual([live.state, live.reason, live.observedRoomId, live.roomIdChanged, live.signals.ownerAnchorScope],
    ['LIVE', 'PROFILE_LIVE_BADGE_AND_ROOM_PAGE_IDENTITY', '20000000002', false, 'REGISTERED_ROOM_LIVE_ANCHOR']);
  for (const [bad, why] of [[room('20000000002', { ownerProfileLinks: ['https://www.douyin.com/user/SOMEONE_ELSE'] }), 'owner link'],
    [room('20000000002', { title: '' }), 'empty title'], [room('20000000002', { metaDescription: '' }), 'meta'],
    [room('20000000002', { finalPath: '/30000000003' }), 'redirected room'], [null, 'room not visited']]) {
    const d = decideDouyin(p, bad, t, strict);
    assert.deepEqual([d.state, d.reason], ['UNKNOWN', 'LIVE_BADGE_BUT_ROOM_PAGE_NOT_CROSS_VERIFIED'], why);
  }
  const ended = decideDouyin(p, room('20000000002', { mainPlayerEndedText: '直播已结束' }), t, strict);
  assert.deepEqual([ended.state, ended.reason], ['UNKNOWN', 'LIVE_BADGE_BUT_MAIN_PLAYER_ENDED']);
});

test('decideDouyin (strict): a live link that cannot be tied to the account is named, never "no live badge"', () => {
  for (const anchors of [[anchor('30000000003')], [anchor('20000000002'), anchor('30000000003')]]) {
    const d = decideDouyin(profile(anchors), null, t, strict);
    assert.deepEqual([d.state, d.reason, d.observedRoomId], ['UNKNOWN', 'LIVE_BADGE_OUTSIDE_OWNER_SCOPE', null]);
  }
  const none = decideDouyin(profile(), null, t, strict);
  assert.deepEqual([none.state, none.reason], ['UNKNOWN', 'NO_LIVE_BADGE_NOT_PROOF_OF_OFFLINE']);
  // unverified profile: nothing is trusted, whatever the badges say
  const other = decideDouyin(profile([anchor('20000000002')], { finalPath: '/user/SOMEONE_ELSE' }), room('20000000002'), t, strict);
  assert.deepEqual([other.state, other.reason], ['UNKNOWN', 'PROFILE_IDENTITY_NOT_VERIFIED']);
  // legacy (non-strict) callers keep their previous behaviour
  const legacy = decideDouyin(profile([anchor('30000000003')]), null, t);
  assert.deepEqual([legacy.state, legacy.reason, legacy.signals.ownerAnchorScope], ['UNKNOWN', 'LIVE_BADGE_BUT_ROOM_PAGE_NOT_CROSS_VERIFIED', 'LEGACY']);
});

test('roomIdentityEvidence: booleans (and one small status integer) only', () => {
  assert.deepEqual(roomIdentityEvidence(room('20000000002'), t), { httpOk: true, titleEmpty: false, titleExact: true, metaExact: true, ownerLinkExact: true, rawPresent: false, rawWebRidExact: false, rawOwnerExact: false, rawAnchorExact: false, rawStatus: null });
  assert.deepEqual(roomIdentityEvidence(room('20000000002', { title: '  ', ownerProfileLinks: [] }), t), { httpOk: true, titleEmpty: true, titleExact: false, metaExact: true, ownerLinkExact: false, rawPresent: false, rawWebRidExact: false, rawOwnerExact: false, rawAnchorExact: false, rawStatus: null });
  assert.deepEqual(roomIdentityEvidence(null, t), { httpOk: false, titleEmpty: true, titleExact: false, metaExact: false, ownerLinkExact: false, rawPresent: false, rawWebRidExact: false, rawOwnerExact: false, rawAnchorExact: false, rawStatus: null });
  for (const [k, v] of Object.entries(roomIdentityEvidence(room('20000000002'), t))) assert.ok(k === 'rawStatus' ? v === null || Number.isInteger(v) : typeof v === 'boolean');
});

test('probe: identity extractor byte-identical to R3.22; public receipt adds booleans only; diagnostics stay private', () => {
  const src = fs.readFileSync('probes/r316/douyin-rpa-two-once.mjs', 'utf8');
  const extractor = /const data = await page\.evaluate\((\(\) => \{[\s\S]*?\n    \})\);/.exec(src)?.[1];
  assert.equal(crypto.createHash('sha256').update(extractor).digest('hex'), '67882690fb3fcb2201383a48b6cf72840d2e52d9b3972d6437d7ff54ad0835ae');
  // the diagnostics call passes nothing into the page
  assert.match(src, /const raw = await page\.evaluate\(\(\) => \{[\s\S]*?\n    \}\)\.catch\(\(\) => null\);/);
  assert.equal((src.match(/page\.evaluate\(/g) || []).length, 2);
  assert.match(src, /const profile = await snap\(t\.profileUrl, t\);/);
  assert.match(src, /liveAnchorScope\(profile, t\)/);
  assert.doesNotMatch(src, /liveAnchorScope\(profile\)/);
  // structure goes into priv only
  const pubBlock = /pub\.push\(\{ key: t\.key, at, profileHttp[\s\S]*?\}\);/.exec(src)?.[0];
  assert.ok(pubBlock);
  assert.doesNotMatch(pubBlock, /structure|ancestry|finalPath|roomId\b|liveRoomIds/i);
  assert.match(pubBlock, /titleEmpty: String\(profile\.title \|\| ''\)\.trim\(\) === ''/);
  assert.match(pubBlock, /roomSignals: room \?/);
  const privBlock = /priv\.push\(\{[\s\S]*?\}\);/.exec(src)?.[0];
  assert.match(privBlock, /profileStructure: profile\.structure \?\? null, roomStructure: room\?\.structure \?\? null/);
});

test('real-run shape: one registered live link outside owner containers now leads to the room page, not "no badge"', () => {
  // Same shape as the redacted public receipt of run 43449924435 (account #1): verified profile, empty title,
  // live badge seen, no owner-scoped anchor.
  const p = profile([anchor('20000000002')]);
  assert.equal(liveAnchorRoomIds(p).length, 1);
  assert.equal(liveAnchorScope(p).scope, 'NO_OWNER_HEADER_LIVE_ANCHOR');      // R3.22 behaviour: room never visited
  assert.equal(liveAnchorScope(p, t).scope, 'REGISTERED_ROOM_LIVE_ANCHOR');   // R3.23: visit the account's own room
  assert.equal(decideDouyin(p, null, t, strict).reason, 'LIVE_BADGE_BUT_ROOM_PAGE_NOT_CROSS_VERIFIED');
});
