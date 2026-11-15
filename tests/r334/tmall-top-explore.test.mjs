import test from 'node:test';
import assert from 'node:assert/strict';
import { signTopRequest } from '../../probes/r334/tmall-top.mjs';
import { runTopExplore, analyzeStructure, VENUE_METHOD, CONTENTS_METHOD } from '../../probes/r334/tmall-top-explore.mjs';

const now = new Date('2026-11-16T00:00:00Z'); // 2026-11-16 08:00 in Beijing, so "yesterday" is 20261115
const env = { TOP_APP_KEY: 'SYNTHETIC_KEY', TOP_APP_SECRET: 'SYNTHETIC_SECRET' };
const targets = [
  { key: 'synthetic-a', accountId: '1234567', roomNumber: '555666', scopeApproved: true },
  { key: 'synthetic-b', accountId: '2345678', scopeApproved: true },
  { key: 'synthetic-c', accountId: '3456789', scopeApproved: true },
];
const response = data => new Response(typeof data === 'string' ? data : JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
const run = (mode, data, options = {}) => runTopExplore({ mode, env, targets, now, fetchFn: async () => response(data), ...options });
const never = () => { throw Error('must not call'); };
const LEAKS = /PRIVATE_|private\.example|SYNTHETIC_KEY|SYNTHETIC_SECRET|sign=|router\/rest|OFFLINE/;

const venueItem = (overrides = {}) => ({ live_id: 888888888881, account_id: 1234567,
  live_info: { room_status: 1, stream_status: 1, start_time: 1794787200, title: 'PRIVATE_TITLE', cover_url: 'https://private.example/COVER',
    play_url: 'https://private.example/PLAY_URL', viewers: 'PRIVATE_COUNT' },
  anchor_nick: 'PRIVATE_NAME', items: [{ item_id: 5551, title: 'PRIVATE_PRODUCT', price: 'PRIVATE_PRICE' }],
  rec_reason_infos: [{ start_time: 1794787200000, end_time: 1794790800000, reason: 'PRIVATE_REASON' }], ...overrides });
const venue = (list, result = {}) => ({ alibaba_taobao_live_recommend_alipay_query_response: {
  result: { success: true, data: { alipay_venue_list: list }, ...result }, request_id: 'PRIVATE_REQUEST' } });
const content = (overrides = {}) => ({ liveId: '777000000001', anchorId: '1234567', status: 1, startTime: 1794787200000, endTime: 0,
  title: 'PRIVATE_TITLE', link: 'https://private.example/LIVE', ...overrides });
const contents = (items, model = {}) => ({ taobao_live_contents_query_response: { model: {
  data_json_str: JSON.stringify(items), total_count: 1234, msg_code: 200, success: true, ...model } } });

test('missing prerequisites and invalid modes enumerate blockers without sending anything', async () => {
  const empty = await runTopExplore({ mode: 'venue', targets, now, fetchFn: never });
  assert.deepEqual(empty.blockers, ['TOP_CREDENTIALS_MISSING']);
  assert.equal(empty.status, 'BLOCKED'); assert.equal(empty.exitCode, 2); assert.equal(empty.requestsSent, 0);
  assert.equal(empty.credentialsConfigured, false);
  for (const mode of [undefined, '', 'venues', '__proto__', 'constructor', 7]) {
    const result = await runTopExplore({ mode, env, targets, now, fetchFn: never });
    assert.deepEqual(result.blockers, ['MODE_INVALID'], String(mode)); assert.equal(result.requestsSent, 0); assert.equal(result.method, null);
  }
  const noTargets = await runTopExplore({ mode: 'contents', env, targets: [{ ...targets[0], scopeApproved: false }], now, fetchFn: never });
  assert.ok(noTargets.blockers.includes('APPROVED_TARGETS_INVALID_OR_MISSING')); assert.equal(noTargets.requestsSent, 0);
  const badNow = await runTopExplore({ mode: 'contents', env, targets, now: 'not a date', fetchFn: never });
  assert.ok(badNow.blockers.includes('INVALID_NOW')); assert.equal(badNow.requestsSent, 0);
  const noFetch = await runTopExplore({ mode: 'contents', env, targets, now, fetchFn: null });
  assert.deepEqual(noFetch.blockers, ['FETCH_UNAVAILABLE']);
  const partial = await runTopExplore({ mode: 'venue', env: { TOP_APP_KEY: 'KEY', TB_APP_SECRET: 'SECRET' }, targets, now, fetchFn: never });
  assert.equal(partial.credentialsConfigured, false); assert.equal(partial.requestsSent, 0);
  assert.doesNotMatch(JSON.stringify([empty, partial]), /KEY|SECRET/);
});

test('venue probe sends one signed POST that lists only the registered accounts', async () => {
  let calls = 0;
  const result = await run('venue', venue([]), { fetchFn: async (url, options) => {
    calls++;
    const parsed = new URL(url), query = Object.fromEntries(parsed.searchParams), body = Object.fromEntries(new URLSearchParams(options.body));
    assert.equal(parsed.origin + parsed.pathname, 'https://gw.api.taobao.com/router/rest');
    assert.equal(query.method, VENUE_METHOD); assert.equal(VENUE_METHOD, 'alibaba.taobao.live.recommend.alipay.query');
    assert.deepEqual(Object.keys(body), ['alipay_venue_query_param']);
    assert.deepEqual(JSON.parse(body.alipay_venue_query_param), { anchor_id_list: [1234567, 2345678, 3456789] });
    assert.equal(query.sign, signTopRequest({ ...query, ...body }, env.TOP_APP_SECRET));
    assert.equal(query.simplify, 'false'); assert.equal(query.sign_method, 'hmac');
    assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit');
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(parsed.searchParams.has('alipay_venue_query_param'), false); assert.equal(parsed.searchParams.has('session'), false);
    assert.doesNotMatch(url + JSON.stringify(options), /SYNTHETIC_SECRET/);
    return response(venue([]));
  } });
  assert.equal(calls, 1); assert.equal(result.requestsSent, 1); assert.equal(result.status, 'EXPLORED'); assert.equal(result.exitCode, 0);
  assert.deepEqual(result.request, { registeredAccountCount: 3, scene: null, liveSource: null, ruleCode: null, count: null, page: null });
});

test('venue options are validated and only validated values reach the request', async () => {
  let body;
  const ok = await run('venue', venue([]), { options: { scene: 'alipay.top.anchor', liveSource: 'alipay.venue', ruleCode: '11866001', count: '30', page: ' 2 ' },
    fetchFn: async (url, options) => { body = Object.fromEntries(new URLSearchParams(options.body)); return response(venue([])); } });
  assert.equal(ok.status, 'EXPLORED');
  assert.deepEqual(JSON.parse(body.alipay_venue_query_param), { anchor_id_list: [1234567, 2345678, 3456789], scene: 'alipay.top.anchor',
    live_source: 'alipay.venue', recommend_rule_code: '11866001', n: 30, s: 2 });
  assert.deepEqual(ok.request, { registeredAccountCount: 3, scene: 'alipay.top.anchor', liveSource: 'alipay.venue', ruleCode: '11866001', count: 30, page: 2 });
  for (const options of [{ scene: 'two words' }, { scene: '../x' }, { liveSource: 'x'.repeat(65) }, { ruleCode: 'a=b&c=d' }, { count: '0' }, { count: '101' },
    { count: '1.5' }, { page: '0' }, { page: 'x' }, { page: '1001' }, { scene: 'https://private.example' }]) {
    const result = await run('venue', venue([]), { options, fetchFn: never });
    assert.equal(result.status, 'BLOCKED', JSON.stringify(options)); assert.equal(result.requestsSent, 0);
    assert.match(result.blockers[0], /^OPTIONS_INVALID:(scene|liveSource|ruleCode|count|page)$/);
    assert.doesNotMatch(JSON.stringify(result), LEAKS);
  }
});

test('contents probe defaults to yesterday in Beijing and validates the query window', async () => {
  let body;
  const record = async (url, options) => { body = Object.fromEntries(new URLSearchParams(options.body)); return response(contents([])); };
  const defaults = await run('contents', null, { fetchFn: record });
  assert.equal(defaults.status, 'EXPLORED'); assert.equal(CONTENTS_METHOD, 'taobao.live.contents.query');
  assert.deepEqual(Object.keys(body), ['query_request']);
  assert.deepEqual(JSON.parse(body.query_request), { query_date: '20261115', start: 0, page_size: 20 });
  assert.deepEqual(defaults.request, { queryDate: '20261115', start: 0, pageSize: 20 });
  const explicit = await run('contents', null, { options: { queryDate: '20261110', start: '40', pageSize: '100' }, fetchFn: record });
  assert.deepEqual(JSON.parse(body.query_request), { query_date: '20261110', start: 40, page_size: 100 });
  assert.equal(explicit.status, 'EXPLORED');
  const today = await run('contents', null, { options: { queryDate: '20261116' }, fetchFn: record });
  assert.equal(today.status, 'EXPLORED');
  // At 23:30 UTC the Beijing date has already rolled over; the default follows Beijing, not UTC.
  const lateUtc = await run('contents', null, { now: new Date('2026-11-15T23:30:00Z'), fetchFn: record });
  assert.equal(lateUtc.request.queryDate, '20261115');
  for (const options of [{ queryDate: '20261117' }, { queryDate: '20260230' }, { queryDate: '2026-11-10' }, { queryDate: 'abc' }, { queryDate: '19991231' },
    { pageSize: '0' }, { pageSize: '101' }, { pageSize: 'x' }, { start: '-1' }, { start: '1000001' }, { start: '1.5' }]) {
    const result = await run('contents', null, { options, fetchFn: never });
    assert.equal(result.status, 'BLOCKED', JSON.stringify(options)); assert.equal(result.requestsSent, 0);
    assert.match(result.blockers[0], /^OPTIONS_INVALID:(queryDate|start|pageSize)$/);
  }
});

test('venue receipt keeps structure and registered hits only, never values of other accounts or media', async () => {
  const data = venue([venueItem(), venueItem({ live_id: 888888888882, account_id: 9999999, anchor_nick: 'PRIVATE_OTHER' }),
    venueItem({ live_id: 888888888883, account_id: 2345678 })]);
  const result = await run('venue', data);
  assert.equal(result.status, 'EXPLORED'); assert.equal(result.reason, 'STRUCTURE_RECORDED'); assert.equal(result.exitCode, 0);
  assert.equal(result.rootKey, 'alibaba_taobao_live_recommend_alipay_query_response');
  assert.deepEqual(result.registeredHits.map(hit => hit.key), ['synthetic-a', 'synthetic-b']);
  assert.deepEqual(result.registeredHits[0], { key: 'synthetic-a', accountId: '1234567',
    path: 'alibaba_taobao_live_recommend_alipay_query_response.result.data.alipay_venue_list[]', matchedFields: ['account_id'],
    ids: { live_id: '888888888881', account_id: '1234567' },
    enums: { 'live_info.room_status': '1', 'live_info.stream_status': '1' },
    times: { 'live_info.start_time': { form: 'INTEGER', digits: 10, unitEvidence: 'LIKELY_SECONDS' } } });
  assert.equal(result.registeredHits[1].ids.live_id, '888888888883');
  assert.deepEqual(result.registeredWithoutRecord, ['synthetic-c']); assert.equal(result.otherAccountCount, 1);
  const text = JSON.stringify(result);
  assert.doesNotMatch(text, LEAKS); assert.doesNotMatch(text, /9999999|888888888882/);
  // Recommendation-reason times sit inside a list, which is described in the shape but never read as session times.
  assert.doesNotMatch(JSON.stringify(result.registeredHits), /rec_reason_infos|1794790800000/);
  const listShape = result.shape.alibaba_taobao_live_recommend_alipay_query_response.result.data.alipay_venue_list;
  assert.equal(listShape.$array, 3); assert.equal(listShape.$items.live_info.title, 'string'); assert.equal(listShape.$items.rec_reason_infos.$items.start_time, 'integer');
  assert.equal(listShape.$items.account_id, 'integer'); assert.equal(result.notes.length, 4);
});

test('a registered account is matched wherever its ID appears, and sibling records never leak into a hit', async () => {
  const data = venue([
    { live_id: 111000000001, account_id: 8888881, status: 1, note: 'PRIVATE_NEIGHBOUR' },
    { live_id: 888888888884, anchor: { account_id: 3456789 }, co_host: { account_id: 8888882, anchor_id: 8888883 }, room_id: '9000001', status: 'LIVING', type: 'PRIVATE TEXT WITH SPACES' },
    { live_id: 111000000002, account_id: 8888884, status: 2, note: 'PRIVATE_NEIGHBOUR' },
  ]);
  const result = await run('venue', data);
  assert.equal(result.registeredHits.length, 1);
  const hit = result.registeredHits[0];
  assert.equal(hit.key, 'synthetic-c'); assert.deepEqual(hit.matchedFields, ['anchor.account_id']);
  assert.deepEqual(hit.ids, { live_id: '888888888884', 'anchor.account_id': '3456789', 'co_host.account_id': 'OTHER_ACCOUNT',
    'co_host.anchor_id': 'OTHER_ACCOUNT', room_id: '9000001' });
  assert.deepEqual(hit.enums, { status: 'LIVING', type: 'OTHER' });
  assert.equal(result.otherAccountCount, 4); // 8888881, 8888882, 8888883 and 8888884, counted but never listed
  assert.doesNotMatch(JSON.stringify(result), /1110000000|(?<!\d)888888[1234](?!\d)|PRIVATE/);
  // Matching is by value, so the same account found under an unexpected field name is reported with that field name.
  const renamed = analyzeStructure({ x_response: { rows: [{ whoever: 1234567, live: 5000001 }] } }, new Map([['1234567', { key: 'synthetic-a', accountId: '1234567' }]]));
  assert.deepEqual(renamed.hits[0].matchedFields, ['whoever']); assert.equal(renamed.hits[0].path, 'x_response.rows[]');
});

test('contents probe parses data_json_str, records scope fields and keeps only registered session facts', async () => {
  const items = [content(), content({ liveId: '777000000002', anchorId: '5555555', title: 'PRIVATE_OTHER' }), content({ liveId: '777000000003', anchorId: 2345678, status: 2, endTime: 1794790800000 })];
  const result = await run('contents', contents(items));
  assert.equal(result.status, 'EXPLORED'); assert.equal(result.rootKey, 'taobao_live_contents_query_response');
  assert.deepEqual(result.envelope, { 'taobao_live_contents_query_response.model.total_count': 1234,
    'taobao_live_contents_query_response.model.msg_code': 200, 'taobao_live_contents_query_response.model.success': true });
  const inner = result.shape.taobao_live_contents_query_response.model.data_json_str.$json;
  assert.equal(inner.$array, 3); assert.equal(inner.$items.liveId, 'string'); assert.equal(inner.$items.startTime, 'integer');
  assert.deepEqual(result.registeredHits.map(hit => [hit.key, hit.ids.liveId, hit.ids.anchorId]), [['synthetic-a', '777000000001', '1234567'], ['synthetic-b', '777000000003', '2345678']]);
  assert.equal(result.registeredHits[0].path, 'taobao_live_contents_query_response.model.data_json_str.$json[]');
  assert.deepEqual(result.registeredHits[0].times, { startTime: { form: 'INTEGER', digits: 13, unitEvidence: 'LIKELY_MILLISECONDS' }, endTime: { form: 'INTEGER_ZERO', digits: null, unitEvidence: null } });
  assert.deepEqual(result.registeredHits[0].enums, { status: '1' }); assert.equal(result.otherAccountCount, 1);
  assert.doesNotMatch(JSON.stringify(result), LEAKS); assert.doesNotMatch(JSON.stringify(result), /5555555|777000000002/);
  assert.deepEqual(result.registeredWithoutRecord, ['synthetic-c']);
  // A string that only looks like JSON stays an ordinary string.
  const plain = await run('contents', contents('[not json', { data_json_str: '{PRIVATE_BROKEN' }));
  assert.equal(plain.shape.taobao_live_contents_query_response.model.data_json_str, 'string');
});

test('registered accounts that are not returned stay UNKNOWN and are never called offline', async () => {
  const none = await run('venue', venue([]));
  assert.equal(none.status, 'EXPLORED'); assert.deepEqual(none.registeredWithoutRecord, ['synthetic-a', 'synthetic-b', 'synthetic-c']);
  assert.deepEqual(none.registeredHits, []); assert.equal(none.otherAccountCount, 0);
  assert.match(none.notes.join(' '), /UNKNOWN/);
  const foreign = await run('venue', venue([venueItem({ account_id: 6666666 })]));
  assert.deepEqual(foreign.registeredHits, []); assert.equal(foreign.otherAccountCount, 1);
  // The static notes may say "does not prove ... offline"; no field of the receipt may state or imply it.
  assert.doesNotMatch(JSON.stringify([none, foreign].map(item => ({ ...item, notes: undefined }))), /6666666|offline/i);
});

test('platform errors, HTTP failures and timeouts send one request with static redacted reasons', async () => {
  for (const [payload, reason, code, sub] of [[{ error_response: { code: 11, msg: 'PRIVATE_TOKEN', sub_msg: 'PRIVATE_TOKEN' } }, 'TOP_PERMISSION_DENIED', 11],
    [{ error_response: { code: 13 } }, 'TOP_PERMISSION_DENIED', 13], [{ error_response: { code: 7, sub_code: 'accesscontrol.limited' } }, 'TOP_RATE_LIMIT', 7, 'accesscontrol.limited'],
    [{ error_response: { code: 50, sub_code: 'isv.invalid-parameter', sub_msg: 'PRIVATE_TOKEN' } }, 'TOP_PARAMETER_ERROR', 50, 'isv.invalid-parameter'],
    [{ error_response: { code: 50, sub_code: 'other.error' } }, 'TOP_API_ERROR', 50, 'other.error']]) {
    let calls = 0;
    const result = await run('venue', payload, { fetchFn: async () => { calls++; return response(payload); } });
    assert.equal(calls, 1); assert.equal(result.requestsSent, 1); assert.equal(result.status, 'REJECTED'); assert.equal(result.exitCode, 3);
    assert.equal(result.reason, reason); assert.equal(result.apiErrorCode, code); assert.equal(result.apiSubCode, sub);
    assert.equal('shape' in result, false); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_TOKEN/);
  }
  for (const kind of ['http', 'redirect', 'timeout']) {
    let calls = 0;
    const result = await run('contents', null, { fetchFn: async () => {
      calls++;
      if (kind === 'http') return new Response('PRIVATE_TOKEN', { status: 403 });
      if (kind === 'timeout') throw new DOMException('PRIVATE_TOKEN', 'TimeoutError');
      throw new TypeError('https://secret.example/?sign=PRIVATE_TOKEN');
    } });
    assert.equal(calls, 1); assert.equal(result.requestsSent, 1); assert.equal(result.status, 'REJECTED');
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_TOKEN|secret\.example/);
    assert.equal(result.reason, kind === 'http' ? 'HTTP_REJECTED' : kind === 'timeout' ? 'REQUEST_TIMEOUT' : 'NETWORK_OR_REDIRECT_ERROR');
  }
  const large = await run('contents', null, { fetchFn: async () => new Response('x'.repeat(1_000_001)) });
  assert.equal(large.reason, 'RESPONSE_TOO_LARGE'); assert.equal(large.requestsSent, 1);
  const html = await run('contents', null, { fetchFn: async () => new Response('<html>PRIVATE_TOKEN</html>') });
  assert.equal(html.reason, 'INVALID_RESPONSE_JSON'); assert.doesNotMatch(JSON.stringify(html), /PRIVATE_TOKEN/);
});

