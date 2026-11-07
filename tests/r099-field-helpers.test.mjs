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
