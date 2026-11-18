import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {decideRestore,restore,snapshot,recordStop,block,finishSample,beginSample} from '../scripts/tmall-ledger-recovery.mjs';
import {importReceipt} from '../probes/r322/observation-ledger.mjs';
const now=Date.parse('2026-11-17T08:00:00.000Z'),DAY=86400000,iso=t=>new Date(t).toISOString();
const files=['state.json','cooldown.json','recovery-block.json','recovery-reviewed.json','restore-manifest.json'];
const run=(id=100,conclusion='success')=>({id,run_attempt:1,status:'completed',conclusion,head_branch:'main',event:'schedule',path:'.github/workflows/tmall-daily-broadcast.yml',repository:{full_name:'lijianjun004-star/tcl-live-monitor'},head_repository:{full_name:'lijianjun004-star/tcl-live-monitor'}});
const write=(p,x)=>{fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,JSON.stringify(x));};
const bytes=dir=>Object.fromEntries(files.map(f=>[f,fs.existsSync(dir+'/'+f)?fs.readFileSync(dir+'/'+f):null]));
const ledger=at=>importReceipt(null,{schemaVersion:319,platform:'tmall',at:iso(at),checked:[{key:'synthetic-shop',at:iso(at),state:'UNKNOWN',reason:'SYNTHETIC_ONLY'}]},{platform:'tmall',evidenceKind:'real'}); // Schema-real simulation, no real observation.
function fixture(cooldown=null){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tmall-recovery-'));write(dir+'/state.json',ledger(now));if(cooldown!==null)write(dir+'/cooldown.json',cooldown);snapshot(dir,{runId:'100',runAttempt:1,now});return dir;}
const decide=(dir,extras={})=>decideRestore({bytes:bytes(dir),run:run(),now,...extras});
const cleanup=dir=>fs.rmSync(dir,{recursive:true,force:true});
function approval(dir,r=run()) {return {schemaVersion:1,reason:'RESTORE_CHAIN_REVIEWED',runId:String(r.id),runAttempt:r.run_attempt,files:Object.fromEntries(Object.entries(bytes(dir)).map(([f,b])=>[f,b===null?null:createHash('sha256').update(b).digest('hex')])),approvedBy:'owner',approvalUrl:'https://github.com/lijianjun004-star/tcl-live-monitor/issues/1#issuecomment-123',approvedAt:iso(now-1000),expiresAt:iso(now+60000)};}

test('manifest explicitly attests absent cooldown; plain missing legacy file never grants access',()=>{
 const dir=fixture();try{assert.equal(decide(dir).skip,false);fs.rmSync(dir+'/restore-manifest.json');assert.equal(decide(dir).skip,true);}finally{cleanup(dir);}
});
test('active cooldown blocks, exact 24h boundary permits only an otherwise verified chain',()=>{
 for(const age of [0,DAY-1,DAY,DAY+1]){const dir=fixture({stoppedAt:iso(now-age)});try{assert.equal(decide(dir).skip,age<DAY);}finally{cleanup(dir);}}
});
test('missing expected cooldown, invalid/future/rolled-over dates, null and garbage all block',()=>{
 for(const value of [null,{}, {stoppedAt:'bad'},{stoppedAt:'2026-02-30T00:00:00.000Z'},{stoppedAt:iso(now+1)},{stoppedAt:42},{stoppedAt:iso(now-DAY),token:'SYNTHETIC_SECRET'}]){
  const dir=fixture({stoppedAt:iso(now-DAY)});try{write(dir+'/cooldown.json',value);assert.equal(decide(dir).skip,true);}finally{cleanup(dir);}
 }
 const dir=fixture({stoppedAt:iso(now-DAY)});try{fs.rmSync(dir+'/cooldown.json');assert.equal(decide(dir).reason,'MANIFEST_INTEGRITY_INVALID');}finally{cleanup(dir);}
});
test('missing/corrupt/stale/future/synthetic/wrong-platform ledger cannot silently reset',()=>{
 for(const variant of ['missing','json','schema','stale','future','synthetic','platform']){
  const dir=fixture();try{
   if(variant==='missing')fs.rmSync(dir+'/state.json');
   else if(variant==='json')fs.writeFileSync(dir+'/state.json','SYNTHETIC_SECRET');
   else {let s=ledger(variant==='stale'?now-8*DAY:variant==='future'?now+1:now);if(variant==='schema')s={};if(variant==='synthetic')s.evidenceKind='synthetic';if(variant==='platform')s.observations[0].platform='douyin';write(dir+'/state.json',s);}
   assert.equal(decide(dir).skip,true,variant);
  }finally{cleanup(dir);}
 }
});
test('manifest corruption, different run/attempt, future timestamp and missing blocked marker fail closed',()=>{
 for(const change of [m=>m.runId='99',m=>m.runAttempt=2,m=>m.savedAt=iso(now+1),m=>delete m.files['cooldown.json'],m=>m.files['state.json']='0'.repeat(64)]){
  const dir=fixture();try{const m=JSON.parse(fs.readFileSync(dir+'/restore-manifest.json'));change(m);write(dir+'/restore-manifest.json',m);assert.equal(decide(dir).skip,true);}finally{cleanup(dir);}
 }
 const dir=fixture();try{block(dir,'REVIEW_REQUIRED','99');snapshot(dir,{runId:'100',runAttempt:1,now});fs.rmSync(dir+'/recovery-block.json');assert.equal(decide(dir).skip,true);}finally{cleanup(dir);}
});
test('foreign repo/branch/workflow/event, unfinished run and missing conclusion never authorize recovery',()=>{
 const dir=fixture();try{for(const change of [{head_branch:'feature'},{event:'pull_request'},{path:'.github/workflows/other.yml'},{status:'in_progress'},{conclusion:null},{repository:{full_name:'elsewhere/repo'}},{head_repository:{full_name:'elsewhere/repo'}}])assert.equal(decide(dir,{run:{...run(),...change}}).skip,true);}finally{cleanup(dir);}
});
test('failed run with fresh stop is restored and block survives later successful skipped runs',()=>{
 const a=fixture({stoppedAt:iso(now-1000)}),b=fs.mkdtempSync(path.join(os.tmpdir(),'tmall-next-')),c=fs.mkdtempSync(path.join(os.tmpdir(),'tmall-third-'));
 try{
  const d=restore(a,b,run(100,'failure'),null,now);assert.equal(d.skip,true);
  assert.deepEqual(JSON.parse(fs.readFileSync(b+'/cooldown.json')),{stoppedAt:iso(now-1000)});
  assert.deepEqual(JSON.parse(fs.readFileSync(b+'/state.json')),ledger(now));
  snapshot(b,{runId:'200',runAttempt:1,now:now+2000});
  const next=restore(b,c,run(200),null,now+DAY+2000);assert.equal(next.skip,true);assert.equal(next.reason,'PERSISTENT_REVIEW_REQUIRED');
 }finally{[a,b,c].forEach(cleanup);}
});
test('review receipt requires exact bytes/run/attempt, valid owner reference, expiry and no extra payload',()=>{
 const dir=fixture();try{
  block(dir,'REVIEW_REQUIRED','99');snapshot(dir,{runId:'100',runAttempt:1,now});const a=approval(dir);
  assert.equal(decide(dir,{approval:a}).skip,false);
  for(const c of [{runId:'99'},{runAttempt:2},{expiresAt:iso(now)},{approvedAt:iso(now+1)},{approvalUrl:'https://other.invalid'},{files:{...a.files,'state.json':null}},{extra:'SYNTHETIC_SECRET'}])assert.equal(decide(dir,{approval:{...a,...c}}).skip,true);
  fs.writeFileSync(dir+'/cooldown.json','bad');assert.equal(decide(dir,{approval:approval(dir)}).skip,true);
 }finally{cleanup(dir);}
});
test('review cannot override active cooldown or invalid ledger; legacy absent manifest needs exact explicit review',()=>{
 const dir=fixture({stoppedAt:iso(now-1000)});try{assert.equal(decide(dir,{approval:approval(dir)}).skip,true);
  write(dir+'/cooldown.json',{stoppedAt:iso(now-DAY)});fs.rmSync(dir+'/restore-manifest.json');assert.equal(decide(dir).skip,true);
  assert.equal(decide(dir,{approval:approval(dir)}).skip,false);
  fs.rmSync(dir+'/state.json');assert.equal(decide(dir,{approval:approval(dir)}).skip,true);
 }finally{cleanup(dir);}
});
test('snapshot publishes durable block without ledger and removes malformed output instead of blessing it',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tmall-missing-'));try{
  write(dir+'/cooldown.json',{stoppedAt:iso(now)});snapshot(dir,{runId:'100',runAttempt:1,now});
  assert.equal(fs.existsSync(dir+'/recovery-block.json'),true);assert.equal(JSON.parse(fs.readFileSync(dir+'/restore-manifest.json')).files['state.json'],null);
  write(dir+'/state.json',{secret:'SYNTHETIC_SECRET'});snapshot(dir,{runId:'100',runAttempt:1,now});assert.equal(fs.existsSync(dir+'/state.json'),false);
  assert.doesNotMatch(fs.readFileSync(dir+'/restore-manifest.json','utf8'),/SYNTHETIC_SECRET/);
 }finally{cleanup(dir);}
});
test('stop receipt, nonzero exit, missing and corrupt receipt persist cooldown before importer',()=>{
 for(const [code,receipt] of [[3,{schemaVersion:319,platform:'tmall',at:iso(now),stopped:'HTTP_403',checked:[]}],[0,{schemaVersion:319,platform:'tmall',at:iso(now),stopped:'HTTP_429',checked:[]}],[1,null],[0,{bad:true}]]){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tmall-stop-'));try{
   if(receipt)write(dir+'/receipt.json',receipt);block(dir,'SAMPLE_INCOMPLETE');
   assert.equal(recordStop(dir,dir+'/receipt.json',code,now),true);
   assert.equal(JSON.parse(fs.readFileSync(dir+'/cooldown.json')).stoppedAt,iso(now));
   assert.equal(fs.existsSync(dir+'/recovery-block.json'),true);
  }finally{cleanup(dir);}
 }
});