test('business failure flags and unrecognized roots still keep the structure that was observed', async () => {
  const rejected = await run('venue', venue([venueItem()], { success: false }));
  assert.equal(rejected.status, 'REJECTED'); assert.equal(rejected.reason, 'TOP_BUSINESS_REJECTED'); assert.equal(rejected.exitCode, 3);
  assert.ok(rejected.shape); assert.equal(rejected.requestsSent, 1);
  const coded = await run('contents', contents([], { error_code: 'isv.invalid-parameter' }));
  assert.equal(coded.status, 'REJECTED'); assert.equal(coded.reason, 'TOP_BUSINESS_ERROR');
  assert.equal((await run('contents', contents([], { error_code: 0 }))).status, 'EXPLORED');
  assert.equal((await run('contents', contents([], { error_code: '0' }))).status, 'EXPLORED');
  for (const payload of [{ unexpected: { rows: [] } }, { a_response: {}, b_response: {} }, {}]) {
    const result = await run('venue', payload);
    assert.equal(result.status, 'PARTIAL'); assert.equal(result.reason, 'TOP_RESPONSE_ROOT_UNRECOGNIZED'); assert.equal(result.exitCode, 4);
    assert.equal(result.rootKey, null); assert.ok(result.shape !== undefined);
  }
  for (const body of ['[]', '"text"', '7', 'null']) {
    const result = await run('venue', body);
    assert.equal(result.status, 'PARTIAL'); assert.equal(result.reason, 'TOP_RESPONSE_SCHEMA_INVALID'); assert.equal(result.requestsSent, 1);
  }
});

