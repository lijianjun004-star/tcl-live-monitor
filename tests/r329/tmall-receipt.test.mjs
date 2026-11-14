// R3.29 Tmall/Taobao daily check: verdict -> receipt row -> ledger -> daily result. Synthetic values only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { classifyTmall } from '../../probes/lib/tmall.mjs';
import { toReceiptRow, isAccessLimit, isLimitUrl } from '../../probes/r329/tmall-receipt.mjs';
import { importReceipt, buildDailyBroadcast } from '../../probes/r322/observation-ledger.mjs';
const t = { key: 'tmall-synth', accountId: '1234567', displayName: 'SYNTH旗舰店', roomNumber: '555666' };
const payload = (o = {}) => ({ ret: ['SUCCESS::调用成功'], data: { accountId: '1234567', roomNum: '555666', roomStatus: 1, streamStatus: 1, liveId: '900000000001', startTime: '1794528000000',
  broadCaster: { accountId: '1234567', accountName: 'SYNTH旗舰店', roomNum: '555666' }, ...o } });
const AT = '2026-11-14T02:00:00Z';
test('live / off / mismatch / error map to safe receipt rows', () => {
  const live = toReceiptRow(t.key, AT, classifyTmall(payload(), t));
  assert.deepEqual([live.state, live.reason, live.profileIdentityVerified, live.roomIdentityVerified, live.offlineEvidence, typeof live.sourceStartTime],
    ['LIVE', 'TMALL_LIVE_DETAIL_ROOM_AND_STREAM_ON', true, true, false, 'string']);
  const off = toReceiptRow(t.key, AT, classifyTmall(payload({ roomStatus: 2, streamStatus: 0, liveId: '0' }), t));
  assert.deepEqual([off.state, off.reason, off.profileIdentityVerified, off.offlineEvidence, off.offlineRuleValidated, off.sourceStartTime],
    ['OFFLINE', 'TMALL_LIVE_DETAIL_ROOM_AND_STREAM_OFF', true, true, false, null]);
  const other = toReceiptRow(t.key, AT, classifyTmall(payload({ broadCaster: { accountId: '7654321', accountName: 'OTHER', roomNum: '555666' } }), t));
  assert.deepEqual([other.state, other.reason, other.profileIdentityVerified, other.roomIdentityVerified], ['UNKNOWN', 'IDENTITY_MISMATCH', false, false]);
  const err = toReceiptRow(t.key, AT, classifyTmall({ ret: ['FAIL_SYS_TOKEN_EMPTY::令牌为空'] }, t));
  assert.deepEqual([err.state, err.reason, err.profileIdentityVerified], ['UNKNOWN', 'API_ERROR', false]);
  assert.deepEqual([toReceiptRow(t.key, AT, null).reason, toReceiptRow(t.key, AT, { state: 'UNKNOWN', reason: 'weird text; 中文' }).reason], ['NO_LIVE_DETAIL_RESPONSE', 'WEIRD_TEXT____']);
  assert.doesNotMatch(JSON.stringify([live, off, other, err]), /SYNTH旗舰店|1234567|555666|900000000001|OTHER"/);
});
test('access-limit signals', () => {
  assert.equal(isAccessLimit({ apiRet: ['RGV587_ERROR'] }), true);
  assert.equal(isAccessLimit({ apiRet: ['FAIL_SYS_USER_VALIDATE'] }), true);
  assert.equal(isAccessLimit({ apiRet: ['FAIL_SYS_TOKEN_EMPTY'] }), false);   // normal token handshake of the page
  assert.equal(isAccessLimit(null), false);
  assert.equal(isLimitUrl('https://login.taobao.com/member/login.jhtml'), true);
  assert.equal(isLimitUrl('https://h5.m.taobao.com/taolive/video.html?userId=1'), false);
  assert.equal(isLimitUrl('not a url'), false);
});
test('ledger and daily result: LIVE counts; API "off" stays not-seen (rule not validated), never "did not broadcast"', () => {
  const rec = rows => ({ schemaVersion: 319, at: '2026-11-14T02:00:30Z', checked: rows });
  const l = importReceipt(null, rec([toReceiptRow('tmall-a', AT, classifyTmall(payload(), t)),
    toReceiptRow('tmall-b', '2026-11-14T02:00:05Z', classifyTmall(payload({ roomStatus: 0, streamStatus: 0, liveId: '0' }), t)),
    toReceiptRow('tmall-c', '2026-11-14T02:00:10Z', null)]), { platform: 'tmall', evidenceKind: 'synthetic' });
  const d = Object.fromEntries(buildDailyBroadcast(l).map(x => [x.key, [x.platform, x.status, x.evidence, x.verifiedSamples]]));
  assert.deepEqual(d, { 'tmall-a': ['tmall', 'BROADCAST_SEEN', 'PROFILE_AND_ROOM_PAGE_IDENTITY', 1], 'tmall-b': ['tmall', 'NOT_SEEN_IN_SAMPLES', null, 1], 'tmall-c': ['tmall', 'UNKNOWN', null, 0] });
  assert.deepEqual(l.observations.find(o => o.key === 'tmall-b').state, 'UNKNOWN');
});
test('probe and workflow shape', { skip: !fs.existsSync('.github/workflows/tmall-daily-broadcast.yml') }, () => {
  const src = fs.readFileSync('probes/r329/tmall-daily-once.mjs', 'utf8');
  assert.doesNotMatch(src, /addCookies|setExtraHTTPHeaders|userAgent|storageState|\.fill\(|\.click\(|\.type\(/);
  assert.match(src, /if \(stopped\) \{ checked\.push\(\{ key: t\.key, at: new Date\(\)\.toISOString\(\), state: 'NOT_RUN'/);
  const wf = fs.readFileSync('.github/workflows/tmall-daily-broadcast.yml', 'utf8');
  assert.match(wf, /\n  workflow_dispatch:\npermissions:\n  contents: read\n  actions: read\n/);
  assert.doesNotMatch(wf, /pull_request|\n  push:|contents: write|secrets\./);
  assert.match(wf, /if: github\.ref == 'refs\/heads\/main'/); assert.match(wf, /age<24\*3600e3/); assert.match(wf, /--platform tmall/);
});
test('Douyin monitor-only sets: approved, registered room, not scoring, no overlap with the scoring sets', () => {
  const reg = JSON.parse(fs.readFileSync('config/probe-targets.json', 'utf8')).douyin;
  const read = f => JSON.parse(fs.readFileSync(f, 'utf8'));
  const c = read('config/r329-douyin-targets-monitor-c.json'), d = read('config/r329-douyin-targets-monitor-d.json');
  const scoring = [...read('config/r316-douyin-rpa-targets.json').targets, ...read('config/r326-douyin-targets-scoring-b.json').targets].map(x => x.key);
  for (const set of [c, d]) { assert.equal(set.maxPerRun, 2); assert.ok(set.targets.length >= 1 && set.targets.length <= 2);
    for (const x of set.targets) { assert.deepEqual(Object.keys(x), ['key']); const e = reg.find(r => r.key === x.key);
      assert.ok(e?.scopeApproved === true && e?.scoringEligible !== true && e?.roomId && !scoring.includes(x.key)); } }
  assert.equal(new Set([...c.targets, ...d.targets].map(x => x.key)).size, 3);
});