function shellFixture() {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tmall-shell-'));
 for(const sub of ['scripts','probes/r322','probes/r329','fixture','bin','config'])fs.mkdirSync(dir+'/'+sub,{recursive:true});
 for(const file of ['scripts/tmall-ledger-recovery.mjs','scripts/recovery-file-store.mjs','scripts/restore-tmall-ledger.sh','scripts/tmall-sample-once.sh','probes/r322/observation-ledger.mjs'])fs.copyFileSync(file,dir+'/'+file);
 fs.writeFileSync(dir+'/bin/gh',`#!/bin/bash
set -e
case "$1 $2" in
 'run list') [ "$FAIL_STAGE" != list ]; echo '[{"databaseId":100}]';;
 'api '*) [ "$FAIL_STAGE" != api ]; cat fixture/run.json;;
 'run download') [ "$FAIL_STAGE" != download ]; cp fixture/*.json prev/;;
 *) exit 2;;
esac
`,{mode:0o755});
 const env={...process.env,PATH:dir+'/bin'+path.delimiter+process.env.PATH,GITHUB_OUTPUT:dir+'/outputs',GITHUB_REPOSITORY:'lijianjun004-star/tcl-live-monitor',GITHUB_RUN_ID:'200',GITHUB_RUN_ATTEMPT:'1',FAIL_STAGE:''};
 return {dir,env,run:script=>spawnSync('bash',[script],{cwd:dir,env,encoding:'utf8'})};
}
test('actual restore shell: list/API/download failures default closed and persist sentinel',()=>{
 for(const stage of ['list','api','download']){
  const f=shellFixture();try{f.env.FAIL_STAGE=stage;write(f.dir+'/fixture/run.json',run());
   const r=f.run('scripts/restore-tmall-ledger.sh');assert.notEqual(r.status,0);assert.doesNotMatch(fs.readFileSync(f.dir+'/outputs','utf8'),/skip=false/);assert.equal(fs.existsSync(f.dir+'/out/ledger/recovery-block.json'),true);
  }finally{cleanup(f.dir);}
 }
});
test('actual restore shell selects completed failure instead of older success and never runs collector',()=>{
 const f=shellFixture();try{
  const t=Date.now();write(f.dir+'/fixture/state.json',ledger(t));write(f.dir+'/fixture/cooldown.json',{stoppedAt:iso(t-1000)});
  snapshot(f.dir+'/fixture',{runId:'100',runAttempt:1,now:t});write(f.dir+'/fixture/run.json',run(100,'failure'));
  const r=f.run('scripts/restore-tmall-ledger.sh');assert.equal(r.status,0,r.stderr);assert.doesNotMatch(fs.readFileSync(f.dir+'/outputs','utf8'),/skip=false/);
  assert.equal(fs.existsSync(f.dir+'/out/ledger/cooldown.json'),true);
  const src=fs.readFileSync('scripts/restore-tmall-ledger.sh','utf8');assert.match(src,/--status completed/);assert.doesNotMatch(src,/--status success|\|\| true/);
 }finally{cleanup(f.dir);}
});
test('actual one-pass wrapper keeps new stop if import fails, and missing receipt blocks with no state',()=>{
 for(const missing of [false,true]){
  const f=shellFixture();try{
   fs.writeFileSync(f.dir+'/probes/r329/tmall-daily-once.mjs',missing?'process.exit(1);':`import fs from 'node:fs';fs.mkdirSync('out',{recursive:true});fs.writeFileSync('out/tmall-receipt.json',JSON.stringify({schemaVersion:319,platform:'tmall',at:new Date().toISOString(),stopped:'HTTP_403',checked:[]}));process.exit(3);`);
   fs.writeFileSync(f.dir+'/probes/r322/import-receipt.mjs',`import fs from 'node:fs';if(!fs.existsSync('out/ledger/cooldown.json'))process.exit(99);process.exit(1);`);
   const r=f.run('scripts/tmall-sample-once.sh');assert.equal(r.status,1);assert.match(r.stdout,/TMALL_LEDGER_IMPORT_FAILED/);
   assert.equal(fs.existsSync(f.dir+'/out/ledger/cooldown.json'),true);assert.equal(fs.existsSync(f.dir+'/out/ledger/recovery-block.json'),true);
  }finally{cleanup(f.dir);}
 }
});
test('healthy sample clears only its own sentinel and cannot erase an existing review block',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tmall-finish-'));try{
  const t=Date.now();write(dir+'/receipt.json',{schemaVersion:319,platform:'tmall',at:iso(t),stopped:null,checked:[]});write(dir+'/state.json',ledger(t));
  block(dir,'PERSISTENT_REVIEW_REQUIRED');assert.throws(()=>finishSample(dir,dir+'/receipt.json',0),/BLOCK_NOT_OWNED/);
  fs.rmSync(dir+'/recovery-block.json');
  beginSample(dir,{runId:'200',runAttempt:1,now:t-1});finishSample(dir,dir+'/receipt.json',0,{runId:'200',runAttempt:1});assert.equal(fs.existsSync(dir+'/recovery-block.json'),false);
 }finally{cleanup(dir);}
});
test('workflow requires affirmative gate and uploads marker/manifest even with missing state; triggers unchanged',()=>{
 const wf=fs.readFileSync('.github/workflows/tmall-daily-broadcast.yml','utf8');
 assert.equal((wf.match(/steps.gate.outcome == 'success' && steps.gate.outputs.skip == 'false'/g)||[]).length,2);
 assert.match(wf,/hashFiles\('out\/ledger\/state.json'\) != '' \|\| hashFiles\('out\/ledger\/recovery-block.json'\)/);
 assert.match(wf,/if: always\(\)\n        run: node scripts\/tmall-ledger-recovery.mjs snapshot/);
 assert.match(wf,/out\/ledger\/restore-manifest.json/);assert.match(wf,/retention-days: 7/);
 assert.doesNotMatch(wf,/pull_request|\n  push:|contents: write|actions: write/);
 assert.match(wf,/cron: '47 0-16\/2 \* \* \*'/);
});