test('dynamic, unsafe and excessive keys are counted rather than printed', async () => {
  const many = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`field${i}`, i]));
  // JSON.stringify would drop or rewrite some of these keys, so the odd object is written as raw JSON text.
  const odd = '{"https://private.example/x":1,"PRIVATE KEY WITH SPACES":2,"12345":3,"__proto__":{"PRIVATE_PROTO":1},"_hidden":5,"ok_key":6}';
  const text = `{"x_response":{"odd":${odd},"many":${JSON.stringify(many)}}}`;
  const result = await run('venue', text);
  assert.equal(result.status, 'EXPLORED');
  const shape = result.shape.x_response;
  assert.deepEqual(shape.odd, { ok_key: 'integer', $otherKeys: 5 });
  assert.equal(shape.many.$omittedKeys, 40); assert.equal(Object.keys(shape.many).length, 61);
  assert.doesNotMatch(JSON.stringify(result), /private\.example|PRIVATE|12345|_hidden/);
  assert.equal(Object.getPrototypeOf(result.shape), Object.prototype); assert.equal({}.PRIVATE_PROTO, undefined);
});

test('large, deep or hostile payloads are bounded and still produce a compact receipt', async () => {
  let deep = { account_id: 1234567 };
  for (let i = 0; i < 40; i++) deep = { [`level${i}`]: deep };
  const wide = Array.from({ length: 5000 }, (_, i) => ({ id: i + 1, account_id: 7000000 + i }));
  const result = await run('venue', { big_response: { deep, wide } });
  assert.equal(result.status, 'EXPLORED'); assert.equal(result.shapeTruncated, true);
  assert.ok(JSON.stringify(result).length < 150_000, 'receipt must stay small');
  assert.equal(result.shape.big_response.wide.$array, 5000); assert.equal(result.otherAccountCount, 5000);
  assert.deepEqual(result.registeredHits, []);
  // JSON nested inside JSON strings is only unwrapped a few levels.
  let nested = '{"account_id":1234567}';
  for (let i = 0; i < 8; i++) nested = JSON.stringify({ inner: nested });
  const strings = await run('venue', { s_response: { payload: nested } });
  assert.equal(strings.status, 'EXPLORED'); assert.ok(JSON.stringify(strings.shape).length < 2000);
  assert.deepEqual(strings.registeredHits, []);
  // Distinct unregistered accounts are counted up to a cap; recorded hits are capped as well.
  const many = Array.from({ length: 5100 }, (_, i) => ({ account_id: 4000000 + i }));
  const capped = await run('venue', { m_response: { rows: many } });
  assert.equal(capped.otherAccountCount, 5000); assert.equal(capped.otherAccountCountCapped, true);
  const mine = await run('venue', { m_response: { rows: Array.from({ length: 150 }, (_, i) => ({ account_id: 1234567, live_id: 2000000 + i })) } });
  assert.equal(mine.registeredHits.length, 100); assert.equal(mine.registeredHitsOmitted, 50); assert.deepEqual(mine.registeredWithoutRecord, ['synthetic-b', 'synthetic-c']);
});

