import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {sourceError} from '../probes/lib/source-error.mjs';
import {networkReader,scanJdSource,SOURCE_ROUTES,mergePreviousSnapshot} from '../probes/lib/tcl-jd-all.mjs';
import {acceptJdOpsScan} from '../probes/r21/accept-jd-ops-scan.mjs';
import {updateJdHistory,latestPublicSummary,validateState} from '../probes/r23/jd-history.mjs';
const at=Date.parse('2026-11-17T02:00:00Z'),iso=t=>new Date(t).toISOString(),secret='https://SYNTHETIC_SECRET.invalid/?token=SYNTHETIC_TOKEN';
const err=code=>Object.assign(new Error(secret),{cause:{code}});
const fixture=(failed=[])=>async(route,params)=>{
 if(route===SOURCE_ROUTES.rooms)return {rooms:[17,18].map(id=>({id,platform:'jd',shop_id:id+100,bound_session_key:'SYNTHETIC_KEY'})),total:2};
 if(route===SOURCE_ROUTES.shops)return {shops:[17,18].map(id=>({id:id+100,platform:'jd'})),total:2};
 if(route===SOURCE_ROUTES.heartbeats)return {rooms:[17,18].map(id=>({id,last_heartbeat_at:iso(at)}))};
 if(failed.includes(params.live_room_id))throw err('UND_ERR_CONNECT_TIMEOUT');
 return {days:[{date:'2026-11-17',minute_count:4,latest_minute_ts:iso(at),latest:{status:1}}]};
};
const accepted=(scan,now)=>acceptJdOpsScan(scan,{now:iso(now)});
test('bounded error taxonomy never emits arbitrary messages, URL, body or credentials',()=>{
 for(const [code,want] of [['UND_ERR_CONNECT_TIMEOUT','CONNECT_TIMEOUT'],['EAI_AGAIN','DNS_FAILURE'],['ECONNREFUSED','CONNECTION_REFUSED'],['ECONNRESET','CONNECTION_RESET'],['UND_ERR_BODY_TIMEOUT','TIMEOUT'],['CERT_HAS_EXPIRED','TLS_FAILURE']])assert.equal(sourceError(err(code)),want);
 assert.equal(sourceError(new Error(secret)),'SOURCE_ERROR');
 assert.equal(sourceError(Object.assign(new Error(secret),{name:'AbortError'})),'ABORTED');
});
test('HTTP access/rate/server classes and JSON failures are sanitized; no retries',async()=>{
 for(const [status,want] of [[401,'HTTP_ACCESS_DENIED'],[403,'HTTP_ACCESS_DENIED'],[429,'HTTP_RATE_LIMITED'],[503,'HTTP_SERVER_ERROR'],[404,'HTTP_ERROR']]){
  let calls=0;const read=networkReader('https://synthetic.invalid',async()=>{calls++;return {ok:false,status};});
  await assert.rejects(read(SOURCE_ROUTES.rooms),new RegExp(want));assert.equal(calls,1);
 }
 const read=networkReader('https://synthetic.invalid',async()=>({ok:true,headers:{get:()=>null},text:async()=>secret}));
 await assert.rejects(read(SOURCE_ROUTES.rooms),/INVALID_JSON/);
});
test('catalog failure makes exactly one injected request, FAILED diagnostic with no secret',async()=>{
 let calls=0;const scan=await scanJdSource({at,clock:()=>at+1000,reader:async()=>{calls++;throw err('UND_ERR_CONNECT_TIMEOUT');}});
 assert.equal(calls,1);assert.equal(scan.samplingStatus,'FAILED');assert.equal(scan.completedAt,iso(at+1000));
 assert.deepEqual(scan.errors,[{stage:'CATALOG',code:'CONNECT_TIMEOUT'}]);assert.equal(scan.summary,null);
 assert.doesNotMatch(JSON.stringify(scan),/SYNTHETIC_SECRET|SYNTHETIC_TOKEN/);
});
test('partial failure preserves good room and last valid failed-room evidence timestamps',async()=>{
 const full=await scanJdSource({reader:fixture(),at,clock:()=>at+1000});
 const first=updateJdHistory(null,accepted(full,at+2000),{now:iso(at+2000),run_id:'full'});
 assert.equal(first.counts.LIVE,2);assert.equal(first.state.rooms['17'].first_live_seen_at,iso(at+1000));
 const partial=await scanJdSource({reader:fixture(['18']),at:at+60000,clock:()=>at+61000});
 assert.equal(partial.samplingStatus,'PARTIAL');assert.equal(partial.summary.LIVE,1);assert.equal(partial.rooms[1].observedAt,null);
 const next=updateJdHistory(first.state,accepted(partial,at+62000),{now:iso(at+62000),run_id:'partial'});
 assert.equal(next.counts.UNKNOWN,1);assert.equal(next.counts.OFFLINE,0);
 assert.equal(next.state.rooms['18'].last_observed_at,iso(at+1000));
 assert.equal(next.state.rooms['17'].last_live_seen_at,iso(at+61000));
 assert.equal(next.state.last_attempted_at,iso(at+62000));assert.equal(next.state.last_successful_source_at,iso(at+61000));
 assert.equal(next.state.rooms['18'].actual_ended_at,null);
 const fresh=await scanJdSource({reader:fixture(),at:at+120000});
 const restored=updateJdHistory(JSON.parse(JSON.stringify(next.state)),accepted(fresh,at+121000),{now:iso(at+121000),run_id:'restored'});
 assert.equal(restored.counts.LIVE,2);assert.equal(restored.state.rooms['18'].actual_started_at,null);
});
test('total failure records attempt without refreshing success or historical observation time',async()=>{
 const scan=await scanJdSource({reader:fixture(),at});
 const first=updateJdHistory(null,accepted(scan,at),{now:iso(at),run_id:'one'});
 const failure=await scanJdSource({reader:fixture(['17','18']),at:at+60000});
 assert.equal(failure.samplingStatus,'FAILED');
 const second=updateJdHistory(first.state,accepted(failure,at+60000),{now:iso(at+60000),run_id:'two'});
 assert.equal(second.source_accepted,false);assert.equal(second.counts.UNKNOWN,2);
 assert.equal(second.state.last_successful_source_at,iso(at));assert.equal(second.state.last_checked_at,iso(at+60000));
 assert.equal(latestPublicSummary(second.state,iso(at+60000)).source_fresh,false);
 assert.equal(mergePreviousSnapshot(null,failure,at+60000),null);
 const duplicate=updateJdHistory(second.state,null,{now:iso(at+60000),run_id:'two'});assert.equal(duplicate.duplicate,true);
});
test('late evidence uses source observation time; invalid persisted times reject recovery',async()=>{
 const scan=await scanJdSource({reader:fixture(),at});
 const first=updateJdHistory(null,accepted(scan,at+600000),{now:iso(at+600000),run_id:'one'});
 assert.equal(first.state.rooms['17'].last_live_seen_at,iso(at));
 assert.equal(latestPublicSummary(first.state,iso(at+1000000)).observed_live,0);
 assert.equal(latestPublicSummary(first.state,iso(at+1000000)).source_fresh,false);
 for(const field of ['last_checked_at','last_successful_source_at'])assert.throws(()=>validateState({...first.state,[field]:'invalid'}),/BAD_PERSISTED_TIME/);
 assert.throws(()=>updateJdHistory(first.state,accepted(scan,at),{now:iso(at),run_id:'old'}),/CLOCK_MOVED_BACKWARD/);
});
test('CLI injected failure emits safe report and nonzero; corrupt prior stops before any source request',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'jd-cli-offline-'));
 try {
  fs.writeFileSync(dir+'/mock.mjs',`globalThis.fetch=async()=>{throw Object.assign(new Error(${JSON.stringify(secret)}),{cause:{code:'UND_ERR_CONNECT_TIMEOUT'}})};`);
  const run=args=>spawnSync(process.execPath,['--import',dir+'/mock.mjs','probes/tcl-jd-all.mjs',...args],{encoding:'utf8',env:{...process.env,TCL_OPS_BASE_URL:'https://synthetic.invalid'}});
  let r=run(['--output',dir+'/safe.json']);assert.equal(r.status,2);assert.doesNotMatch(r.stderr+r.stdout,/SYNTHETIC_SECRET|SYNTHETIC_TOKEN/);
  assert.equal(JSON.parse(fs.readFileSync(dir+'/safe.json')).errors[0].code,'CONNECT_TIMEOUT');
  fs.writeFileSync(dir+'/bad.json','{}');r=run(['--previous',dir+'/bad.json','--output',dir+'/new.json']);
  assert.equal(r.status,2);assert.match(r.stderr,/PRIOR_STATE_INVALID/);assert.equal(fs.existsSync(dir+'/new.json'),false);
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test('older successful report cannot undo a newer failed attempt',async()=>{
 const scan=await scanJdSource({reader:fixture(),at});
 const first=updateJdHistory(null,accepted(scan,at),{now:iso(at),run_id:'one'});
 const failed=updateJdHistory(first.state,null,{now:iso(at+60000),run_id:'failed'});
 const replay=updateJdHistory(failed.state,accepted(scan,at+120000),{now:iso(at+120000),run_id:'replay'});
 assert.equal(replay.source_accepted,false);assert.equal(replay.counts.LIVE,0);assert.equal(replay.counts.UNKNOWN,2);
 assert.equal(replay.state.last_successful_source_at,iso(at));assert.equal(replay.state.rooms['17'].last_live_seen_at,iso(at));
});
