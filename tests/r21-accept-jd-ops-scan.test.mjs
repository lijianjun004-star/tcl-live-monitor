import test from 'node:test';
import assert from 'node:assert/strict';
import {acceptJdOpsScan} from '../probes/r21/accept-jd-ops-scan.mjs';
const now='2026-11-10T12:23:55.000Z';
const base=()=>({
 schemaVersion:2,source:'TCL_OPS_READ_ONLY',
 checkedAt:'2026-11-10T12:23:49.000Z',date:'2026-11-10',
 catalogStatus:'RECEIVED',roomListScope:'API_DECLARED_COMPLETE',
 shard:{index:0,total:1},summaryScope:'ALL_SOURCE_ROOMS',
 warnings:[],discoveredRoomCount:7,summary:{LIVE:7,OFFLINE:0,UNKNOWN:0},
 rooms:[['1','1','空调'],['14','14','洗衣机'],['15','15','空调'],
 ['16','17','全品类'],['17','18','电视'],['18','19','显示器'],['19','21','电视']]
   .map(([roomId,shopId,category])=>({roomId,shopId,category,status:'LIVE',
      reason:'FRESH_MINUTE_DATA_STATUS_1',agentAlive:true,offlineCandidate:false,
      latestMinuteAgeMin:1.4,minuteCount:100}))
});
const run=x=>acceptJdOpsScan(x,{now});
test('7 real-shape internal rooms accepted as observed, not formal opening rate',()=>{
 const r=run(base());assert.equal(r.readiness,'OBSERVED');assert.equal(r.room_count,7);
 assert.equal(r.live,7);assert.equal(r.unknown,0);assert.equal(r.offline,0);
 assert.equal(r.formal_opening_rate_percent,null);assert.equal(r.formal_attendance_ready,false);
 assert.equal(r.fully_verified_public_accounts,false);
});
test('known category mismatches preserve partial acceptance and flags',()=>{
 const i=base();i.catalogStatus='PARTIAL_WITH_INTEGRITY_WARNINGS';
 i.roomListScope='API_RESPONSE_NOT_PROVEN_EXHAUSTIVE';
 i.warnings=['CATEGORY_MAPPING_CONFLICT:1','SHOP_CATALOG_NOT_PROVEN_COMPLETE'];
 const r=run(i);assert.equal(r.readiness,'PARTIAL');assert.equal(r.live,7);
 assert.ok(r.warnings.includes('CATEGORY_MAPPING_CONFLICT:1'));
 assert.equal(r.catalog_complete_attested,false);
});
test('a previously unseen seventh internal room is not dropped by old six-room baseline',()=>{
 const r=run(base());
 assert.ok(r.rooms.some(x=>x.room_id==='19'&&x.shop_id==='21'));
});
test('no current source after 15 minutes can be counted as current',()=>{
 const old=run({...base(),checkedAt:'2026-11-10T12:00:00.000Z'});
 assert.equal(old.readiness,'BLOCKED');assert.equal(old.reason,'STALE_OR_FUTURE_SCAN');
});
test('future clock skew above 60 seconds fails closed',()=>{
 assert.equal(run({...base(),checkedAt:'2026-11-10T12:25:40.000Z'}).readiness,'BLOCKED');
});
test('cross Beijing midnight with UTC server clock must match local day',()=>{
 const r=run({...base(),date:'2026-11-09'});
 assert.equal(r.reason,'BEIJING_DATE_MISMATCH');
});
test('shard cannot claim complete 7-room census',()=>{
 const i=base();i.shard={index:0,total:2};
 assert.equal(run(i).reason,'INCOMPLETE_SHARDED_SCAN');
});
test('missing API catalog returns BLOCKED not 0 rooms',()=>{
 const i=base();i.catalogStatus='UNAVAILABLE';i.summary=null;
 assert.equal(run(i).reason,'SOURCE_UNAVAILABLE');
});
test('bad duplicate room ID and untrusted room status fail',()=>{
 const i=base();i.rooms[1].roomId='1';
 assert.equal(run(i).reason,'ROOM_SCHEMA_OR_DUPLICATE');
 const j=base();j.rooms[0].status='NOT_RUNNING';
 assert.equal(run(j).reason,'ROOM_SCHEMA_OR_DUPLICATE');
});
test('known OFFLINE from unverified capture cannot be treated as real OFFLINE',()=>{
 const i=base();i.rooms[0].status='OFFLINE';i.summary={LIVE:6,OFFLINE:1,UNKNOWN:0};
 assert.equal(run(i).reason,'OFFLINE_NOT_FIELD_VALIDATED');
});
test('summary count disagreement blocks rather than hiding unknowns',()=>{
 const i=base();i.summary={LIVE:6,OFFLINE:0,UNKNOWN:1};
 assert.equal(run(i).reason,'SUMMARY_COUNT_CONFLICT');
});
test('partial room directory cannot pretend full census',()=>{
 const i=base();i.discoveredRoomCount=8;
 assert.equal(run(i).reason,'PARTIAL_ROOM_CATALOG');
});
test('sanitized output must not contain minute counts, raw bodies or user secrets',()=>{
 const i=base();i.rooms[0].token='ABCD_USER_TOKEN';i.rooms[0].minuteCount=114;
 const s=JSON.stringify(run(i));
 assert.ok(!s.includes('ABCD_USER_TOKEN'));assert.ok(!s.includes('minuteCount'));
});
test('UNKNOWN remains UNKNOWN and not 100 percent opening rate',()=>{
 const i=base();i.rooms[0].status='UNKNOWN';i.rooms[0].reason='OFFLINE_CANDIDATE';
 i.summary={LIVE:6,OFFLINE:0,UNKNOWN:1};
 const r=run(i);assert.equal(r.live,6);assert.equal(r.unknown,1);assert.equal(r.formal_opening_rate_percent,null);
});
test('invalid source and object shape cannot get an accepted snapshot',()=>{
 for(const i of [null,{}, {schemaVersion:2,source:'FAKE',checkedAt:now,rooms:[]}])
   assert.equal(run(i).readiness,'BLOCKED');
});