test('unsafe numeric IDs are reported by form, not guessed', async () => {
  const text = '{"x_response":{"rows":[{"live_id":9007199254740993,"account_id":1234567,"room_status":1.5,"start_time":"PRIVATE_TIME"}]}}';
  const result = await run('venue', text);
  const [hit] = result.registeredHits;
  assert.equal(hit.ids.live_id, 'NUMBER_UNSAFE'); assert.equal(hit.enums.room_status, 'OTHER');
  assert.deepEqual(hit.times.start_time, { form: 'STRING_OTHER', digits: null, unitEvidence: null });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|9007199254740/);
});

test('values of a nested record that names another account never enter a registered hit', async () => {
  // A co-host or guest record inside a registered account's session is another account's data, however deeply it nests.
  const coHost = await run('venue', venue([{ live_id: 111000000011, account_id: 1234567, live_info: { room_status: 1, stream_status: 1 },
    anchor: { account_id: 1234567 },
    co_host: { account_id: 9999999, live_id: 888888, status: 3, live_info: { room_status: 0, stream_status: 0, start_time: 1794787200 },
      deep: { room_id: '9000009', type: 'PRIVATE_TYPE' } } }]));
  const [hit] = coHost.registeredHits;
  assert.equal(hit.ids.live_id, '111000000011'); assert.equal(hit.ids['anchor.account_id'], '1234567');
  assert.deepEqual(Object.keys(hit.ids).filter(key => key.startsWith('co_host')), ['co_host.account_id']);
  assert.equal(hit.ids['co_host.account_id'], 'OTHER_ACCOUNT');
  assert.deepEqual(hit.enums, { 'live_info.room_status': '1', 'live_info.stream_status': '1' }); assert.deepEqual(hit.times, {});
  assert.doesNotMatch(JSON.stringify(coHost), /(?<!\d)(888888|9000009|9999999|1794787200)(?!\d)|PRIVATE/);

  // When the session record itself belongs to another account, only the nested record that names a registered account is read.
  const guest = await run('venue', venue([{ live_id: 777000000001, account_id: 9999999, room_id: '9000010', status: 2,
    partner: { account_id: 2345678, live_id: 777000000002, live_info: { room_status: 1, stream_status: 1 } } }]));
  const [partner] = guest.registeredHits;
  assert.equal(partner.key, 'synthetic-b');
  assert.deepEqual(partner.ids, { account_id: 'OTHER_ACCOUNT', 'partner.account_id': '2345678', 'partner.live_id': '777000000002' });
  assert.deepEqual(partner.enums, { 'partner.live_info.room_status': '1', 'partner.live_info.stream_status': '1' });
  assert.doesNotMatch(JSON.stringify(guest), /(?<!\d)(777000000001|9000010|9999999)(?!\d)/);

  // The same holds for JSON carried inside a string (with an oddly spelled account field) and for an account field whose value cannot be matched.
  const embedded = await run('venue', venue([{ live_id: 111000000012, account_id: 3456789,
    extra_json: JSON.stringify({ 'Account-ID': 9999998, live_id: 555000000001, status: 7 }),
    unknown_owner: { account_id: { nested: 1 }, live_id: 555000000002, status: 8 } }]));
  const [inner] = embedded.registeredHits;
  assert.deepEqual(inner.ids, { live_id: '111000000012', account_id: '3456789' });
  assert.deepEqual(inner.enums, {});
  assert.doesNotMatch(JSON.stringify(embedded), /(?<!\d)(555000000001|555000000002|9999998)(?!\d)/);
});

