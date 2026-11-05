// Independent adversarial regressions. These tests must fail against unpatched R0.4.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import * as jd from '../probes/lib/tcl-jd-all.mjs';

const date = '2026-11-05';
const at = Date.parse('2026-11-05T12:00:00Z');
const validRooms = Array.from({length: 12}, (_,i) => ({ id: 100+i, platform: 'jd', category: '测试品类', shop_id: 900+i, bound_session_key: 'NEVER_OUTPUT' }));
const freshDay = { date, minute_count: 20, latest_minute_ts:'2026-11-05T11:59:00Z',latest:{status:1} };
const readerFor = (payload = {rooms:validRooms,total:validRooms.length}) => async (route) => {
  if(route===jd.SOURCE_ROUTES.rooms) return payload;
  if(route===jd.SOURCE_ROUTES.shops) return { shops:validRooms.map(x=>({id:x.shop_id,platform:'jd'})) };
  if(route===jd.SOURCE_ROUTES.heartbeats) return {rooms:validRooms.map(x=>({id:x.id,platform:'jd',last_heartbeat_at:'2026-11-05T11:59:00Z'}))};
  if(route===jd.SOURCE_ROUTES.daily) return { days:[freshDay] };
  throw Error('unknown route');
};

test('R05: pagination has_more=true forbids complete catalog',()=> {
 assert.throws(()=>jd.normalizeRoomList({rooms:validRooms,total:validRooms.length,has_more:true}),/CATALOG_PAGINATED_OR_INCOMPLETE/);
});
test('R05: pagination next_cursor forbids complete catalog',()=> {
 assert.throws(()=>jd.normalizeRoomList({rooms:validRooms,total:validRooms.length,pagination:{next_cursor:'abc'}}),/CATALOG_PAGINATED_OR_INCOMPLETE/);
});
test('R05: inconsistent declared total is not complete',()=> {
 assert.throws(()=>jd.normalizeRoomList({rooms:validRooms,total:validRooms.length-1}),/CATALOG_TOTAL_MISMATCH/);
});
test('R05: reject nonexistent Beijing calendar dates',async()=> {
 await assert.rejects(jd.scanJdSource({reader:readerFor(),at,date:'2026-02-31'}),/DATE_FORMAT_INVALID/);
});
test('R05: same numeric id from Douyin cannot masquerade as JD heartbeat',()=>{
 const h=jd.normalizeHeartbeats({rooms:[
  {id:100,platform:'douyin',last_heartbeat_at:'2026-11-05T11:59:00Z'},
  {id:100,platform:'jd',last_heartbeat_at:'2026-11-05T11:59:30Z'}]});
 assert.equal(h.get('100'),'2026-11-05T11:59:30Z');
});
test('R05: duplicate conflicting JD heartbeats never silently choose a winner',()=>{
 assert.throws(()=>jd.normalizeHeartbeats({rooms:[
  {id:100,platform:'jd',last_heartbeat_at:'2026-11-05T11:58:00Z'},
  {id:100,platform:'jd',last_heartbeat_at:'2026-11-05T11:59:00Z'}]}),/HEARTBEAT_ROOM_DUPLICATE/);
});
test('R05: stable numeric room shard assignment',()=>{
 assert.equal(typeof jd.roomBelongsToShard,'function');
 assert.equal(jd.roomBelongsToShard('101',2,3),true);
 assert.equal(jd.roomBelongsToShard('101',0,3),false);
 assert.equal(jd.roomBelongsToShard('9007199254740993',0,3),true); // BigInt, beyond JS safe integer
});
test('R05: sharded poll reports subset, never asserts global completion',async()=>{
 const a=await jd.scanJdSource({reader:readerFor(),at,date,shardIndex:0,shardTotal:3});
 const b=await jd.scanJdSource({reader:readerFor(),at,date,shardIndex:1,shardTotal:3});
 const c=await jd.scanJdSource({reader:readerFor(),at,date,shardIndex:2,shardTotal:3});
 assert.equal(a.rooms.length+b.rooms.length+c.rooms.length,12);
 assert.equal(a.discoveredRoomCount,12);
 assert.equal(a.shard.total,3);
 assert.equal(a.monitoringCoverage.exhaustive,false);
 assert.equal(a.summaryScope,'SHARD_ONLY');
 const distinct=new Set([...a.rooms,...b.rooms,...c.rooms].map(x=>x.roomId));assert.equal(distinct.size,12);
});
test('R05: shard inputs must have integer and bounded ranges',async()=>{
 await assert.rejects(jd.scanJdSource({reader:readerFor(),at,date,shardIndex:4,shardTotal:3}),/SHARD_INVALID/);
 await assert.rejects(jd.scanJdSource({reader:readerFor(),at,date,shardIndex:0,shardTotal:0}),/SHARD_INVALID/);
 await assert.rejects(jd.scanJdSource({reader:readerFor(),at,date,shardIndex:0,shardTotal:17}),/SHARD_INVALID/);
});
test('R05: source unavailability can never create a replacement snapshot',()=>{
 assert.equal(typeof jd.mergePreviousSnapshot,'function');
 assert.equal(jd.mergePreviousSnapshot({date,at:at-1000,rooms:[]},{date,catalogStatus:'UNAVAILABLE',rooms:[]},at),null);
});
test('R05: partial failures preserve previously valid minute counts, safely',()=>{
 const old={date,at:at-300000,rooms:[{roomId:'100',date,at:at-300000,minuteCount:12,name:'SECRET_NAME'},
  {roomId:'101',date,at:at-300000,minuteCount:8}]};
 const rep={date,catalogStatus:'RECEIVED',rooms:[{roomId:'100',minuteCount:15,status:'LIVE'},
  {roomId:'101',status:'UNKNOWN',reason:'DAILY_API_ERROR'}]};
 const merged=jd.mergePreviousSnapshot(old,rep,at);
 assert.equal(merged.rooms.find(x=>x.roomId==='100').minuteCount,15);
 assert.equal(merged.rooms.find(x=>x.roomId==='101').minuteCount,8);
 assert.ok(!JSON.stringify(merged).includes('SECRET_NAME'));
});
test('R05: clock regression cannot roll back previous snapshot',()=>{
 const old={date,at:at+1000,rooms:[{roomId:'100',date,at:at+1000,minuteCount:18}]};
 const rep={date,catalogStatus:'RECEIVED',rooms:[{roomId:'100',minuteCount:10,status:'LIVE'}]};
 assert.equal(jd.mergePreviousSnapshot(old,rep,at),null);
});
test('R05: bounded streaming response rejects unannounced oversized JSON body',async()=>{
 const tooBig='{"rooms":['+' '.repeat(1_200_000)+']}';
 const reader=jd.networkReader('http://127.0.0.1:3000/', async()=>new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(tooBig));c.close();}}),{status:200,headers:{'content-type':'application/json'}}));
 await assert.rejects(reader(jd.SOURCE_ROUTES.rooms),/BODY_TOO_LARGE/);
});
test('R05: previous evidence file must survive a failed catalog request',async(t)=>{
 const server=http.createServer((req,res)=>{res.statusCode=503;res.end('unavailable');});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const folder=await mkdtemp(join(tmpdir(),'jd-r05-state-'));t.after(()=>rm(folder,{recursive:true,force:true}));
 const prev=join(folder,'previous.json'), out=join(folder,'report.json');
 const initial=JSON.stringify({date,at:at-300000,rooms:[{roomId:'100',date,at:at-300000,minuteCount:99}]},null,2)+'\n';
 await writeFile(prev,initial);
 const result=await new Promise((resolve,reject)=>{
  const proc=spawn(process.execPath,['probes/tcl-jd-all.mjs','--previous',prev,'--output',out],{cwd:new URL('..',import.meta.url).pathname,env:{...process.env,TCL_OPS_BASE_URL:`http://127.0.0.1:${server.address().port}`},stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';proc.stdout.on('data',x=>stdout+=x);proc.stderr.on('data',x=>stderr+=x);proc.on('close',code=>resolve({code,stdout,stderr}));proc.on('error',reject);
 });
 assert.equal(result.code,2);
 assert.equal(await readFile(prev,'utf8'),initial);
});

test('R05: 65 synthetic JD rooms partition into seven disjoint bounded scans',async()=>{
 const fleet=Array.from({length:65},(_,i)=>({id:1000+i,platform:'jd',category:'模拟',shop_id:5000+i,bound_session_key:'FAKE'}));
 const read=readerFor({rooms:fleet,total:fleet.length});
 const reports=[];
 for(let i=0;i<7;i++) reports.push(await jd.scanJdSource({reader:read,at,date,shardIndex:i,shardTotal:7}));
 const ids=reports.flatMap(x=>x.rooms.map(r=>r.roomId));
 assert.equal(ids.length,65);
 assert.equal(new Set(ids).size,65);
 assert.ok(reports.every(r=>r.rooms.length<=10 && r.summaryScope==='SHARD_ONLY' && !r.monitoringCoverage.exhaustive));
 assert.ok(reports.every(r=>r.discoveredRoomCount===65));
});
test('R05: unrecognized or conflicting heartbeat structure gives explicit UNKNOWN',async()=>{
 const scan=async(path)=>{
  if(path===jd.SOURCE_ROUTES.rooms) return {rooms:[{id:14,platform:'jd',category:'洗衣机',bound_session_key:'secret'}],total:1};
  if(path===jd.SOURCE_ROUTES.shops) return {shops:[]};
  if(path===jd.SOURCE_ROUTES.heartbeats) return {rooms:[
   {id:14,platform:'jd',last_heartbeat_at:'2026-11-05T11:59:01Z'},
   {id:14,platform:'jd',last_heartbeat_at:'2026-11-05T11:58:00Z'}]};
  return {days:[freshDay]};
 };
 const result=await jd.scanJdSource({reader:scan,at,date});
 assert.equal(result.rooms[0].status,'UNKNOWN');
 assert.equal(result.rooms[0].reason,'HEARTBEAT_SOURCE_UNAVAILABLE');
 assert.ok(result.warnings.includes('HEARTBEATS_SCHEMA_UNVERIFIED'));
});
test('R05: future day cannot inherit yesterday minute counts',()=>{
 const old={date:'2026-11-04',at:at-86_400_000,rooms:[{roomId:'100',date:'2026-11-04',at:at-86_400_000,minuteCount:1000}]};
 const rep={date,catalogStatus:'RECEIVED',rooms:[{roomId:'100',minuteCount:1}]};
 assert.deepEqual(jd.mergePreviousSnapshot(old,rep,at).rooms,[{roomId:'100',date,at,minuteCount:1}]);
});
test('R05: if every room has API error, prior state remains unchanged',()=>{
 const prior={date,at:at-300000,rooms:[{roomId:'100',date,at:at-300000,minuteCount:15}]};
 const report={date,catalogStatus:'RECEIVED',rooms:[{roomId:'100',status:'UNKNOWN',reason:'DAILY_API_ERROR'}]};
 assert.equal(jd.mergePreviousSnapshot(prior,report,at),null);
});
test('R05: stream reads a normal small response correctly',async()=>{
 const reader=jd.networkReader('http://127.0.0.1:3999',async()=>new Response(JSON.stringify({rooms:[],total:0}),{status:200,headers:{'content-type':'application/json'}}));
 const result=await reader(jd.SOURCE_ROUTES.rooms);
 assert.deepEqual(result,{rooms:[],total:0});
});

test('R05: a complete room list is not complete SHOP coverage when shops are unavailable',async()=>{
 const reader=async(path,params)=>{
  if(path===jd.SOURCE_ROUTES.shops) throw Error('SHOPS_DOWN');
  return readerFor()(path,params);
 };
 const report=await jd.scanJdSource({reader,at,date});
 assert.equal(report.roomListScope,'API_DECLARED_COMPLETE');
 assert.equal(report.monitoringCoverage.exhaustive,false);
});
test('R05: no verified shop-room identity join means full coverage remains unconfirmed',async()=>{
 const fleet=validRooms.slice(0,2);
 const reader=async(path,params)=>{
  if(path===jd.SOURCE_ROUTES.rooms) return {rooms:fleet,total:2};
  if(path===jd.SOURCE_ROUTES.shops) return {shops:[{id:999,platform:'jd'}],total:1};
  return readerFor()(path,params);
 };
 const report=await jd.scanJdSource({reader,at,date});
 assert.equal(report.roomListScope,'API_DECLARED_COMPLETE');
 assert.equal(report.monitoringCoverage.exhaustive,false);
});
