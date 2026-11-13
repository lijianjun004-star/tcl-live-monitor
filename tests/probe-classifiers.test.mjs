import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyTmall, parseJSONOrJSONP, pickBest } from '../probes/lib/tmall.mjs';
import { decideDouyin, liveAnchorRoomIds } from '../probes/lib/douyin.mjs';

const tm = { key: 'tcl-group', displayName: 'TCL集团官方旗舰店', accountId: '2050532947', roomNumber: '130742' };
const live = { ret: ['SUCCESS::调用成功'], data: { accountId: '2050532947', liveId: '2440260024340383', roomNum: '130742', roomStatus: '1', streamStatus: '1', startTime: '1793574006000',
  broadCaster: { accountId: '2050532947', accountName: 'TCL集团官方旗舰店', roomNum: '130742' } } };

test('tmall: LIVE / OFFLINE(with evidence) / errors -> UNKNOWN', () => {
  assert.equal(classifyTmall(live, tm).state, 'LIVE');
  const off = classifyTmall({ ...live, data: { ...live.data, accountId: '0', liveId: '0', roomStatus: 0, streamStatus: 0 } }, tm);
  assert.equal(off.state, 'OFFLINE'); assert.equal(off.offlineEvidence, true);
  assert.equal(classifyTmall({ ret: ['FAIL_SYS_TOKEN_EMPTY::令牌为空'] }, tm).reason, 'API_ERROR');
  assert.equal(classifyTmall({ ...live, data: { ...live.data, broadCaster: { ...live.data.broadCaster, accountId: '1' } } }, tm).reason, 'IDENTITY_MISMATCH');
  assert.equal(classifyTmall({ ...live, data: { ...live.data, streamStatus: 0 } }, tm).state, 'UNKNOWN');
  assert.equal(parseJSONOrJSONP('mtopjsonp1({"ret":["SUCCESS"]})').ret[0], 'SUCCESS');
  assert.equal(pickBest([{ state: 'UNKNOWN', reason: 'API_ERROR' }, { state: 'LIVE' }]).state, 'LIVE');
});

const dy = { key: 'k', accountName: 'TCL官方旗舰店', displayDouyinId: '79013748820', roomId: '31878890513' };
const profile = (anchors = []) => ({ httpStatus: 200, title: 'TCL官方旗舰店的抖音 - 抖音', bodyExcerpt: '抖音号：79013748820 ...', liveRoomAnchors: anchors });
const room = (extra = {}) => ({ httpStatus: 200, title: 'TCL官方旗舰店的抖音直播间 - 抖音直播', metaDescription: '欢迎来到TCL官方旗舰店的抖音直播间', bodyExcerpt: '', statusFields: [], ...extra });

test('douyin: two-page corroborated LIVE', () => {
  const d = decideDouyin(profile([{ href: 'https://live.douyin.com/31878890513', text: '直播中' }]), room(), dy);
  assert.equal(d.state, 'LIVE'); assert.equal(d.roomIdChanged, false);
});

test('douyin: room id changed across sessions is discovered', () => {
  const p = profile([{ href: 'https://live.douyin.com/99999999999', text: '直播中' }]);
  assert.deepEqual(liveAnchorRoomIds(p), ['99999999999']);
  const d = decideDouyin(p, room(), dy);
  assert.equal(d.state, 'LIVE'); assert.equal(d.reason, 'LIVE_ROOM_ID_CHANGED');
});

test('douyin: no badge alone is UNKNOWN, never OFFLINE', () => {
  const d = decideDouyin(profile(), room(), dy);
  assert.equal(d.state, 'UNKNOWN'); assert.equal(d.offlineCandidate, false);
});

test('douyin: ended text + status 4 is only a candidate until rule validated', () => {
  const r = room({ bodyExcerpt: '侧边栏推荐：其他主播已下播', mainPlayerEndedText: '直播已结束', statusFields: [{ field: '$.data.data[0].status', value: 4 }] });
  const c = decideDouyin(profile(), r, dy);
  assert.equal(c.state, 'UNKNOWN'); assert.equal(c.offlineCandidate, true);
  assert.equal(decideDouyin(profile(), r, dy, { offlineRuleValidated: true }).state, 'OFFLINE');
});

test('douyin: challenge / identity mismatch -> UNKNOWN', () => {
  assert.equal(decideDouyin({ ...profile(), title: '验证码中间页' }, room(), dy).reason, 'PUBLIC_GUEST_ACCESS_CHALLENGED');
  assert.equal(decideDouyin({ ...profile(), bodyExcerpt: '抖音号：1' }, room(), dy).reason, 'PROFILE_IDENTITY_NOT_VERIFIED');
});

test('douyin: 抖音号 beyond excerpt is still found via full-page scan', () => {
  const p = { ...profile([{ href: 'https://live.douyin.com/31878890513', text: '直播中' }]), bodyExcerpt: '直播横幅……', douyinIdsInPage: ['79013748820'] };
  assert.equal(decideDouyin(p, room(), dy).state, 'LIVE');
  assert.equal(decideDouyin({ ...p, douyinIdsInPage: ['11111111111'] }, room(), dy).reason, 'PROFILE_IDENTITY_NOT_VERIFIED');
});