test('official 70809 envelope: is_success and buiness_code are recorded and a false flag rejects the run', async () => {
  const official = (flags, list = []) => ({ alibaba_taobao_live_recommend_alipay_query_response: { ...flags,
    data: { alipay_venue_list: { alipay_venue_d_t_o: list } } } });
  const root = 'alibaba_taobao_live_recommend_alipay_query_response';
  const ok = await run('venue', official({ buiness_code: 0, is_success: true, error_message: 'PRIVATE_MESSAGE' }));
  assert.equal(ok.status, 'EXPLORED'); assert.equal(ok.exitCode, 0);
  assert.deepEqual(ok.envelope, { [`${root}.buiness_code`]: 0, [`${root}.is_success`]: true });
  const failed = await run('venue', official({ buiness_code: 1, is_success: false, error_message: 'PRIVATE_MESSAGE' }, [venueItem()]));
  assert.equal(failed.status, 'REJECTED'); assert.equal(failed.reason, 'TOP_BUSINESS_REJECTED'); assert.equal(failed.exitCode, 3);
  assert.equal(failed.envelope[`${root}.is_success`], false); assert.equal(failed.envelope[`${root}.buiness_code`], 1);
  assert.ok(failed.shape); assert.equal(failed.requestsSent, 1);
  assert.doesNotMatch(JSON.stringify(failed), /PRIVATE_MESSAGE/);
  // The platform text is never read, and a response without the flag keeps its earlier behaviour.
  assert.equal((await run('venue', official({ buiness_code: 0 }))).status, 'EXPLORED');
});
