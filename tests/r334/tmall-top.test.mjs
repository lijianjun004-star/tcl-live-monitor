import test from 'node:test';
import assert from 'node:assert/strict';
import { beijingTimestamp, signTopRequest, runTopBatch } from '../../probes/r334/tmall-top.mjs';

const now = new Date('2026-11-16T00:00:00Z');
const env = { TOP_APP_KEY: 'SYNTHETIC_KEY', TOP_APP_SECRET: 'SYNTHETIC_SECRET' };
const targets = [{ key: 'synthetic-a', accountId: '1234567', roomNumber: '555666', scopeApproved: true }];
const id = '888888888881', id2 = '888888888882';
const record = (overrides = {}) => ({ live_id: id, account_id: 1234567, status: 100, room_status: 1, stream_status: 1,
  start_time: 1794787200000, end_time: 0, simple_broad_caster: { account_id: 1234567 }, ...overrides });
const payload = (rows, overrides = {}) => ({ live_batchlives_get_response: { result: {
  success: true, live_list: { live_video_do: rows }, ...overrides,
} } });
const response = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
const run = (data, options = {}) => runTopBatch({ env, targets, liveIdsInput: id, now, fetchFn: async () => response(data), ...options });

test('TOP HMAC-MD5 matches independent fixed Python vectors and ASCII order', () => {
  // Expected values computed independently using Python's hmac + hashlib.md5.
  assert.equal(signTopRequest({ foobar: '4', foo_bar: '3', foo: '1', bar: '2' }, 'synthetic-secret'), 'E49E511B7EBDE4BE8E77C26F4DFAA333');
  const params = { method: 'taobao.live.batchlives.get', app_key: 'SYNTHETIC_KEY', sign_method: 'hmac',
    timestamp: '2026-11-16 08:00:00', v: '2.0', format: 'json', simplify: 'false', live_ids: `${id},${id2}`, type: '1' };
  assert.equal(signTopRequest(params, 'SYNTHETIC_SECRET'), 'A6356BF1A3E78D1B62F6E1DADC4DD4BD');
  assert.equal(signTopRequest({ ...params, sign: 'ignored' }, 'SYNTHETIC_SECRET'), 'A6356BF1A3E78D1B62F6E1DADC4DD4BD');
  assert.equal(signTopRequest({ ...params, empty: '' }, 'SYNTHETIC_SECRET'), 'A6356BF1A3E78D1B62F6E1DADC4DD4BD');
  assert.equal(beijingTimestamp(now), '2026-11-16 08:00:00');
  assert.equal(beijingTimestamp(new Date('2026-11-15T16:00:00Z')), '2026-11-16 00:00:00');
  assert.throws(() => beijingTimestamp('invalid'), /INVALID_NOW/);
  assert.throws(() => signTopRequest({ foo: 1 }, 'secret'), /INVALID_SIGNING_INPUT/);
});

test('missing prerequisites enumerate all blockers without sending requests', async () => {
  let calls = 0;
  const result = await runTopBatch({ targets, now, fetchFn: () => { calls++; throw Error('must not call'); } });
  assert.deepEqual(result.blockers, ['TOP_CREDENTIALS_MISSING', 'LIVE_IDS_MISSING']);
  assert.equal(result.status, 'BLOCKED'); assert.equal(result.exitCode, 2);
  assert.equal(result.credentialsConfigured, false); assert.equal(result.liveIdsConfigured, false);
  assert.equal(result.requestsSent, 0); assert.equal(calls, 0);
});

test('credential aliases use complete pairs and never combine partial pairs', async () => {
  let calls = 0;
  const blocked = await run(payload([record()]), { env: { TOP_APP_KEY: 'KEY', TB_APP_SECRET: 'SECRET' }, fetchFn: () => { calls++; } });
  assert.equal(blocked.credentialsConfigured, false); assert.equal(blocked.requestsSent, 0); assert.equal(calls, 0);
  for (const prefix of ['TOP', 'TAOBAO', 'TMALL', 'TB']) {
    const aliasEnv = { TOP_APP_KEY: 'INCOMPLETE', [`${prefix}_APP_KEY`]: 'ALIAS_KEY', [`${prefix}_APP_SECRET`]: 'ALIAS_SECRET' };
    const verified = await run(payload([record()]), { env: aliasEnv, fetchFn: async url => {
      calls++; assert.equal(new URL(url).searchParams.get('app_key'), 'ALIAS_KEY');
      return response(payload([record()]));
    } });
    assert.equal(verified.status, 'VERIFIED');
  }
  assert.equal(calls, 4);
});

