import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {update, reading, validateState, report} from '../probes/r327/jd-fullday.mjs';

const at='2026-11-18T00:04:00.000Z';
const dir=()=>fs.mkdtempSync(path.join(os.tmpdir(),'jd-defects-'));
const row={roomId:'17',category:'SYNTHETIC',captureBound:true,dailyOk:true,
  days:[{date:'2026-11-18',minute_count:74,latest_minute_ts:'2026-11-18T00:03:00.000Z'}]};
const cli=(directory,previous,mode='catalog-failure')=>{
  const mock=path.join(directory,'mock.mjs');
  fs.writeFileSync(mock,`const NativeDate=Date;globalThis.Date=class extends NativeDate{constructor(...a){super(...(a.length?a:[${JSON.stringify(at)}]))}static now(){return NativeDate.parse(${JSON.stringify(at)})}};
globalThis.fetch=async(url)=>{
 if(${JSON.stringify(mode)}==='catalog-failure')throw new Error('SYNTHETIC_PRIVATE_URL_TOKEN');
 const u=new URL(url);let body;
 if(u.pathname==='/api/capture/rooms')body={rooms:[{id:'17',platform:'jd'},{id:'18',platform:'jd'}],total:2};
 else {if(u.searchParams.get('live_room_id')==='18')throw new Error('SYNTHETIC_PRIVATE_URL_TOKEN');body={days:[{date:'2026-11-18',minute_count:74,latest_minute_ts:'2026-11-18T00:03:00.000Z'}]};}
 return {ok:true,status:200,headers:{get:()=>null},text:async()=>JSON.stringify(body)};
};`);
  return spawnSync(process.execPath,['--import',pathToFileURL(mock).href,'probes/r327/jd-fullday-cli.mjs',
    '--previous',previous,'--state-output',path.join(directory,'state.json'),'--report-output',path.join(directory,'report.json')],
    {encoding:'utf8',env:{...process.env,TCL_OPS_BASE_URL:'https://synthetic.invalid'}});
};

test('r327 missing day is unknown capture evidence, never invented zero minutes',()=>{
  const s=update(null,[{...row,days:[]}],at);
  assert.equal(s.days['2026-11-17']?.['17']?.final??null,null);
});
test('r327 null/blank/boolean minute counts cannot coerce to a measured zero',()=>{
  for(const value of [null,'',true,false,'  '])assert.equal(reading({minute_count:value},at).minuteCount,null);
});
test('r327 corrupted retained reading refuses restore',()=>{
  const s=update(null,[row],at);s.days['2026-11-18']['17'].morning.at='PRIVATE_BAD_TIME';
  assert.throws(()=>validateState(s),/BAD_STATE/);
});
test('r327 reversed clock cannot replace evidence with an older run',()=>{
  const s=update(null,[row],at);
  assert.throws(()=>update(s,[row],'2026-11-17T23:59:00.000Z'),/CLOCK_MOVED_BACKWARD/);
});
test('r327 report labels retained observations as historical and no formal attendance rate',()=>{
  const s=update(null,[row],at),r=report(s)[0];
  assert.equal(r.currentState,'UNKNOWN');assert.equal(r.formalAttendanceReady,false);
  assert.equal(r.observedAt,at);assert.equal(r.formalRatePercent,null);
});
test('r327 catalog failure safely persists failed attempt and uses nonzero exit',()=>{
  const d=dir();try{
    const r=cli(d,'-');assert.equal(r.status,2,r.stderr);
    assert.doesNotMatch(r.stdout+r.stderr,/SYNTHETIC_PRIVATE_URL_TOKEN/);
    const s=JSON.parse(fs.readFileSync(path.join(d,'state.json')));
    assert.equal(s.sourceStatus,'FAILED');assert.equal(s.lastAttemptedAt,at);assert.equal(s.lastSuccessfulSourceAt,null);
  }finally{fs.rmSync(d,{recursive:true,force:true});}
});
test('r327 partial failure saves good rows, exposes failed room and exits nonzero',()=>{
  const d=dir();try{
    const r=cli(d,'-','partial');assert.equal(r.status,2,r.stderr);
    assert.doesNotMatch(r.stdout+r.stderr,/SYNTHETIC_PRIVATE_URL_TOKEN/);
    const s=JSON.parse(fs.readFileSync(path.join(d,'state.json')));
    assert.equal(s.days['2026-11-18']['17'].latest.minuteCount,74);
    assert.equal(s.sourceStatus,'PARTIAL');assert.equal(s.rooms['18'].sourceStatus,'FAILED');
    assert.equal(s.lastSuccessfulSourceAt,at);
  }finally{fs.rmSync(d,{recursive:true,force:true});}
});
test('r327 explicit missing previous blocks before source and cannot initialize',()=>{
  const d=dir();try{
    const r=cli(d,path.join(d,'missing.json'));assert.equal(r.status,2);
    assert.equal(fs.existsSync(path.join(d,'state.json')),false);
    assert.doesNotMatch(r.stdout+r.stderr,/SYNTHETIC_PRIVATE_URL_TOKEN/);
  }finally{fs.rmSync(d,{recursive:true,force:true});}
});
test('r23 unwritable paired summary is rejected before replacing state',()=>{
  const d=dir();try{
    const state=path.join(d,'state.json'),summary=path.join(d,'summary');
    fs.writeFileSync(state,'PRESERVE_STATE');fs.mkdirSync(summary);
    const r=spawnSync(process.execPath,['probes/r23/run-history.mjs','--state-output',state,'--summary-output',summary,'--run-id','synthetic'],{encoding:'utf8'});
    assert.equal(r.status,1);assert.equal(fs.readFileSync(state,'utf8'),'PRESERVE_STATE');
  }finally{fs.rmSync(d,{recursive:true,force:true});}
});
