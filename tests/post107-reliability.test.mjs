import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';
import {updateJdHistory,validateState,latestPublicSummary} from '../probes/r23/jd-history.mjs';
import {restore,block} from '../scripts/tmall-ledger-recovery.mjs';
const now='2026-11-17T10:00:00.000Z';
const report={schema_version:21,platform:'jd',source:'TCL_OPS_READ_ONLY',checked_at:now,readiness:'OBSERVED',room_count:1,live:1,unknown:0,offline:0,formal_opening_rate_percent:null,formal_attendance_ready:false,fully_verified_public_accounts:false,fully_verified_schedule:false,rooms:[{room_id:'17',shop_id:'18',state:'LIVE',observed_at:now}]};
const initial=()=>updateJdHistory(null,report,{now,run_id:'synthetic-1'}).state;
const temp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'post107-'));
test('persisted JD room key cannot silently change identity',()=>{
 const s=initial();s.rooms['17'].room_id='19';assert.throws(()=>validateState(s),/BAD_PERSISTED_ROOM/);
});
test('persisted JD observation chronology rejects reversed and future evidence',()=>{
 for(const change of [{first_live_seen_at:'2026-11-17T10:01:00.000Z'},{last_observed_at:'2026-11-18T10:00:00.000Z'}]){
  const s=initial();Object.assign(s.rooms['17'],change);assert.throws(()=>validateState(s),/BAD_PERSISTED_TIME_ORDER/);
 }
});
test('within accepted clock tolerance, future room evidence still cannot display current LIVE',()=>{
 const s=initial();s.rooms['17'].last_observed_at='2026-11-17T10:00:30.000Z';
 assert.equal(latestPublicSummary(s,now).rooms[0].current_state,'UNKNOWN');
});
test('source failure cannot display stale LIVE even with recently persisted LIVE row',()=>{
 const s=initial();s.last_source_attempt_accepted=false;
 const r=latestPublicSummary(s,now);assert.equal(r.source_fresh,false);assert.equal(r.rooms[0].current_state,'UNKNOWN');
});
test('invalid freshness limits cannot extend acceptance indefinitely',()=>{
 for(const maxAgeMs of [Infinity,NaN,-1,0,1.5])assert.throws(()=>updateJdHistory(null,report,{now,run_id:'synthetic',maxAgeMs}),/BAD_FRESHNESS_LIMIT/);
});
test('JD CLI missing explicit previous state blocks without replacing output',()=>{
 const dir=temp();try{
  const state=dir+'/state.json';fs.writeFileSync(state,'PRESERVE_SYNTHETIC');
  const r=spawnSync(process.execPath,['probes/r23/run-history.mjs','--previous',dir+'/missing','--state-output',state,'--summary-output',dir+'/summary','--run-id','synthetic'],{encoding:'utf8'});
  assert.equal(r.status,1);assert.equal(fs.readFileSync(state,'utf8'),'PRESERVE_SYNTHETIC');assert.equal(r.stderr.trim(),'JD_HISTORY_OPERATION_BLOCKED');assert.equal(fs.existsSync(dir+'/summary'),false);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('JD CLI rejects symlink inputs, same outputs and corrupt private input without echo',()=>{
 const dir=temp();try{
  fs.writeFileSync(dir+'/private','PRIVATE_SYNTHETIC_MARKER');fs.symlinkSync(dir+'/private',dir+'/alias');
  for(const previous of [dir+'/private',dir+'/alias']){
   const r=spawnSync(process.execPath,['probes/r23/run-history.mjs','--previous',previous,'--state-output',dir+'/state','--summary-output',dir+'/summary','--run-id','synthetic'],{encoding:'utf8'});
   assert.equal(r.status,1);assert.equal(r.stderr.trim(),'JD_HISTORY_OPERATION_BLOCKED');assert.equal(fs.existsSync(dir+'/state'),false);
  }
  const r=spawnSync(process.execPath,['probes/r23/run-history.mjs','--state-output',dir+'/same','--summary-output',dir+'/same','--run-id','synthetic'],{encoding:'utf8'});assert.equal(r.status,1);assert.equal(fs.existsSync(dir+'/same'),false);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('Tmall restore cannot overwrite a newer local cooldown or local ledger',()=>{
 const dir=temp();try{
  for(const name of ['state.json','cooldown.json']){
   const output=dir+'/'+name.replace('.','-');fs.mkdirSync(output);fs.writeFileSync(output+'/'+name,'SYNTHETIC_LOCAL_BYTES');
   const r=restore(dir+'/missing-previous',output,{id:100},null,Date.parse(now));assert.equal(r.skip,true);assert.equal(r.reason,'LOCAL_STATE_REQUIRES_REVIEW');assert.equal(fs.readFileSync(output+'/'+name,'utf8'),'SYNTHETIC_LOCAL_BYTES');
  }
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('Tmall local stop remains nonreviewable across repeated restore attempts',()=>{
 const dir=temp();try{
  block(dir,'SOURCE_STOP_REVIEW_REQUIRED','99');
  for(let i=0;i<2;i++){const r=restore(dir+'/missing',dir,{id:100},null,Date.parse(now));assert.equal(r.reason,'LOCAL_STATE_REQUIRES_REVIEW');assert.equal(JSON.parse(fs.readFileSync(dir+'/recovery-block.json')).reason,'LOCAL_STATE_REQUIRES_REVIEW');}
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('JD CLI intentional empty bootstrap works offline and missing source remains unverified',()=>{
 const dir=temp();try{
  const r=spawnSync(process.execPath,['probes/r23/run-history.mjs','--report',dir+'/missing-source','--state-output',dir+'/state','--summary-output',dir+'/summary','--run-id','synthetic'],{encoding:'utf8'});
  assert.equal(r.status,0,r.stderr);const summary=JSON.parse(fs.readFileSync(dir+'/summary'));assert.equal(summary.source_evidence_accepted,false);assert.equal(summary.observed_live,0);assert.equal(summary.room_count,0);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