test('only explicit valid live IDs run; account IDs, room numbers and malformed sets are blocked', async () => {
  for (const input of ['', '1234567', '555666', `${id},${id}`, '0', '00123', '-1', '1e5', '0x123', '123,', Array.from({ length: 31 }, (_, i) => String(700000 + i)).join(',')]) {
    const result = await run(payload([record()]), { liveIdsInput: input, fetchFn: () => { throw Error('must not call'); } });
    assert.equal(result.status, 'BLOCKED', input); assert.equal(result.requestsSent, 0, input);
  }
  const unapproved = await run(payload([record()]), { targets: [{ ...targets[0], scopeApproved: false }] });
  assert.equal(unapproved.status, 'BLOCKED'); assert.equal(unapproved.requestsSent, 0);
});

test('one official POST signs both system query and business form without transmitting the secret', async () => {
  let calls = 0;
  const result = await run(payload([record()]), { fetchFn: async (url, options) => {
    calls++;
    const parsed = new URL(url), query = Object.fromEntries(parsed.searchParams), body = Object.fromEntries(new URLSearchParams(options.body));
    assert.equal(parsed.origin + parsed.pathname, 'https://gw.api.taobao.com/router/rest');
    assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit');
    assert.ok(options.signal instanceof AbortSignal);
    assert.deepEqual(body, { live_ids: id, type: '1' });
    assert.equal(query.simplify, 'false'); assert.equal(query.sign_method, 'hmac');
    assert.equal(query.sign, signTopRequest({ ...query, ...body }, env.TOP_APP_SECRET));
    assert.equal(parsed.searchParams.has('live_ids'), false); assert.equal(parsed.searchParams.has('session'), false);
    assert.doesNotMatch(url + JSON.stringify(options), /SYNTHETIC_SECRET/);
    return response(payload([record()]));
  } });
  assert.equal(calls, 1); assert.equal(result.requestsSent, 1); assert.equal(result.status, 'VERIFIED');
  assert.equal(result.verifiedRecordCount, 1); assert.equal(result.verifiedLiveCount, 1); assert.equal(result.exitCode, 0);
  assert.equal(result.observations[0].startTimeUnit, 'UNVERIFIED');
});

test('HTTP 200 business failures and explicit error codes cannot pass even with live records', async () => {
  for (const overrides of [{ success: false }, { success: 'true' }, { error_code: 'isv.invalid-parameter' }, { result_code: { error_code: 22 } }]) {
    const result = await run(payload([record()], overrides));
    assert.equal(result.status, 'REJECTED'); assert.equal(result.exitCode, 3); assert.equal(result.verifiedRecordCount, 0);
  }
  const denied = await run({ error_response: { code: 11, msg: 'PRIVATE_TOKEN', sub_msg: 'PRIVATE_TOKEN' }, ...payload([record()]) });
  assert.equal(denied.reason, 'TOP_PERMISSION_DENIED'); assert.equal(denied.apiErrorCode, 11);
  assert.doesNotMatch(JSON.stringify(denied), /PRIVATE_TOKEN/);
  for (const [code, reason] of [[7, 'TOP_RATE_LIMIT'], [25, 'TOP_SIGNATURE_ERROR'], [29, 'TOP_CREDENTIAL_ERROR'], [31, 'TOP_TIMESTAMP_ERROR'], [41, 'TOP_PARAMETER_ERROR']]) {
    assert.equal((await run({ error_response: { code } })).reason, reason);
  }
});

test('empty and missing records remain UNKNOWN and do not prove an account is offline', async () => {
  const empty = await run(payload([]));
  assert.equal(empty.status, 'PARTIAL'); assert.equal(empty.exitCode, 4); assert.equal(empty.observations[0].sourceState, 'UNKNOWN');
  const missing = await run(payload([record()]), { liveIdsInput: `${id},${id2}` });
  assert.equal(missing.verifiedRecordCount, 1); assert.equal(missing.allRequestedVerified, false);
  assert.equal(missing.observations[1].reason, 'SESSION_NOT_RETURNED');
  assert.doesNotMatch(JSON.stringify(missing), /OFFLINE/);
});

test('unexpected arrays, duplicate or foreign IDs and unsafe numeric IDs fail closed', async () => {
  for (const data of [payload([record(), record()]), payload([record({ live_id: id2 })]),
    payload([record({ live_id: 9007199254740992 })]), payload([record()], { live_list: [record()] }),
    { live_batchlives_get_response: { result: { success: true } } }, null]) {
    const result = await run(data);
    assert.equal(result.status, 'PARTIAL'); assert.equal(result.exitCode, 4); assert.equal(result.verifiedRecordCount, 0);
  }
});

test('wrong, conflicting and unsafe account IDs cannot verify metadata', async () => {
  for (const row of [record({ account_id: 7654321 }), record({ account_id: 9007199254740992 }),
    record({ simple_broad_caster: { account_id: 7654321 } }), record({ simple_broad_caster: { account_id: null } })]) {
    const result = await run(payload([row]));
    assert.equal(result.status, 'PARTIAL'); assert.equal(result.verifiedRecordCount, 0);
    assert.equal(result.observations[0].sourceState, 'UNKNOWN');
    assert.doesNotMatch(JSON.stringify(result), /7654321|9007199254740992/);
  }
});

