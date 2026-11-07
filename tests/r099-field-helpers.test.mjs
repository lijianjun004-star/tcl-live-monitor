import test from 'node:test';
import assert from 'node:assert/strict';
import { platformNameFromTitle, classifyMtopSequence } from '../probes/lib/r099-identity.mjs';
import { decideDouyin } from '../probes/lib/douyin.mjs';
import fs from 'node:fs';

test('platform name comes from the page title only', () => {
  assert.equal(platformNameFromTitle('TCL数码旗舰店的抖音 - 抖音'), 'TCL数码旗舰店');
  assert.equal(platformNameFromTitle('雷鸟电视直播间的主页 - 抖音'), '雷鸟电视直播间');
  assert.equal(platformNameFromTitle('验证码中间页'), null);
  assert.equal(platformNameFromTitle(''), null);
});

test('same secUid, name differs from claim: identity is the page, claim mismatch is reported not hidden', () => {
  const observed = { accountName: 'TCL大家电旗舰店', displayDouyinId: '50569560060' };
  const profile = { httpStatus: 200, title: 'TCL大家电旗舰店的抖音 - 抖音', bodyExcerpt: '抖音号：50569560060', douyinIdsInPage: ['50569560060'], liveRoomAnchors: [] };
  const d = decideDouyin(profile, null, observed);
  assert.equal(d.profileIdentityVerified, true);
  assert.equal(d.state, 'UNKNOWN', 'no live badge is never OFFLINE');
  assert.notEqual(observed.accountName, 'TCL智能电器旗舰店');
});

test('mtop sequences: token refresh then success is healthy; throttle codes cool down; token-only is not success', () => {
  assert.equal(classifyMtopSequence(['SUCCESS::调用成功']).kind, 'SUCCESS');
  assert.equal(classifyMtopSequence(['FAIL_SYS_TOKEN_EMPTY::令牌为空', 'SUCCESS::调用成功']).kind, 'SUCCESS_AFTER_TOKEN_REFRESH');
  assert.equal(classifyMtopSequence(['RGV587_ERROR::SM::哎哟喂,被挤爆啦']).kind, 'THROTTLED_OR_VALIDATION');
  assert.equal(classifyMtopSequence(['FAIL_SYS_USER_VALIDATE']).kind, 'THROTTLED_OR_VALIDATION');
  assert.equal(classifyMtopSequence(['FAIL_SYS_TOKEN_EXOIRED']).kind, 'TOKEN_ONLY_NO_RETRY');
  assert.equal(classifyMtopSequence([]).kind, 'NO_RESPONSE');
  assert.equal(classifyMtopSequence(['FAIL_BIZ_X']).kind, 'OTHER_ERROR');
});

test('R0.9.9 configs: 14 unique secUids, never scoring; JD SKUs are product ids, separate from shop ids', () => {
  const b14 = JSON.parse(fs.readFileSync(new URL('../config/r099-douyin-b14.json', import.meta.url)));
  assert.equal(b14.candidates.length, 14);
  assert.equal(new Set(b14.candidates.map(c => c.secUid)).size, 14);
  for (const c of b14.candidates) { assert.equal(c.scoringEligible, false); assert.match(c.secUid, /^MS4wLjABAAAA[\w-]{20,}$/); }
  const jd = JSON.parse(fs.readFileSync(new URL('../config/r099-jd-room-skus.json', import.meta.url)));
  for (const [room, skus] of Object.entries(jd.roomSkus)) for (const s of skus) {
    assert.match(s.sku, /^\d{12,14}$/, `room ${room}`);
    assert.ok(!('shopId' in s), 'config must not pre-assign a shop id');
  }
});

test('JD frequency-control page is a wall (run 42354838292 regression)', async () => {
  const src = fs.readFileSync(new URL('../probes/r099-jd-sku-shop.mjs', import.meta.url), 'utf8');
  const title = /export const JD_WALL_TITLE_RE = (\/.*\/);/.exec(src)[1], host = /export const JD_WALL_HOST_RE = (\/.*\/);/.exec(src)[1];
  const T = eval(title), H = eval(host);
  assert.ok(T.test('PC频控页 -京东商城'));
  assert.ok(H.test('pc-frequent-pro.pf.jd.com'));
  assert.ok(!H.test('item.jd.com') && !T.test('TCL 65英寸 电视【行情 报价 价格 评测】-京东'));
});

test('R0.9.9 JD room 16 counterexample: live agent + NO minute rows all day is not an OFFLINE candidate', async () => {
  const { classifyTclOps } = await import('../probes/lib/tcl-ops.mjs');
  const now = Date.parse('2026-11-07T08:20:00Z');
  const neverHadMinutes = classifyTclOps({ day: null, heartbeatAt: '2026-11-07T08:19:50Z', now, offlineRuleValidated: true });
  assert.equal(neverHadMinutes.state, 'UNKNOWN');
  assert.equal(neverHadMinutes.reason, 'NO_MINUTE_FEED_TODAY');
  assert.ok(!neverHadMinutes.offlineCandidate);
  // minutes that existed and then stopped are still a candidate (unchanged behaviour)
  const stopped = classifyTclOps({ day: { minute_count: 300, latest_minute_ts: '2026-11-07T07:40:00Z', latest: { status: 1 } }, heartbeatAt: '2026-11-07T08:19:50Z', now });
  assert.equal(stopped.offlineCandidate, true);
});

