import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {isDouyin,inspectRoomCatalog,inspectShops,inspectDaily,audit,query,PATHS} from '../probes/r36/douyin-ops-qa.mjs';
const sample={rooms:[{platform:'jd',id:17,shop_id:17},{platform:'dy',id:9,shop_id:20,bound_session_key:'not-for-export'},{platform:'douyin',id:10,shop_id:21},{platform:'tmall',id:6}]};
test('Douyin source codes accepted without converting JD 17 to Douyin',()=>{
 assert.equal(isDouyin('dy'),true);assert.equal(isDouyin('douyin'),true);assert.equal(isDouyin('jd'),false);
 const c=inspectRoomCatalog(sample);assert.equal(c.rooms.length,2);assert.equal(c.platformCounts.jd,1);
 assert.equal(c.scope,'API_RESPONSE_NOT_PROVEN_EXHAUSTIVE');
});
test('cannot call paginated or partial catalog complete',()=>{
 const c=inspectRoomCatalog({...sample,has_more:true,total:30});assert.equal(c.scope,'PAGINATED_OR_INCOMPLETE');
});
test('bad/duplicate room IDs do not enter the monitor',()=>{
 const c=inspectRoomCatalog({rooms:[{id:1,platform:'dy'},{id:1,platform:'dy'},{id:'X',platform:'dy'}]});
 assert.equal(c.rooms.length,1);assert.deepEqual(c.warnings,['DOUYIN_DUPLICATE_ROOM','DOUYIN_ID_UNCONFIRMED']);
});
test('shops may be bare JSON array and joined only on source IDs',()=>{
 const s=inspectShops([{id:17,platform:'jd'},{id:20,platform:'dy'}]);
 assert.equal(s.size,1);assert.equal(s.has('20'),true);
});
test('historical session count is structural evidence not live status',()=>{
 const c=inspectDaily({days:[{date:'2026-10-21',minute_count:41,session_count:2,latest_minute_ts:'2026-10-21T06:00:00Z',latest:{status:1}}]},'2026-10-21');
 assert.equal(c.status,'UNKNOWN');assert.equal(c.sessionCountField,true);
});
test('failed source remains UNKNOWN; do not fake empty shop roster',async()=>{
 const r=await audit(async()=>{throw Error('SOURCE_HTTP_403')});
 assert.equal(r.catalogScope,'UNAVAILABLE');assert.equal(r.roomsFound,0);assert.equal(r.realTimeStatus,'UNKNOWN');
});
test('read-only probe bounded: 1 rooms + 1 shops + at most 4 daily requests',async()=>{
 const calls=[];
 const get=async(path,params)=>{calls.push({path,params});
  if(path===PATHS.rooms)return {rooms:Array.from({length:9},(_,i)=>({platform:'dy',id:i+1,shop_id:i+21}))};
  if(path===PATHS.shops)return [{platform:'dy',id:21}];
  return {days:[]};
 };
 const r=await audit(get);assert.equal(calls.length,6);assert.equal(r.testedDailyRooms,4);assert.equal(r.roomsFound,9);
 assert.equal(calls[2].params.platform,'dy');assert.equal(r.realTimeStatus,'UNKNOWN');
});
test('disallow other routes without any actual network request',async()=>{
 await assert.rejects(query('/api/admin/users'),/API_ROUTE_NOT_ALLOWED/);
});
test('a 403 is not bypassed or interpreted as offline',async()=>{
 const fake=async()=>({ok:false,status:403,headers:new Map(),text:async()=>'<html>error</html>'});
 await assert.rejects(query(PATHS.rooms,{},fake),/SOURCE_HTTP_403/);
});
test('public output does not include business identifiers or raw URLs/cookies',async()=>{
 const r=await audit(async path=>path===PATHS.rooms?sample:path===PATHS.shops?[]:{days:[]});
 const out=JSON.stringify(r);
 assert.doesNotMatch(out,/not-for-export|roomId|shopId|bound_session_key|cookie|101\.96\.215\.251/);
 assert.equal(r.fullCloneVerified,false);
});
test('source QA is not a deployer; no 90-day history or Pages write',()=>{
 const src=fs.readFileSync(new URL('../probes/r36/douyin-ops-qa.mjs',import.meta.url),'utf8');
 assert.doesNotMatch(src,/method:'POST'|method:'PUT'|deploy-pages|retention-days:\s*90/);
});
