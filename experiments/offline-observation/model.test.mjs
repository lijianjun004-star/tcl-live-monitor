import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateObservations} from './model.mjs';
const now='2026-11-17T10:00:00.000Z';
const binding={platform:'jd',accountId:'synthetic-account',shopId:'synthetic-shop',entityRoomId:'synthetic-room',reviewed:true,reviewRef:'synthetic-review',reviewedAt:'2026-11-17T09:00:00.000Z',reviewExpiresAt:'2026-11-18T09:00:00.000Z'};
const sample={...binding,receivedAt:now,observedAt:'2026-11-17T09:59:00.000Z',heartbeatAt:now,
  sourceHealth:'AVAILABLE',loginStatus:'NOT_REQUIRED',broadcastState:'LIVE',evidenceRef:'synthetic-evidence',evidenceReviewed:true,broadcastSessionId:'synthetic-session'};
const run=(observations=[sample],bindings=[binding])=>evaluateObservations({bindings,observations,now,maxObservationAgeMs:180000,maxHeartbeatAgeMs:120000});
const row=(change={})=>run([{...sample,...change}]).rows[0];
test('four distinct identifiers and valid observation time survive without invented start/end',()=>{
  const r=run();assert.equal(r.rows[0].broadcastState,'LIVE');
  for(const k of ['accountId','shopId','entityRoomId','broadcastSessionId']) assert.equal(r.rows[0][k],sample[k]);
  assert.equal(r.rows[0].effectiveObservedAt,sample.observedAt);assert.notEqual(r.rows[0].effectiveObservedAt,now);
  assert.equal(r.actualStartAt,null);assert.equal(r.actualEndAt,null);assert.equal(r.scoringEnabled,false);
});
test('duplicate accounts never merge even identical records or different names',()=>{
  for(const duplicate of [binding,{...binding,shopId:'other-shop',name:'same name'}]) {
    const r=run([sample],[binding,duplicate]);assert.ok(r.rows.every(x=>x.broadcastState==='UNKNOWN'&&x.identity==='CONFLICT'));
  }
});
test('same account token on different platforms remains separate',()=>{
  const b={...binding,platform:'tmall'};const s={...sample,platform:'tmall'};
  const r=run([sample,s],[binding,b]);assert.equal(r.rows.length,2);assert.ok(r.rows.every(x=>x.broadcastState==='LIVE'));
});
test('name alone cannot bind and a mismatched room cannot provide evidence',()=>{
  assert.equal(run([sample],[{name:'same name'}]).rows[0].broadcastState,'UNKNOWN');
  assert.equal(row({entityRoomId:'other-room'}).identity,'CONFLICT');
  assert.equal(run([sample],[{...binding,reviewed:false}]).rows[0].broadcastState,'UNKNOWN');
});
test('missing sample keeps registered row UNKNOWN, never OFFLINE',()=>{
  const r=run([]).rows[0];assert.equal(r.reason,'MISSING_SAMPLE');assert.equal(r.broadcastState,'UNKNOWN');assert.equal(r.effectiveObservedAt,null);
});
test('duplicate samples are ambiguous instead of choosing latest or first',()=>{
  assert.equal(run([sample,{...sample,broadcastState:'OFFLINE'}]).rows[0].reason,'DUPLICATE_OBSERVATION');
});
test('unregistered observations cannot add inferred bindings',()=>{
  const r=run([{...sample,accountId:'unregistered'}]);assert.equal(r.unmatchedObservationCount,1);assert.equal(r.rows[0].broadcastState,'UNKNOWN');
});
test('health, login, stale data and heartbeat are separate axes',()=>{
  const r=row({sourceHealth:'UNAVAILABLE',loginStatus:'EXPIRED',observedAt:'2026-11-17T09:00:00.000Z',heartbeatAt:'2026-11-17T09:00:00.000Z'});
  assert.equal(r.sourceHealth,'UNAVAILABLE');assert.equal(r.loginStatus,'EXPIRED');assert.equal(r.dataFreshness,'STALE');assert.equal(r.heartbeat,'STALE');assert.equal(r.broadcastState,'UNKNOWN');
  for(const loginStatus of ['REQUIRED','EXPIRED','UNKNOWN'])assert.equal(row({loginStatus}).broadcastState,'UNKNOWN');
});
test('fresh heartbeat does not refresh old observation or prove offline',()=>{
  const r=row({observedAt:'2026-11-17T09:00:00.000Z'});assert.equal(r.heartbeat,'FRESH');assert.equal(r.dataFreshness,'STALE');assert.equal(r.effectiveObservedAt,null);
  assert.equal(row({observedAt:null}).broadcastState,'UNKNOWN');
});
test('future, impossible, missing, timezone-less and reversed times fail closed',()=>{
  for(const value of [null,'wrong','2026-02-30T09:59:00.000Z','2026-11-17T10:01:00.000Z','2026-11-17T09:59:00',NaN,0]) {
    for(const k of ['observedAt','heartbeatAt','receivedAt']) assert.equal(row({[k]:value}).broadcastState,'UNKNOWN');
  }
  assert.equal(row({receivedAt:'2026-11-17T09:58:00.000Z'}).broadcastState,'UNKNOWN');
});
test('missing or stale heartbeat and unknown statuses do not promote LIVE',()=>{
  for(const change of [{heartbeatAt:null},{heartbeatAt:'2026-11-17T09:00:00.000Z'},{sourceHealth:'mystery'},{broadcastState:'1'}])assert.equal(row(change).broadcastState,'UNKNOWN');
});
test('OFFLINE requires explicit reviewed negative evidence, gaps never substitute',()=>{
  assert.equal(row({broadcastState:'OFFLINE'}).broadcastState,'UNKNOWN');
  assert.equal(row({broadcastState:'OFFLINE',negativeEvidenceReviewed:true}).broadcastState,'OFFLINE');
  assert.equal(row({broadcastState:'OFFLINE',negativeEvidenceReviewed:true,sourceHealth:'UNAVAILABLE'}).broadcastState,'UNKNOWN');
});
test('session unknown remains null, no derivation from room or account',()=>{
  assert.equal(row({broadcastSessionId:null}).broadcastSessionId,null);
  assert.equal(row({broadcastSessionId:'not a session'}).broadcastState,'UNKNOWN');
});
test('unknown extra fields and session credentials are never echoed',()=>{
  const result=row({cookie:'PRIVATE_MARKER',token:'PRIVATE_MARKER',bound_session_key:'PRIVATE_MARKER',rawBody:'PRIVATE_MARKER',name:'PRIVATE_MARKER'});
  assert.ok(!JSON.stringify(result).includes('PRIVATE_MARKER'));
  assert.equal(row({evidenceRef:'https://invalid.example/private'}).broadcastState,'UNKNOWN');
});
test('invalid evaluation input throws fixed codes without input content',()=>{
  for(const now of ['bad',null,'2026-02-30T00:00:00.000Z'])assert.throws(()=>evaluateObservations({now}),/INVALID_EVALUATION_CLOCK_OR_LIMIT/);
  assert.throws(()=>evaluateObservations({now,maxObservationAgeMs:1,maxHeartbeatAgeMs:1,bindings:null,observations:[]}),/INVALID_OR_OVERSIZED_INPUT/);
  assert.throws(()=>evaluateObservations({now,maxObservationAgeMs:1,maxHeartbeatAgeMs:1,bindings:Array(1001),observations:[]}),/INVALID_OR_OVERSIZED_INPUT/);
});
test('whole evaluation has no network, logging, persistence or input mutation',()=>{
  const originalFetch=globalThis.fetch,originalLog=console.log;
  globalThis.fetch=()=>assert.fail('network');console.log=()=>assert.fail('logging');
  try {const b=Object.freeze({...binding}),s=Object.freeze({...sample});assert.equal(run([s],[b]).rows[0].broadcastState,'LIVE');}
  finally{globalThis.fetch=originalFetch;console.log=originalLog;}
});

test('identity review needs explicit valid time interval, never permanent booleans',()=>{
  for(const change of [{reviewedAt:null},{reviewExpiresAt:null},{reviewedAt:'2026-11-18T00:00:00.000Z'},{reviewExpiresAt:now},{reviewExpiresAt:'2026-02-30T00:00:00.000Z'}]) {
    const r=run([sample],[{...binding,...change}]).rows[0];assert.equal(r.broadcastState,'UNKNOWN');assert.equal(r.reason,'IDENTITY_REVIEW_TIME_INVALID_OR_EXPIRED');
  }
});