test('R0.9.9 Tmall fix stays in the probe: one persistent context, throttle cool-down, no per-round Tmall context', () => {
  const src = fs.readFileSync(new URL('../probes/public-status-probe.mjs', import.meta.url), 'utf8');
  assert.match(src, /const context = tmallContext \|\|= await browser\.newContext/);
  assert.match(src, /TMALL_COOLDOWN_AFTER_THROTTLE/);
  assert.match(src, /mtop\.kind === 'THROTTLED_OR_VALIDATION'/);
  assert.ok(!/await context\.close\(\); await dyContext\.close\(\);/.test(src), 'Tmall context must not be closed every round');
});

// ---- R0.9.9 handoff reverse tests that had no direct unit test yet ----
const prof = (name, id, { http = 200, live = null } = {}) => ({ httpStatus: http, title: `${name}的抖音 - 抖音`, bodyExcerpt: `${name} 抖音号：${id} 粉丝 1万`,
  douyinIdsInPage: [id], liveRoomAnchors: live ? [{ href: `https://live.douyin.com/${live}`, text: '直播中' }] : [] });
const roomPage = (name, { http = 200 } = {}) => ({ httpStatus: http, title: `${name}的抖音直播间 - 抖音直播`, metaDescription: `欢迎来到${name}的抖音直播间`, bodyExcerpt: '' });

test('same name, different secUid/抖音号: a LIVE page of account B never verifies account A', () => {
  const A = { accountName: 'TCL电视旗舰店', displayDouyinId: '91583412707', roomId: '91583412707001' };
  const pageOfB = prof('TCL电视旗舰店', '99999999999', { live: '22200000222' });
  const d = decideDouyin(pageOfB, roomPage('TCL电视旗舰店'), A);
  assert.equal(d.state, 'UNKNOWN'); assert.equal(d.reason, 'PROFILE_IDENTITY_NOT_VERIFIED');
  const B = { accountName: 'TCL电视旗舰店', displayDouyinId: '99999999999', roomId: '22200000222' };
  assert.equal(decideDouyin(pageOfB, roomPage('TCL电视旗舰店'), B).state, 'LIVE');
});

test('HTTP 403 / rate limit on Douyin profile or room page is UNKNOWN, never OFFLINE', () => {
  const t = { accountName: 'TCL电视旗舰店', displayDouyinId: '91583412707', roomId: '11100000111' };
  const p403 = { ...prof(t.accountName, t.displayDouyinId), httpStatus: 403 };
  const d1 = decideDouyin(p403, null, t);
  assert.equal(d1.state, 'UNKNOWN'); assert.equal(d1.reason, 'PROFILE_IDENTITY_NOT_VERIFIED');
  const d2 = decideDouyin(prof(t.accountName, t.displayDouyinId, { live: '11100000111' }), roomPage(t.accountName, { http: 403 }), t);
  assert.equal(d2.state, 'UNKNOWN'); assert.equal(d2.reason, 'LIVE_BADGE_BUT_ROOM_PAGE_NOT_CROSS_VERIFIED');
  const ended = { ...roomPage(t.accountName, { http: 429 }), bodyExcerpt: '直播已结束', statusFields: [{ field: 'x.data.room.status', value: 4 }] };
  const d3 = decideDouyin(prof(t.accountName, t.displayDouyinId), ended, t, { offlineRuleValidated: true });
  assert.notEqual(d3.state, 'OFFLINE');
});

test('room id matching the claim is not labelled LIVE_ROOM_ID_CHANGED; a different live room id is', () => {
  const t = { accountName: 'TCL超极玩家', displayDouyinId: 'tclstory', roomId: '546347282056' };
  assert.equal(decideDouyin(prof(t.accountName, t.displayDouyinId, { live: '546347282056' }), roomPage(t.accountName), t).reason, 'PROFILE_LIVE_BADGE_AND_ROOM_PAGE_IDENTITY');
  const d = decideDouyin(prof(t.accountName, t.displayDouyinId, { live: '546300000000' }), roomPage(t.accountName), t);
  assert.equal(d.state, 'LIVE'); assert.equal(d.reason, 'LIVE_ROOM_ID_CHANGED'); assert.equal(d.observedRoomId, '546300000000');
});

test('Tmall HTTP-level throttle (RGV587 / FAIL_SYS_USER_VALIDATE) cools down; it is never a stop', () => {
  for (const codes of [['RGV587_ERROR'], ['FAIL_SYS_TOKEN_EMPTY', 'FAIL_SYS_USER_VALIDATE'], ['FAIL_SYS_TRAFFIC_LIMIT']])
    assert.equal(classifyMtopSequence(codes).kind, 'THROTTLED_OR_VALIDATION');
  const src = fs.readFileSync(new URL('../probes/public-status-probe.mjs', import.meta.url), 'utf8');
  assert.match(src, /state: 'UNKNOWN', reason: 'TMALL_THROTTLED_' \+/);
});
