import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SOURCE_ROUTES, isJD, beijingDate, normalizeRoomList, normalizeShopList, normalizeHeartbeats,
  evaluateRoom, scanJdSource, networkReader, scanSummary, makePreviousSnapshot,
} from '../probes/lib/tcl-jd-all.mjs';

const at=Date.parse('2026-11-05T12:00:20.000Z'); // 20:00 Beijing, not 12:00
const date='2026-11-05';
const JD_ROOM_IDS=[1,14,15,16,17,18];
const rooms=()=> JD_ROOM_IDS.map(id=>({id, platform:'jd', category:({1:'空调',14:'洗衣机',15:'空调',16:'全品类',17:'电视',18:'显示器'})[id],shop_id:id+100,bound_session_key:'DO_NOT_OUTPUT_SECRET'}));
const day=(count=105,time='2026-11-05T11:59:00.000Z',status=1)=>({date,minute_count:count,latest_minute_ts:time,latest:{status}});
const hb=()=>({rooms:JD_ROOM_IDS.map(id=>({id,last_heartbeat_at:'2026-11-05T12:00:01.000Z'}))});
const demoReader=({roomList=rooms(),heartbeats=hb(),shops=null,dayByRoom={},errorPaths=[]}={})=>async (path,params={})=>{
  if(errorPaths.includes(path)) throw Error('UPSTREAM_ERROR_NOT_LOGGED');
  if(path===SOURCE_ROUTES.rooms) return {rooms:roomList,total:roomList.length};
  if(path===SOURCE_ROUTES.shops) return shops ?? {shops:JD_ROOM_IDS.map(id=>({id:id+100,platform:'jd'}))};
  if(path===SOURCE_ROUTES.heartbeats) return heartbeats;
  if(path===SOURCE_ROUTES.daily) return dayByRoom[params.live_room_id] ?? {days:[day()]};
  throw Error('UNEXPECTED_REQUEST');
};

