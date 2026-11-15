import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyTmall } from '../../probes/lib/tmall.mjs';
import { isLimitUrl, toReceiptRow } from '../../probes/r329/tmall-receipt.mjs';

const target = { accountId: '1234567', displayName: 'SYNTH', roomNumber: '555666' };
const payload = overrides => ({ ret: ['SUCCESS::调用成功'], data: {
  accountId: target.accountId, roomNum: target.roomNumber, roomStatus: 1, streamStatus: 1,
  liveId: '900000000001', broadCaster: { accountId: target.accountId, accountName: target.displayName, roomNum: target.roomNumber },
  ...overrides,
} });

test('only explicit numeric status enums can prove live or offline', () => {
  for (const [roomStatus, streamStatus] of [[1, 1], ['1', '1'], [1, '1'], ['1', 1]]) {
    assert.equal(classifyTmall(payload({ roomStatus, streamStatus }), target).state, 'LIVE');
  }
  for (const roomStatus of [0, 2, '0', '2']) {
    for (const streamStatus of [0, '0']) {
      assert.equal(classifyTmall(payload({ roomStatus, streamStatus, liveId: '0' }), target).state, 'OFFLINE');
    }
  }
});

test('missing, coerced and malformed statuses never become offline evidence', () => {
  const invalid = [undefined, null, '', ' ', '\t', false, true, [], [0], [1], {}, { valueOf: () => 1 }, '01', '1.0', ' 1 ', '0x1', -1, 3, NaN, Infinity];
  for (const field of ['roomStatus', 'streamStatus']) {
    for (const value of invalid) {
      const verdict = classifyTmall(payload({ roomStatus: 0, streamStatus: 0, liveId: '0', [field]: value }), target);
      assert.equal(verdict.state, 'UNKNOWN', `${field}=${String(value)}`);
      assert.equal(verdict.reason, 'UNRECOGNIZED_STATUS');
      assert.equal(toReceiptRow('synth', '2026-11-15T00:00:00Z', verdict).offlineEvidence, false);
    }
  }
  assert.equal(classifyTmall(payload({ streamStatus: 2 }), target).state, 'UNKNOWN');
  assert.equal(classifyTmall(payload({ streamStatus: '2' }), target).state, 'UNKNOWN');
});

test('mobile login and platform challenge URLs stop sampling', () => {
  for (const url of [
    'https://login.taobao.com/member/login.jhtml',
    'https://login.m.taobao.com/login.htm',
    'https://login.m.tmall.com/login.htm',
    'https://LOGIN.M.TAOBAO.COM/login.htm',
    'https://login.m.taobao.com./login.htm',
    'https://sec.taobao.com/query.htm',
    'https://h5.m.taobao.com/punish',
    'https://h5.m.taobao.com/_____tmd_____/punish',
    'https://h5.m.taobao.com/captcha',
  ]) assert.equal(isLimitUrl(url), true, url);
});

test('ordinary pages and deceptive external login/challenge names are not platform limit URLs', () => {
  for (const url of [
    'https://h5.m.taobao.com/taolive/video.html?userId=1234567',
    'https://login.m.taobao.com.evil.example/login.htm',
    'https://fakelogin.m.taobao.com/login.htm',
    'https://sec.taobao.com.evil.example/',
    'https://evil.example/captcha?next=https://login.m.taobao.com/',
    'https://login.m.taobao.com@evil.example/',
    'ftp://login.m.taobao.com/',
    'not a url',
  ]) assert.equal(isLimitUrl(url), false, url);
});