test('states describe only the requested session and malformed status values stay UNKNOWN', async () => {
  const preview = await run(payload([record({ room_status: 0, stream_status: 0, start_time: 0 })]));
  assert.equal(preview.status, 'VERIFIED'); assert.equal(preview.observations[0].sourceState, 'PREVIEW');
  const replay = await run(payload([record({ room_status: 2, stream_status: 0, end_time: 1794790800000 })]));
  assert.equal(replay.status, 'VERIFIED'); assert.equal(replay.verifiedLiveCount, 0); assert.equal(replay.observations[0].sourceState, 'REPLAY');
  for (const overrides of [{ room_status: null }, { stream_status: [] }, { room_status: true }, { stream_status: ' ' },
    { room_status: 2, stream_status: 1 }, { status: -1 }, { status: null }, { start_time: 'private' }, { end_time: false }]) {
    const result = await run(payload([record(overrides)]));
    assert.equal(result.status, 'PARTIAL'); assert.equal(result.observations[0].sourceState, 'UNKNOWN');
  }
  for (const overrides of [{ start_time: 0 }, { start_time: '0', room_status: 2, stream_status: 0, end_time: 1794790800000 }]) {
    const result = await run(payload([record(overrides)]));
    assert.equal(result.status, 'PARTIAL'); assert.equal(result.observations[0].reason, 'INVALID_SESSION_TIMES');
  }
});

test('output whitelist excludes names, monetary data, media URLs, signatures and credential values', async () => {
  const result = await run(payload([record({ title: 'PRIVATE_NAME', gmv: 'PRIVATE_GMV', live_url: 'https://private.example/PLAY_URL',
    simple_broad_caster: { account_id: 1234567, account_name: 'PRIVATE_NAME' }, extra: { cookie: 'PRIVATE_COOKIE' } })]));
  assert.equal(result.status, 'VERIFIED');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|private\.example|SYNTHETIC_KEY|SYNTHETIC_SECRET|sign=|router\/rest|duration/i);
  assert.deepEqual(Object.keys(result.observations[0]).sort(), ['liveId', 'sourceState', 'reason', 'identityVerified',
    'startTimeRaw', 'startTimeUnit', 'endTimeRaw', 'endTimeUnit', 'key', 'accountId'].sort());
});

test('HTTP failures, redirect rejection and timeouts send one request with static redacted reasons', async () => {
  for (const kind of ['http', 'redirect', 'timeout']) {
    let calls = 0;
    const result = await run(null, { fetchFn: async () => {
      calls++;
      if (kind === 'http') return new Response('PRIVATE_TOKEN', { status: 403 });
      if (kind === 'timeout') throw new DOMException('PRIVATE_TOKEN', 'TimeoutError');
      throw new TypeError('https://secret.example/?sign=PRIVATE_TOKEN');
    } });
    assert.equal(calls, 1); assert.equal(result.requestsSent, 1); assert.equal(result.status, 'REJECTED');
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_TOKEN|secret\.example/);
    assert.equal(result.reason, kind === 'http' ? 'HTTP_REJECTED' : kind === 'timeout' ? 'REQUEST_TIMEOUT' : 'NETWORK_OR_REDIRECT_ERROR');
  }
});

test('declared and streamed response size limits reject before parsing without retries', async () => {
  for (const declared of [true, false]) {
    let calls = 0;
    const result = await run(null, { fetchFn: async () => {
      calls++;
      return new Response('x'.repeat(1_000_001), { headers: declared ? { 'content-length': '1000001' } : {} });
    } });
    assert.equal(result.reason, 'RESPONSE_TOO_LARGE'); assert.equal(result.status, 'REJECTED'); assert.equal(calls, 1);
  }
  const invalid = await run(null, { fetchFn: async () => new Response('<html>PRIVATE_TOKEN</html>') });
  assert.equal(invalid.reason, 'INVALID_RESPONSE_JSON'); assert.doesNotMatch(JSON.stringify(invalid), /PRIVATE_TOKEN/);
});

test('HTTP and declared-length rejections cancel the unused response body', async () => {
  for (const status of [200, 403]) {
    let cancelled = false;
    const result = await run(null, { fetchFn: async () => new Response(new ReadableStream({
      cancel() { cancelled = true; },
    }), { status, headers: status === 200 ? { 'content-length': '1000001' } : {} }) });
    assert.equal(result.status, 'REJECTED'); assert.equal(cancelled, true);
    assert.equal(result.reason, status === 200 ? 'RESPONSE_TOO_LARGE' : 'HTTP_REJECTED');
  }
});