test('corrupt safety lineage cannot be laundered into an approvable absent-cooldown snapshot',()=>{
 const a=fixture({stoppedAt:iso(now-DAY)}),b=fs.mkdtempSync(path.join(os.tmpdir(),'tmall-launder-'));
 try{
  fs.rmSync(a+'/cooldown.json');assert.equal(restore(a,b,run(),null,now).skip,true);
  snapshot(b,{runId:'200',runAttempt:1,now});
  assert.equal(decide(b,{run:run(200),approval:approval(b,run(200))}).reason,'PERSISTENT_SAFETY_UNVERIFIED');
 }finally{[a,b].forEach(cleanup);}
});
test('actual healthy sample wrapper and reviewed restore preserve audit, not fake observations',()=>{
 const f=shellFixture();try{
  const t=Date.now();const s=ledger(t);
  fs.writeFileSync(f.dir+'/probes/r329/tmall-daily-once.mjs',`import fs from 'node:fs';fs.mkdirSync('out',{recursive:true});fs.writeFileSync('out/tmall-receipt.json',JSON.stringify({schemaVersion:319,platform:'tmall',at:new Date().toISOString(),stopped:null,checked:[]}));`);
  fs.writeFileSync(f.dir+'/probes/r322/import-receipt.mjs',`import fs from 'node:fs';import {importReceipt} from './observation-ledger.mjs';const r=JSON.parse(fs.readFileSync('out/tmall-receipt.json'));fs.writeFileSync('out/ledger/state.json',JSON.stringify(importReceipt(null,r,{platform:'tmall',evidenceKind:'real'})));`);
  assert.equal(f.run('scripts/tmall-sample-once.sh').status,0);
  assert.equal(fs.existsSync(f.dir+'/out/ledger/recovery-block.json'),false);
  const actual=JSON.parse(fs.readFileSync(f.dir+'/out/ledger/state.json'));assert.equal(actual.evidenceKind,'real');assert.deepEqual(actual.observations,[]);
  const completed=Date.now();block(f.dir+'/out/ledger','REVIEW_REQUIRED','99');snapshot(f.dir+'/out/ledger',{runId:'100',runAttempt:1,now:completed});
  const a=approval(f.dir+'/out/ledger');a.approvedAt=iso(completed-1000);a.expiresAt=iso(completed+60000);
  const dest=f.dir+'/reviewed';const d=restore(f.dir+'/out/ledger',dest,run(),a,completed);assert.equal(d.skip,false);
  assert.deepEqual(JSON.parse(fs.readFileSync(dest+'/recovery-reviewed.json')),a);
  assert.equal(fs.existsSync(dest+'/recovery-block.json'),false);
 }finally{cleanup(f.dir);}
});
test('oversized/symlink restoration inputs stop without exposing their content',()=>{
 const dir=fixture(),out=fs.mkdtempSync(path.join(os.tmpdir(),'tmall-unsafe-'));try{
  fs.rmSync(dir+'/state.json');fs.writeFileSync(dir+'/external','SYNTHETIC_SECRET');fs.symlinkSync(dir+'/external',dir+'/state.json');
  assert.throws(()=>restore(dir,out,run(),null,now),/UNREADABLE_FILE/);
  fs.rmSync(dir+'/state.json');fs.writeFileSync(dir+'/state.json',Buffer.alloc(12*1024*1024+1));assert.throws(()=>restore(dir,out,run(),null,now),/UNREADABLE_FILE/);
 }finally{[dir,out].forEach(cleanup);}
});
test('actual shell rejects missing run history and corrupt provenance before download',()=>{
 for(const mode of ['empty','foreign']){
  const f=shellFixture();try{
   fs.writeFileSync(f.dir+'/bin/gh',`#!/bin/bash\nif [[ "$1 $2" == 'run list' ]]; then echo '${mode==='empty'?'[]':'[{"databaseId":100}]'}'; elif [[ "$1" == api ]]; then cat fixture/run.json; else touch DOWNLOADED; exit 1; fi\n`,{mode:0o755});
   write(f.dir+'/fixture/run.json',{...run(),head_repository:{full_name:'foreign/repo'}});
   const r=f.run('scripts/restore-tmall-ledger.sh');assert.notEqual(r.status,0);assert.equal(fs.existsSync(f.dir+'/DOWNLOADED'),false);
   assert.doesNotMatch(fs.readFileSync(f.dir+'/outputs','utf8'),/skip=false/);assert.equal(fs.existsSync(f.dir+'/out/ledger/recovery-block.json'),true);
  }finally{cleanup(f.dir);}
 }
});
