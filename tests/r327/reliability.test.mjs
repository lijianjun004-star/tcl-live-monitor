import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {scanFullday} from '../../probes/r327/scan-fullday.mjs';
import {update,report} from '../../probes/r327/jd-fullday.mjs';
import {SOURCE_ROUTES} from '../../probes/lib/tcl-jd-all.mjs';
import {withHistoryTransaction} from '../../probes/lib/history-files.mjs';
import {latestCompletedRun,verifyRestored} from '../../scripts/restore-jd-fullday-state.mjs';
const t=Date.parse('2026-11-18T00:04:00.000Z'),iso=x=>new Date(x).toISOString();
const reader=async(route,params)=>route===SOURCE_ROUTES.rooms?{rooms:[{id:'17',platform:'jd'},{id:'18',platform:'jd'}],total:2}:
  {days:[{date:'2026-11-18',minute_count:74,latest_minute_ts:'2026-11-18T00:03:00.000Z'}]};
const run=(id,conclusion,extra={})=>({id,conclusion,run_attempt:1,status:'completed',head_branch:'main',path:'.github/workflows/jd-fullday-rate.yml',event:'schedule',repository:{id:1,full_name:'lijianjun004-star/tcl-live-monitor'},head_repository:{id:1,full_name:'lijianjun004-star/tcl-live-monitor'},created_at:iso(t+id*1000),...extra});
test('r327 response observation and attempt/completion times are separate',async()=>{
  let tick=t;const scan=await scanFullday({reader,at:t,clock:()=>tick+=1000,pause:async()=>{}});
  assert.equal(scan.attemptedAt,iso(t));assert.equal(scan.rows[0].observedAt,iso(t+1000));
  assert.equal(scan.rows[1].observedAt,iso(t+2000));assert.equal(scan.completedAt,iso(t+3000));
  const s=update(null,scan.rows,scan.completedAt,{sourceStatus:scan.sourceStatus});
  assert.equal(s.days['2026-11-18']['17'].morning.at,iso(t+1000));
  assert.equal(s.lastAttemptedAt,iso(t+3000));assert.equal(s.lastSuccessfulSourceAt,iso(t+2000));
});
test('r327 total failure carries prior evidence without refreshing old observed timestamps',async()=>{
  const scan=await scanFullday({reader,at:t,clock:()=>t,pause:async()=>{}});
  const first=update(null,scan.rows,scan.completedAt);
  const failed=await scanFullday({reader:async()=>{throw Error('PRIVATE_SYNTHETIC_TOKEN');},at:t+60000,clock:()=>t+61000,pause:async()=>{}});
  const next=update(first,failed.rows,failed.completedAt,{sourceStatus:failed.sourceStatus});
  assert.equal(next.lastSuccessfulSourceAt,iso(t));assert.equal(next.lastAttemptedAt,iso(t+61000));
  assert.deepEqual(next.days,first.days);assert.equal(next.rooms['17'].sourceStatus,'UNAVAILABLE');
  const row=report(next).find(r=>r.date==='2026-11-18'&&r.roomId==='17');
  assert.equal(row.observedAt,iso(t));assert.equal(row.currentState,'UNKNOWN');
  assert.doesNotMatch(JSON.stringify(failed),/PRIVATE_SYNTHETIC_TOKEN/);
});
test('r327 invalid single-room daily schema is a visible partial failure preserving the good room',async()=>{
  const scan=await scanFullday({reader:async(route,params)=>route===SOURCE_ROUTES.daily&&params.live_room_id==='18'?{days:[{date:'2026-02-30',minute_count:4}]}:reader(route,params),at:t,clock:()=>t,pause:async()=>{}});
  assert.equal(scan.sourceStatus,'PARTIAL');assert.equal(scan.rows[0].dailyOk,true);assert.equal(scan.rows[1].observedAt,null);
  assert.deepEqual(scan.errors,[{stage:'DAILY',roomId:'18',code:'SCHEMA_DAILY_INVALID'}]);
});
test('r327 empty successful HTTP responses do not refresh historical observation freshness',async()=>{
  const scan=await scanFullday({reader,at:t,clock:()=>t,pause:async()=>{}}),first=update(null,scan.rows,scan.completedAt);
  const empty=await scanFullday({reader:async(route,params)=>route===SOURCE_ROUTES.daily?{days:[]}:reader(route,params),at:t+60000,clock:()=>t+60000,pause:async()=>{}});
  assert.equal(empty.sourceStatus,'FAILED');assert.equal(empty.errors[0].code,'NO_DAILY_OBSERVATIONS');
  const next=update(first,empty.rows,empty.completedAt,{sourceStatus:empty.sourceStatus});
  assert.equal(next.lastSuccessfulSourceAt,first.lastSuccessfulSourceAt);
  assert.equal(next.rooms['17'].lastObservedAt,first.rooms['17'].lastObservedAt);
  assert.equal(next.rooms['17'].sourceStatus,'NO_OBSERVATION');
});
test('restoration selects newer failure or cancellation instead of old success',()=>{
  for(const conclusion of ['failure','cancelled','timed_out']){
    const doc={total_count:2,workflow_runs:[run(1,'success'),run(2,conclusion)]};
    assert.equal(latestCompletedRun(doc).id,2);
  }
  assert.equal(latestCompletedRun({total_count:0,workflow_runs:[]}),null);
  assert.throws(()=>latestCompletedRun({total_count:3,workflow_runs:[]}),/RUN_HISTORY_INCOMPLETE/);
  assert.throws(()=>latestCompletedRun({total_count:1,workflow_runs:[run(2,'success',{head_repository:{id:2}})]}),/RUN_PROVENANCE_INVALID/);
  for(const extra of [{run_attempt:0},{conclusion:'UNKNOWN'},{repository:{id:1,full_name:'foreign/repo'},head_repository:{id:1,full_name:'foreign/repo'}}])
    assert.throws(()=>latestCompletedRun({total_count:1,workflow_runs:[run(2,'success',extra)]}),/RUN_PROVENANCE_INVALID/);
});
test('restoration rejects corrupt, missing, mixed-generation and interrupted artifacts',async()=>{
  const d=fs.mkdtempSync(path.join(os.tmpdir(),'r327-restore-'));
  try{
    const state=update(null,[],t),summary={generatedAt:state.lastRunAt,sourceStatus:'FAILED',rows:[]};
    await withHistoryTransaction({stateOutput:path.join(d,'state.json'),summaryOutput:path.join(d,'report.json')},()=>({state,summary}));
    assert.equal(verifyRestored(d).state.sourceStatus,'FAILED');
    const original=fs.readFileSync(path.join(d,'report.json'));
    fs.writeFileSync(path.join(d,'.jd-history.lock'),'INTERRUPTED_BEFORE_STATE_LOCK');
    assert.throws(()=>verifyRestored(d),/RESTORE_REVIEW_REQUIRED/);
    fs.unlinkSync(path.join(d,'.jd-history.lock'));
    fs.writeFileSync(path.join(d,'report.json'),'{}');assert.throws(()=>verifyRestored(d),/HISTORY_PAIR_MISMATCH/);
    fs.writeFileSync(path.join(d,'report.json'),original);
    fs.writeFileSync(path.join(d,'state.json.lock'),'INTERRUPTED');assert.throws(()=>verifyRestored(d),/RESTORE_REVIEW_REQUIRED/);
  }finally{fs.rmSync(d,{recursive:true,force:true});}
});
test('workflow persists failed attempts and interruptions and has an explicit failure gate',()=>{
  const wf=fs.readFileSync('.github/workflows/jd-fullday-rate.yml','utf8'),restore=fs.readFileSync('scripts/restore-jd-fullday-state.sh','utf8');
  assert.doesNotMatch(restore,/--status success|\|\| true/);
  assert.match(restore,/status=completed/);assert.match(restore,/recovery-block\.json/);
  assert.match(wf,/continue-on-error: true/);assert.match(wf,/out\/state\.json\.lock/);
  assert.match(wf,/Final source and persistence gate/);assert.match(wf,/SAVE_OUTCOME/);
  assert.match(wf,/out\/\.jd-history\.lock/);assert.match(wf,/include-hidden-files: true/);
  assert.match(wf,/retention-days: 7/);assert.match(wf,/非正式满播率或考核结果/);
});
