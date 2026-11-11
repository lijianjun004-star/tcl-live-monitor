import test from 'node:test';
import assert from 'node:assert/strict';
import {trustedDouyinHeartbeatMap,decideSourceDouyinState,scanDouyinNow} from '../probes/r36/douyin-live-one-shot.mjs';
import {PATHS} from '../probes/r36/douyin-ops-qa.mjs';
const now=Date.parse('2026-11-11T11:59:30Z'); // 19:59 BJT
const date='2026-11-11',fresh={date,minute_count:100,latest_minute_ts:'2026-11-11T11:58:00Z',latest:{status:1}};
const room={roomId:'12',platform:'douyin',bound:true};
test('verified bound room and fresh Douyin capture heartbeat are necessary to claim LIVE',()=>{
 const r=decideSourceDouyinState({room,day:fresh,heartbeatAt:'2026-11-11T11:59:00Z',now,date});
 assert.equal(r.state,'LIVE');
});
test('unbound room stays UNKNOWN despite source metrics status=1',()=>{
 const r=decideSourceDouyinState({room:{...room,bound:false},day:fresh,heartbeatAt:'2026-11-11T11:59:00Z',now,date});
 assert.equal(r.state,'UNKNOWN');assert.equal(r.reason,'CAPTURE_UNBOUND');
});
test('missing/stale capture heartbeat cannot assert LIVE',()=>{
 for(const hb of [null,'2026-11-11T10:00:00Z']){
  const r=decideSourceDouyinState({room,day:fresh,heartbeatAt:hb,now,date});
  assert.equal(r.state,'UNKNOWN');
 }
});
test('historical metrics never show live state now',()=>{
 const r=decideSourceDouyinState({room,day:fresh,heartbeatAt:'2026-11-11T11:59:00Z',now,date:'2026-10-21'});
 assert.equal(r.state,'UNKNOWN');
});
test('heartbeat requires exact Douyin platform identity, no JD ID collision',()=>{
 const r=trustedDouyinHeartbeatMap({rooms:[{platform:'jd',id:12,last_heartbeat_at:'2026-11-11T11:59:00Z'},
  {platform:'douyin',id:12,last_heartbeat_at:'2026-11-11T11:59:00Z'}]});
 assert.equal(r.map.size,1);assert.equal(r.map.has('12'),true);
 const jd=trustedDouyinHeartbeatMap({rooms:[{platform:'jd',id:12,last_heartbeat_at:'2026-11-11T11:59:00Z'}]});
 assert.equal(jd.map.size,0);
});
test('ten source rooms with one bound agent yield 1 LIVE 9 UNKNOWN, 0 OFFLINE',async()=>{
 const get=async (path,params)=>{
  if(path===PATHS.rooms)return {rooms:[{platform:'jd',id:17},...Array.from({length:10},(_,i)=>({platform:'douyin',id:i+1,bound_session_key:i===0?'private-key':null}))]};
  if(path===PATHS.active)return {rooms:[{platform:'douyin',id:1,last_heartbeat_at:'2026-11-11T11:59:00Z'}]};
  if(path===PATHS.daily)return {days:[fresh]};
  throw Error('Unexpected API path');
 };
 const r=await scanDouyinNow(get,now);
 assert.equal(r.observedRooms,10);assert.equal(r.boundRooms,1);assert.equal(r.LIVE,1);assert.equal(r.UNKNOWN,9);
 assert.equal(r.OFFLINE,0);assert.equal(r.attemptedDaily,10);assert.equal(r.formalDurationRate,null);
});
test('403 catalog is UNKNOWN and never creates OFFLINE or fake rooms',async()=>{
 const r=await scanDouyinNow(async()=>{throw Error('SOURCE_HTTP_403')},now);
 assert.equal(r.observedRooms,0);assert.equal(r.OFFLINE,0);assert.equal(r.catalogScope,'UNAVAILABLE');
});
test('source catalog >20 rooms fails closed before querying daily',async()=>{
 let dailyCalls=0;
 const r=await scanDouyinNow(async path=>{
  if(path===PATHS.rooms)return {rooms:Array.from({length:21},(_,i)=>({id:i+1,platform:'douyin'}))};
  dailyCalls++;return {days:[]}
 },now);
 assert.equal(r.verifiedCoverage,false);assert.equal(dailyCalls,0);assert.deepEqual(r.errors,['ROOM_LIMIT_NOT_COMPLETE']);
});
test('cannot interpret current source as exact start, end or formal KPI',async()=>{
 const r=await scanDouyinNow(async path=>path===PATHS.rooms?{rooms:[]}:null,now);
 assert.equal(r.verifiedExactStartEnd,false);assert.equal(r.formalOpeningRate,null);
});
