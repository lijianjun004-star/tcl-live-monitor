// R3.26: room identity from the RAW server HTML (shape seen in approved run 43464891978). Synthetic values.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rawRoomEvidence, rawRoomIdentity, decideDouyin } from '../../probes/lib/douyin.mjs';

const SEC = 'SYNTHETIC_SEC_UID_0001', RID = '20000000002';
const t = { accountName: 'SYNTH_ACCOUNT', displayDouyinId: 'synth_id_01', roomId: RID, profileUrl: 'https://www.douyin.com/user/' + SEC };
const store = ({ status = 2, owner = SEC, anchor = SEC, webRid = RID } = {}) => ({ state: { roomStore: { roomInfo: {
  room: { id_str: '7000000000000000001', status, title: 'SECRET_TITLE', stream_url: { a: 'x'.repeat(500) }, owner: { id_str: '111', sec_uid: owner, nickname: 'SYNTH_ACCOUNT' } },
  roomId: '7000000000000000001', web_rid: webRid, anchor: { id_str: '111', sec_uid: anchor, nickname: 'SYNTH_ACCOUNT' } } }, linkmicStore: {} } });
const pace = obj => `<html><head><title></title></head><body><script>(self.__pace_f=self.__pace_f||[]).push([1,${JSON.stringify(JSON.stringify(obj))}])</script></body></html>`;
const ok = { forRoomId: RID, present: true, webRidExact: true, ownerExact: true, anchorExact: true, status: 2 };
const profile = { httpStatus: 200, title: '', finalHost: 'www.douyin.com', finalPath: '/user/' + SEC, douyinIdsInPage: ['synth_id_01'], bodyExcerpt: '',
  liveRoomAnchors: [{ href: 'https://live.douyin.com/' + RID, text: '直播中', ownerScoped: false }] };
const room = (raw, extra = {}) => ({ httpStatus: 200, finalHost: 'live.douyin.com', finalPath: '/' + RID, title: '', metaDescription: '', bodyExcerpt: '', ownerProfileLinks: [], raw, ...extra });
const strict = { strictRoomOwner: true };

test('raw evidence: streamed chunk and RENDER_DATA; booleans and status only', () => {
  assert.deepEqual(rawRoomEvidence(pace(store()), t, RID), ok);
  assert.deepEqual(rawRoomEvidence(`<script id="RENDER_DATA" type="application/json">${encodeURIComponent(JSON.stringify(store()))}</script>`, t, RID), ok);
  assert.doesNotMatch(JSON.stringify(rawRoomEvidence(pace(store()), t, RID)), /SYNTH|SECRET/);
});

test('raw evidence fails closed on any mismatch or missing piece', () => {
  const ev = o => rawRoomEvidence(pace(store(o)), t, RID);
  assert.equal(ev({ owner: 'SOMEONE_ELSE_SEC_UID' }).ownerExact, false);
  assert.equal(ev({ anchor: 'SOMEONE_ELSE_SEC_UID' }).anchorExact, false);
  assert.deepEqual([ev({ webRid: '30000000003' }).webRidExact, ev({ webRid: '30000000003' }).anchorExact], [false, false]);
  assert.equal(ev({ status: 4 }).status, 4);
  for (const html of ['', '<html></html>', pace({ state: { otherStore: {} } }), pace({ roomStore: { roomInfo: {} } })]) assert.equal(rawRoomEvidence(html, t, RID).present, false);
  assert.equal(rawRoomEvidence(pace(store()), t, 'abc').present, false);
  assert.equal(rawRoomEvidence(pace(store()), { ...t, profileUrl: 'not a url' }, RID).present, false);
  // a second pair for the same room naming another account -> not exact
  const two = pace(store()) + pace(store({ anchor: 'SOMEONE_ELSE_SEC_UID' }));
  assert.equal(rawRoomEvidence(two.replace('"linkmicStore"', '"x"'), t, RID).present, true);
  // another account's sec_uid merely containing ours is not ours
  assert.equal(ev({ owner: SEC + 'X' }).ownerExact, false);
  assert.equal(rawRoomIdentity({ raw: ok }, RID), true);
  assert.equal(rawRoomIdentity({ raw: ok }, '30000000003'), false);
  assert.equal(rawRoomIdentity({ raw: { ...ok, ownerExact: false } }, RID), false);
  assert.equal(rawRoomIdentity({}, RID), false);
});

test('decideDouyin: unrendered room page + raw identity + status 2 -> LIVE (strict path only)', () => {
  const d = decideDouyin(profile, room(ok), t, strict);
  assert.deepEqual([d.state, d.reason, d.roomPageIdentityVerified, d.profileIdentityVerified], ['LIVE', 'PROFILE_LIVE_BADGE_AND_ROOM_RAW_HTML_IDENTITY', true, true]);
  const un = (r, why) => { const x = decideDouyin(profile, r, t, strict); assert.deepEqual([x.state, x.reason], ['UNKNOWN', why]); return x; };
  assert.equal(un(room({ ...ok, status: 4 }), 'ROOM_RAW_HTML_STATUS_NOT_LIVE').roomPageIdentityVerified, true);
  for (const bad of [room({ ...ok, ownerExact: false }), room({ ...ok, anchorExact: false }), room({ ...ok, webRidExact: false }), room({ ...ok, present: false }),
    room({ ...ok, forRoomId: '30000000003' }), room(ok, { finalPath: '/30000000003' }), room(ok, { finalHost: 'www.douyin.com' }), room(ok, { httpStatus: 404 }),
    room(ok, { bodyExcerpt: '请先登录后观看' }), room(null)]) assert.equal(un(bad, 'LIVE_BADGE_BUT_ROOM_PAGE_NOT_CROSS_VERIFIED').roomPageIdentityVerified, false);
  assert.equal(decideDouyin(profile, room(ok, { title: '安全验证' }), t, strict).reason, 'PUBLIC_GUEST_ACCESS_CHALLENGED');
  // unverified profile or non-strict callers never use the raw path
  assert.equal(decideDouyin({ ...profile, finalPath: '/user/OTHER' }, room(ok), t, strict).state, 'UNKNOWN');
  assert.equal(decideDouyin(profile, room(ok), t).state, 'UNKNOWN');
});

test('private skeleton: key names kept, every string value and digit masked', async () => {
  const { roomStoreSkeleton } = await import('../../probes/lib/douyin.mjs');
  const sk = roomStoreSkeleton(pace(store()));
  assert.equal(sk.occurrences, 1);
  assert.match(sk.samples[0], /"roomStore":\{"roomInfo":\{"room":\{"id_str":"S","status":9/);
  assert.match(sk.anchor.join(' '), /"web_rid":"S","anchor":\{"id_str":"S","sec_uid":"S"/);
  assert.doesNotMatch(JSON.stringify([sk.samples, sk.owner, sk.anchor]), /SYNTH|SECRET|xxxx|[0-8]/);
  assert.deepEqual(roomStoreSkeleton(undefined), { occurrences: 0, samples: [], owner: [], anchor: [] });
});
test('deeper escaping (JSON string inside a JSON string) is still read', () => {
  const twice = `<script>x=${JSON.stringify(JSON.stringify(JSON.stringify(store())))}</script>`;
  assert.deepEqual(rawRoomEvidence(twice, t, RID), ok);
});
