// R3.24: offline tests for the raw-HTML calibration diagnostics added after approved run 43454668656.
// That run reached the account's own room page, but its JS/CSS all come from hosts outside the two
// approved CDNs, so the page never rendered (empty title, no meta, no owner link). The next question is
// whether the RAW server HTML already carries owner identity and live status. All values are synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { documentShape } from '../../probes/lib/douyin.mjs';

const t = { accountName: 'SYNTH_ACCOUNT', displayDouyinId: 'synth_id_01', roomId: '20000000002',
  profileUrl: 'https://www.douyin.com/user/SYNTHETIC_SEC_UID_0001' };
const SECRETS = ['SYNTH_ACCOUNT', 'synth_id_01', '20000000002', 'SYNTHETIC_SEC_UID_0001', 'SECRET_TITLE_TEXT'];
const renderData = obj => `<script id="RENDER_DATA" type="application/json">${encodeURIComponent(JSON.stringify(obj))}</script>`;
const pace = obj => `<script>(self.__pace_f=self.__pace_f||[]).push([1,${JSON.stringify(JSON.stringify(obj))}])</script>`;
const room = { roomInfo: { web_rid: '20000000002', room: { status: 2, owner: { sec_uid: 'SYNTHETIC_SEC_UID_0001', nickname: 'SYNTH_ACCOUNT' } } } };
const noLeak = shape => { const s = JSON.stringify(shape); for (const x of SECRETS) assert.ok(!s.includes(x), 'value leaked into shape'); };

test('RENDER_DATA (URL-encoded JSON): owner id, room id, name and live status found; only key names kept', () => {
  const shape = documentShape(`<html><head><title></title></head><body>${renderData({ app: room })}</body></html>`, t);
  assert.equal(shape.renderData, true); assert.equal(shape.renderDataDecoded, true); assert.equal(shape.titleTagEmpty, true);
  assert.equal(shape.secUid.count, 1); assert.deepEqual(shape.secUid.contexts[0].slice(-3), ['status', 'owner', 'sec_uid']);
  assert.deepEqual(shape.roomId.contexts[0].slice(-1), ['web_rid']);
  assert.deepEqual(shape.accountName.contexts[0].slice(-1), ['nickname']);
  assert.deepEqual(shape.status.map(s => [s.key, s.value, s.before.slice(-2)]), [['status', 2, ['web_rid', 'room']]]);
  noLeak(shape);
});

test('streamed pace chunk (JSON inside a JS string): same signals after one level of unescaping', () => {
  const shape = documentShape(`<title>SYNTH_ACCOUNT的抖音直播间 - 抖音直播</title>${pace({ ...room, roomInfo: { ...room.roomInfo, room: { ...room.roomInfo.room, status: 4 } } })}`, t);
  assert.equal(shape.paceScripts, 1); assert.equal(shape.renderData, false);
  assert.equal(shape.titleTagHasName, true); assert.equal(shape.titleTagEmpty, false);
  assert.deepEqual(shape.secUid.contexts[0].slice(-1), ['sec_uid']);
  assert.deepEqual(shape.status.map(s => s.value), [4]);
  noLeak(shape);
});

test('bounded and fail-safe: empty, malformed, huge or hostile input never throws or leaks', () => {
  for (const bad of [undefined, null, 42, '', '<script id="RENDER_DATA">%E0%A4%A</script>']) {
    const s = documentShape(bad, t);
    assert.equal(s.secUid.count, 0); assert.deepEqual(s.status, []);
  }
  assert.equal(documentShape('<script id="RENDER_DATA">%E0%A4%A</script>', t).renderDataDecoded, false);
  const many = documentShape(('"status":2,"owner":{"sec_uid":"SYNTHETIC_SEC_UID_0001"},').repeat(500), t);
  assert.equal(many.status.length, 16); assert.equal(many.secUid.count, 200); assert.equal(many.secUid.contexts.length, 5);
  for (const c of many.secUid.contexts) { assert.ok(c.length <= 8); for (const k of c) assert.match(k, /^[A-Za-z_]{2,24}$/); }
  // keys made of an id, digits or text never become a "key name"
  const hostile = documentShape('{"MS4wLjABAAAA9x":1,"直播中":2,"SECRET_TITLE_TEXT_0":3,"owner":{"sec_uid":"SYNTHETIC_SEC_UID_0001"}}', t);
  assert.deepEqual(hostile.secUid.contexts[0], ['owner', 'sec_uid']);
  noLeak(hostile);
  // short needles (< 4 chars) are never searched
  assert.equal(documentShape('abc abc', { ...t, accountName: 'abc' }).accountName.count, 0);
});

test('probe: raw HTML goes through documentShape at once and only into the private record', () => {
  const src = fs.readFileSync('probes/r316/douyin-rpa-two-once.mjs', 'utf8');
  assert.match(src, /const html = target && resp \? await resp\.text\(\)\.catch\(\(\) => ''\) : '';\n    const doc = target && resp \? documentShape\(html, target\) : null;/);
  assert.equal((src.match(/resp\.text\(/g) || []).length, 1, 'raw HTML read once, never kept');
  const pubBlock = /pub\.push\(\{ key: t\.key, at, profileHttp[\s\S]*?\}\);/.exec(src)?.[0];
  assert.doesNotMatch(pubBlock, /\bdoc\b|Doc\b|blockedStaticHosts/);
  const privBlock = /priv\.push\(\{[\s\S]*?\}\);/.exec(src)?.[0];
  assert.match(privBlock, /profileDoc: profile\.doc \?\? null, roomDoc: room\?\.doc \?\? null/);
  // exact hostnames of blocked JS/CSS: private file only; the public tally keeps fixed anonymous classes
  assert.match(src, /writeFile\('out\/r316-private\/rpa\.json', JSON\.stringify\(\{ at: new Date\(\)\.toISOString\(\), priv,\n    blockedStaticHosts:/);
  assert.match(src, /hostClass\(info\.url\)/);
  const publicFile = /writeFile\('out\/r316-rpa-public\.json'[\s\S]*?\);/.exec(src)?.[0];
  assert.doesNotMatch(publicFile, /blockedStaticHosts|\bdoc\b/);
  for (const line of src.split('\n').filter(l => l.includes('console.log'))) assert.doesNotMatch(line, /blockedStaticHosts|\.doc\b/);
});
