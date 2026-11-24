import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadonlyReader } from '../../probes/r315/readonly-reader.mjs';

const origin = 'https://example.invalid';
const approvedOrigins = [origin], approvedPlatforms = ['jd'], approvedDates = ['2026-11-12'];
const approvedRoomIdsByPlatform = { jd:['123','9007199254740993'] };
const approved = { approvedOrigins, approvedPlatforms, approvedDates, approvedRoomIdsByPlatform };
const query = { start_date:'2026-11-12', end_date:'2026-11-12', platform:'jd', live_room_id:'123' };
const response = (body = '{}', options = {}) => new Response(body, { status: options.status ?? 200, headers: { 'content-type': options.type ?? 'application/json', ...options.headers } });
const validators = Object.fromEntries(['/api/shops','/api/capture/rooms','/api/assistant/active-rooms','/api/capture/room-overview/daily'].map(path => [path, value => value && typeof value === 'object' && !Array.isArray(value)]));
const reader = (fetchImpl, options = {}) => createReadonlyReader({ origin, ...approved, fetchImpl, validators, ...options });
const code = error => error?.message;

test('permits four paths only with forced read-only transport settings', async () => {
  const seen = [];
  const r = reader(async (url, init) => { seen.push({ url, init }); return response(); });
  for (const path of ['/api/shops', '/api/capture/rooms', '/api/assistant/active-rooms']) await r.read(path);
  await r.read('/api/capture/room-overview/daily', query);
  assert.equal(seen.length, 4);
  for (const { init } of seen) {
    assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit');
    assert.deepEqual(init.headers, { accept: 'application/json' });
  }
  await assert.rejects(r.read('/api/unapproved'), e => code(e) === 'READER_INVALID_REQUEST');
  await assert.rejects(r.read('/api/shops', { token: 'x' }), e => code(e) === 'READER_INVALID_QUERY');
});

test('only permits daily parameters over HTTPS and rejects unapproved values', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return response(); };
  await reader(fetchImpl).read('/api/capture/room-overview/daily', query);
  assert.throws(() => createReadonlyReader({ origin:'http://example.invalid', ...approved, fetchImpl }), e => code(e) === 'READER_INVALID_CONFIG');
  await assert.rejects(reader(fetchImpl).read('/api/capture/room-overview/daily', { ...query, token:'x' }), e => code(e) === 'READER_INVALID_QUERY');
  assert.equal(calls, 1);
});

test('blocked status and challenge pages trip the breaker for later calls', async () => {
  for (const reply of [response('{}', {status:401}), response('{}', {status:403}), response('{}', {status:429}), response('请先完成验证码', {type:'text/html'}), response('{"message":"captcha verification required"}')]) {
    let calls = 0;
    const r = reader(async () => { calls++; return reply; });
    await assert.rejects(r.read('/api/shops'), e => code(e) === 'READER_ACCESS_BLOCKED');
    await assert.rejects(r.read('/api/shops'), e => code(e) === 'READER_ACCESS_BLOCKED');
    assert.equal(calls, 1);
  }
});

test('validates content type and streamed size', async () => {
  await assert.rejects(reader(async () => response('{}', {type:'text/plain'})).read('/api/shops'), e => code(e) === 'READER_CONTENT_TYPE');
  await assert.rejects(reader(async () => response('123456'), {maxBytes:5}).read('/api/shops'), e => code(e) === 'READER_TOO_LARGE');
  await assert.rejects(reader(async () => response('{}', {headers:{'content-length':'100'}}), {maxBytes:5}).read('/api/shops'), e => code(e) === 'READER_TOO_LARGE');
});

test('malformed UTF-8 cannot be silently replaced and accepted as source data', async () => {
  let calls=0;
  const r=reader(async()=>{
    calls++;
    return new Response(Uint8Array.from([123,34,118,34,58,34,255,34,125]),
      {headers:{'content-type':'application/json'}});
  });
  await assert.rejects(r.read('/api/shops'), e => code(e)==='READER_INVALID_UTF8');
  await assert.rejects(r.read('/api/shops'), e => code(e)==='READER_ACCESS_BLOCKED');
  assert.equal(calls,1);
});

test('times out even if injected transport ignores abort, and fails closed afterwards', async () => {
  let calls = 0;
  const r = reader(() => { calls++; return new Promise(() => {}); }, {timeoutMs:10});
  await assert.rejects(r.read('/api/shops'), e => code(e) === 'READER_TIMEOUT');
  await assert.rejects(r.read('/api/shops'), e => code(e) === 'READER_ACCESS_BLOCKED');
  assert.equal(calls, 1);
});

test('rejects redirects and concurrent operations', async () => {
  const redirect = reader(async () => ({...response(), status:200, redirected:true}));
  await assert.rejects(redirect.read('/api/shops'), e => code(e) === 'READER_REDIRECT_REJECTED');
  let resolve;
  const r = reader(() => new Promise(done => { resolve = done; }));
  const first = r.read('/api/shops');
  await assert.rejects(r.read('/api/shops'), e => code(e) === 'READER_BUSY');
  resolve(response());
  await first;
});

test('never accepts JSON without a verified endpoint schema', async () => {
  const r = createReadonlyReader({ origin, ...approved, fetchImpl: async () => response('{}') });
  await assert.rejects(r.read('/api/shops'), e => code(e) === 'READER_SCHEMA_UNVERIFIED');
  const invalid = reader(async () => response('{}'), { validators: { '/api/shops': () => false } });
  await assert.rejects(invalid.read('/api/shops'), e => code(e) === 'READER_SCHEMA_REJECTED');
});