test('JD platform normalization excludes other platforms',()=>{
  for(const x of ['jd','JD','jingdong','京东']) assert.equal(isJD(x),true);
  for(const x of ['tmall','dy','抖音',null]) assert.equal(isJD(x),false);
});
test('Beijing date is not server time',()=>assert.equal(beijingDate(new Date('2026-11-04T17:00:00Z')),'2026-11-05'));
test('6 JD rooms discovered, including newer IDs, no hardcoding',()=>{
  const r=normalizeRoomList({rooms:[...rooms(),{id:2,platform:'tmall'},{id:99,platform:'JD',category:'新店',bound_session_key:'hidden'}]});
  assert.deepEqual(r.rooms.map(x=>x.roomId),['1','14','15','16','17','18','99']);
  assert.equal(r.rooms[0].categoryMappingConflict,true);
  assert.ok(!JSON.stringify(r).includes('DO_NOT_OUTPUT_SECRET'));
  assert.ok(!JSON.stringify(r).includes('hidden'));
});
test('shop_id is distinct from internal room id',()=>{
  const r=normalizeRoomList({rooms:[{id:17,shop_id:999,platform:'jd'}]});
  assert.equal(r.rooms[0].roomId,'17'); assert.equal(r.rooms[0].shopId,'999');
});
test('different response object shapes supported',()=>{
  const r=normalizeRoomList({data:{rooms:rooms()}}); assert.equal(r.rooms.length,6);
  assert.equal(normalizeShopList({data:{list:[{id:1,platform:'JD'},{id:2,platform:'dy'}]}}).length,1);
  assert.equal(normalizeHeartbeats({data:{rooms:[{id:14,last_heartbeat_at:'test'}]}}).get('14'),'test');
});
test('missing rooms schema is not zero JD rooms',()=>assert.throws(()=>normalizeRoomList({msg:'ok'}),/SCHEMA_ROOMS_ARRAY_MISSING/));
test('paginated response does not silently report all rooms',()=>assert.throws(()=>normalizeRoomList({rooms:rooms(),total:40}),/PAGINATED_OR_INCOMPLETE/));
test('room count over budget refuses to scan',()=>assert.throws(()=>normalizeRoomList({rooms:Array.from({length:101},(_,i)=>({id:i+1,platform:'jd'}))}),/ROOM_LIMIT_EXCEEDED/));
test('duplicate room id counted once and flagged',()=>{
  const r=normalizeRoomList({rooms:[rooms()[0],rooms()[0]]});
  assert.equal(r.rooms.length,1);assert.ok(r.warnings.some(x=>x.includes('DUPLICATE')));
});
test('invalid room id skipped and flagged',()=>{
  const r=normalizeRoomList({rooms:[{id:'../bad',platform:'jd'}]});
  assert.equal(r.rooms.length,0);assert.ok(r.warnings.includes('JD_ROOM_ID_INVALID'));
});
test('minute freshly observed, heartbeat alive -> LIVE',()=>{
  const r=evaluateRoom({room:normalizeRoomList({rooms:rooms()}).rooms[1],day:day(),heartbeatAt:'2026-11-05T12:00:01Z',at,date});
  assert.equal(r.status,'LIVE');assert.equal(r.agentAlive,true);
});
test('fresh minute without capture heartbeat is not confirmed LIVE',()=>{
  const r=evaluateRoom({room:normalizeRoomList({rooms:rooms()}).rooms[1],day:day(),heartbeatAt:null,at,date});
  assert.equal(r.status,'UNKNOWN');assert.equal(r.reason,'LIVE_UNCONFIRMED_CAPTURE_AGENT');
});
test('stale minute + alive heartbeat -> offline CANDIDATE but UNKNOWN',()=>{
  const r=evaluateRoom({room:normalizeRoomList({rooms:rooms()}).rooms[1],day:day(105,'2026-11-05T10:00:00Z'),heartbeatAt:'2026-11-05T12:00:01Z',at,date});
  assert.equal(r.status,'UNKNOWN');assert.equal(r.offlineCandidate,true);
});
test('no binding -> UNKNOWN regardless of fresh minute',()=>{
  const room={...normalizeRoomList({rooms:rooms()}).rooms[1],captureBound:false};
  assert.equal(evaluateRoom({room,day:day(),heartbeatAt:'2026-11-05T12:00:01Z',at,date}).reason,'CAPTURE_UNBOUND');
});
test('historical filter cannot claim current live',()=>{
  const room=normalizeRoomList({rooms:rooms()}).rooms[1];
  assert.equal(evaluateRoom({room,day:day(),heartbeatAt:'2026-11-05T12:00:01Z',at,date:'2026-10-21'}).status,'UNKNOWN');
});
test('heartbeat API failure must degrade to UNKNOWN',()=>{
  const room=normalizeRoomList({rooms:rooms()}).rooms[1];
  assert.equal(evaluateRoom({room,day:day(),heartbeatAt:null,heartbeatDataAvailable:false,at,date}).reason,'HEARTBEAT_SOURCE_UNAVAILABLE');
});
test('minute count deltas require same day, time forward, no reset',()=>{
  const room=normalizeRoomList({rooms:rooms()}).rooms[1];
  const e={room,day:day(),heartbeatAt:'2026-11-05T12:00:01Z',at,date};
  assert.equal(evaluateRoom({...e, previous:{roomId:'14',date,at:at-300_000,minuteCount:100}}).minutesDelta,5);
  assert.equal(evaluateRoom({...e, previous:{roomId:'14',date:'2026-11-04',at:at-300_000,minuteCount:100}}).minutesDelta,null);
  assert.equal(evaluateRoom({...e, previous:{roomId:'14',date,at:at-300_000,minuteCount:106}}).minutesDelta,null);
});
test('catalog failure is unavailable, NOT an empty store list',async()=>{
  const r=await scanJdSource({reader:demoReader({errorPaths:[SOURCE_ROUTES.rooms]}),at});
  assert.equal(r.catalogStatus,'UNAVAILABLE');assert.equal(r.summary,null);
});
test('all six JD room states counted with no other platform',async()=>{
  const r=await scanJdSource({reader:demoReader(),at});
  assert.equal(r.rooms.length,6);assert.deepEqual(r.summary,{LIVE:6,OFFLINE:0,UNKNOWN:0});
  assert.equal(r.shopJoinStatus,'ALL_ROOM_SHOP_IDS_PRESENT');
  assert.ok(!JSON.stringify(r).includes('DO_NOT_OUTPUT_SECRET'));
});
test('new 7th JD room is automatically included',async()=>{
  const extra={id:22,platform:'jd',category:'新房',shop_id:122,bound_session_key:'s'};
  const r=await scanJdSource({reader:demoReader({roomList:[...rooms(),extra]}),at});
  assert.equal(r.rooms.length,7);assert.ok(r.rooms.some(x=>x.roomId==='22'));
});
test('missing day API creates UNKNOWN, not OFFLINE',async()=>{
  const r=await scanJdSource({reader:demoReader({errorPaths:[SOURCE_ROUTES.daily]}),at});
  assert.deepEqual(r.summary,{LIVE:0,OFFLINE:0,UNKNOWN:6});
  assert.ok(r.rooms.every(x=>x.reason==='DAILY_API_ERROR'));
});
test('missing heartbeats makes all unknown',async()=>{
  const r=await scanJdSource({reader:demoReader({errorPaths:[SOURCE_ROUTES.heartbeats]}),at});
  assert.equal(r.summary.UNKNOWN,6);assert.ok(r.warnings.includes('HEARTBEATS_API_UNAVAILABLE'));
});
test('missing shops does not silently drop JD rooms',async()=>{
  const r=await scanJdSource({reader:demoReader({errorPaths:[SOURCE_ROUTES.shops]}),at});
  assert.equal(r.rooms.length,6);assert.equal(r.shopCount,null);assert.ok(r.warnings.includes('SHOPS_API_UNAVAILABLE'));
});
test('unknown shop-to-room join never invents unmatched shops',async()=>{
  const list=rooms().map(x=>({...x,shop_id:undefined}));
  const r=await scanJdSource({reader:demoReader({roomList:list}),at});
  assert.equal(r.shopJoinStatus,'NO_ROOM_TO_SHOP_ID_JOIN');assert.equal(r.unmatchedShopIds,null);
});
test('shop not covered is an unmatched ID, not OFFLINE',async()=>{
  const r=await scanJdSource({reader:demoReader({shops:{shops:[{id:999,platform:'jd'}]}}),at});
  assert.deepEqual(r.unmatchedShopIds,['999']);assert.equal(r.summary.OFFLINE,0);
});
test('no raw secrets or business data in sanitized prior snapshot',async()=>{
  const r=await scanJdSource({reader:demoReader(),at});
  const snapshot=makePreviousSnapshot(r,at);
  assert.equal(snapshot.rooms.length,6);assert.equal(snapshot.rooms[0].minuteCount,105);
  assert.ok(!JSON.stringify(snapshot).includes('DO_NOT_OUTPUT_SECRET'));
});
test('reader only GET fixed allowlist, no redirects and no credentials',async()=>{
  const calls=[];
  const fetchFn=async(u,opts)=>{calls.push({u:String(u),opts});return {ok:true,headers:{get:()=>null},text:async()=>'{"rooms":[]}'}};
  const reader=networkReader('http://127.0.0.1:9999/',fetchFn);
  await reader(SOURCE_ROUTES.rooms);
  assert.equal(calls.length,1);assert.equal(calls[0].opts.method,'GET');assert.equal(calls[0].opts.redirect,'error');
  assert.ok(!JSON.stringify(calls).includes('authorization'));
  await assert.rejects(reader('/api/shops/delete'),/PATH_NOT_ALLOWED/);
  assert.throws(()=>networkReader('http://me:pass@127.0.0.1/'),/BASE_MUST_BE_ORIGIN/);
});
test('invalid local date and high concurrency rejected',async()=>{
  await assert.rejects(scanJdSource({reader:demoReader(),at,date:'not-date'}),/DATE_FORMAT_INVALID/);
  await assert.rejects(scanJdSource({reader:demoReader(),at,concurrency:99}),/CONCURRENCY_LIMIT/);
});
test('scan summary is correctly tri-state',()=>{
  assert.deepEqual(scanSummary([{status:'LIVE'},{status:'UNKNOWN'},{status:'UNKNOWN'}]),{LIVE:1,OFFLINE:0,UNKNOWN:2});
});

