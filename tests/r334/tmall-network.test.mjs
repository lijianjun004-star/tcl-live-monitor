import test from 'node:test';
import assert from 'node:assert/strict';
import { isLiveDetailUrl, responseLimit, selectTargets, endpointEvidence } from '../../probes/r334/tmall-network.mjs';
const detail = 'https://h5api.m.taobao.com/h5/mtop.mediaplatform.live.livedetail/4.0/';
test('the detail response is recognized with either trailing slash, with strict host', () => {
  assert.equal(isLiveDetailUrl(detail), true);
  assert.equal(isLiveDetailUrl(detail.slice(0, -1)), true);
  assert.equal(isLiveDetailUrl(detail.replace('.com/', '.com.evil.test/')), false);
});
test('core API HTTP limits stop even when the main page was HTTP 200', () => {
  for (const status of [401, 403, 429]) assert.equal(responseLimit({ url: detail, status }), `HTTP_${status}`);
  assert.equal(responseLimit({ url: detail, status: 200 }), null);
  assert.equal(responseLimit({ url: 'https://irrelevant.test/image.png', status: 403 }), null);
  assert.equal(responseLimit({ url: 'https://h5.m.taobao.com/', status: 403, navigation: true }), 'HTTP_403');
});
test('single diagnostic can only select a unique registered shop', () => {
  const targets = [{ key: 'first' }, { key: 'second' }];
  assert.deepEqual(selectTargets(targets, 'second'), [targets[1]]);
  assert.equal(selectTargets(targets, undefined), targets);
  assert.throws(() => selectTargets(targets, 'unregistered'), /NOT_REGISTERED/);
  assert.throws(() => selectTargets([{ key: 'first' }, { key: 'first' }], 'first'), /NOT_REGISTERED/);
});
test('endpoint evidence never includes query strings, tokens or account information', () => {
  assert.deepEqual(endpointEvidence(detail + '?token=secret&data=private', 200), { path: '/h5/mtop.mediaplatform.live.livedetail/4.0/', http: 200 });
  assert.equal(endpointEvidence('https://example.test/private?token=secret', 200), null);
});