test('requires explicit independently supplied origin, platform and date approvals', () => {
  const fetchImpl = async () => response();
  for (const bad of [
    {approvedOrigins:undefined}, {approvedOrigins:[]}, {approvedOrigins:['https://other.invalid']},
    {approvedPlatforms:undefined}, {approvedPlatforms:[]}, {approvedDates:undefined}, {approvedDates:[]},
    {approvedDates:['2026-02-30']},
  ]) assert.throws(() => createReadonlyReader({origin,...approved,fetchImpl,...bad}), e => code(e)==='READER_INVALID_CONFIG');
});

test('daily requires exact approved platform/date, equal valid dates and digit string ID', async () => {
  let calls=0;
  const r=reader(async()=>{calls++;return response();});
  for (const bad of [{}, {...query,start_date:'2026-02-30'}, {...query,end_date:'2026-11-13'},
    {...query,start_date:'2026-11-13',end_date:'2026-11-13'}, {...query,platform:'JD'},
    {...query,live_room_id:123}, {...query,live_room_id:'abc'}, {...query,live_room_id:'1'.repeat(17)}])
    await assert.rejects(r.read('/api/capture/room-overview/daily',bad),e=>code(e)==='READER_INVALID_QUERY');
  assert.equal(calls,0);
  await r.read('/api/capture/room-overview/daily',{...query,live_room_id:'9007199254740993'});
  assert.equal(calls,1);
});

test('scope lists are copied, not widened by later mutations', async () => {
  const platforms=['jd'], dates=['2026-11-12'];
  const r=reader(async()=>response(),{approvedPlatforms:platforms,approvedDates:dates});
  platforms.push('dy'); dates.push('2026-11-13');
  await assert.rejects(r.read('/api/capture/room-overview/daily',{...query,platform:'dy'}),e=>code(e)==='READER_INVALID_QUERY');
  await assert.rejects(r.read('/api/capture/room-overview/daily',{...query,start_date:'2026-11-13',end_date:'2026-11-13'}),e=>code(e)==='READER_INVALID_QUERY');
});

test('all network and response failures permanently trip the breaker', async () => {
  const failures = [
    async()=>{throw Error('private transport details');},
    async()=>response('{}',{status:500}),
    async()=>response('{}',{status:302}),
    async()=>response('{}',{type:'text/plain'}),
    async()=>response('{invalid'),
    async()=>response('123456'),
    async()=>({status:200,ok:true,headers:new Headers({'content-type':'application/json'}),body:null}),
    async()=>({status:200,ok:true,headers:new Headers({'content-type':'application/json'}),body:{getReader:()=>({read:async()=>{throw Error('private');},releaseLock(){}})}}),
  ];
  for (let i=0;i<failures.length;i++) {
    let calls=0; const r=reader(async(...args)=>{calls++;return failures[i](...args);}, i===5?{maxBytes:5}:{});
    await assert.rejects(r.read('/api/shops'));
    await assert.rejects(r.read('/api/shops'),e=>code(e)==='READER_ACCESS_BLOCKED');
    assert.equal(calls,1,`case ${i}`);
  }
  for (const validators of [{},{'/api/shops':()=>false},{'/api/shops':()=>{throw Error('private');}}]) {
    let calls=0; const r=reader(async()=>{calls++;return response();},{validators});
    await assert.rejects(r.read('/api/shops'));
    await assert.rejects(r.read('/api/shops'),e=>code(e)==='READER_ACCESS_BLOCKED');
    assert.equal(calls,1);
  }
});

test('room approvals are explicit, exact, platform-bound and copied at creation', async () => {
  let calls=0;
  const roomScope={jd:['123'],dy:['456']};
  const r=reader(async()=>{calls++;return response();},{approvedPlatforms:['jd','dy'],approvedRoomIdsByPlatform:roomScope});
  roomScope.jd.push('999');
  await r.read('/api/capture/room-overview/daily',query);
  for (const bad of [{...query,live_room_id:'999'}, {...query,live_room_id:'456'},
    {...query,platform:'dy',live_room_id:'123'}, {...query,live_room_id:'0123'}])
    await assert.rejects(r.read('/api/capture/room-overview/daily',bad),e=>code(e)==='READER_INVALID_QUERY');
  await r.read('/api/capture/room-overview/daily',{...query,platform:'dy',live_room_id:'456'});
  assert.equal(calls,2);
});

test('factory rejects missing, mismatched, malformed or duplicate room approvals', () => {
  const fetchImpl=async()=>response();
  for (const scope of [undefined,null,{}, {jd:null}, {jd:[123]}, {jd:['x']}, {jd:['123','123']}, {jd:['1'.repeat(17)]}, {jd:['123'],dy:['456']}])
    assert.throws(()=>createReadonlyReader({origin,...approved,fetchImpl,approvedRoomIdsByPlatform:scope}),e=>code(e)==='READER_INVALID_CONFIG');
  // An explicit empty set enables safe catalog reads while forbidding all daily IDs.
  assert.doesNotThrow(()=>createReadonlyReader({origin,...approved,fetchImpl,approvedRoomIdsByPlatform:{jd:[]}}));
});