test('synthetic six-room replay of 11-04 evidence: two LIVE, four UNKNOWN; no false OFFLINE',async()=>{
  const replayAt=Date.parse('2026-11-04T12:14:02Z');
  const replayDate='2026-11-04';
  const statuses={
    1:{minutes:20,latest:'2026-11-04T07:06:00Z'},
    14:{minutes:360,latest:'2026-11-04T12:12:00Z'},
    15:{minutes:100,latest:'2026-11-04T05:21:00Z'},
    16:null,
    17:{minutes:70,latest:'2026-11-04T10:54:00Z'},
    18:{minutes:355,latest:'2026-11-04T12:12:00Z'},
  };
  const mock=async(path,params={})=>{
    if(path===SOURCE_ROUTES.rooms)return {rooms:rooms()};
    if(path===SOURCE_ROUTES.shops)return {shops:JD_ROOM_IDS.map(id=>({id:id+100,platform:'jd'}))};
    if(path===SOURCE_ROUTES.heartbeats)return {rooms:JD_ROOM_IDS.map(id=>({id,last_heartbeat_at:'2026-11-04T12:13:59Z'}))};
    if(path===SOURCE_ROUTES.daily){const d=statuses[params.live_room_id];return {days:d?[{date:replayDate,minute_count:d.minutes,latest_minute_ts:d.latest,latest:{status:1}}]:[]};}
  };
  const r=await scanJdSource({reader:mock,at:replayAt,date:replayDate});
  assert.deepEqual(r.summary,{LIVE:2,OFFLINE:0,UNKNOWN:4});
  assert.deepEqual(r.rooms.filter(x=>x.status==='LIVE').map(x=>x.roomId),['14','18']);
  assert.ok(r.rooms.find(x=>x.roomId==='1').categoryMappingConflict);
});
