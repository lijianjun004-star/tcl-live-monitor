import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {block,finishSample,restore,snapshot} from '../scripts/tmall-ledger-recovery.mjs';
import {importReceipt} from '../probes/r322/observation-ledger.mjs';
import * as dy from '../scripts/douyin-ledger-recovery.mjs';
import {withRecoveryLock,readRecoveryFile,writeRecoveryFile} from '../scripts/recovery-file-store.mjs';

const temp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'recovery-race-'));
const cleanup=dir=>fs.rmSync(dir,{recursive:true,force:true});
const json=file=>JSON.parse(fs.readFileSync(file));
const receipt=at=>({schemaVersion:319,platform:'tmall',at,stopped:null,checked:[{key:'synthetic',at,state:'UNKNOWN',reason:'SYNTHETIC_ONLY'}]});

test('sample begin never overwrites an existing safety block',()=>{
 const dir=temp(),out=path.join(dir,'out/ledger');
 try{
  block(out,'SOURCE_STOP_REVIEW_REQUIRED','99');
  const prior=fs.readFileSync(path.join(out,'recovery-block.json'));
  const r=spawnSync(process.execPath,[path.resolve('scripts/tmall-ledger-recovery.mjs'),'begin'],{cwd:dir,encoding:'utf8',env:{...process.env,GITHUB_RUN_ID:'200',GITHUB_RUN_ATTEMPT:'1'}});
  assert.equal(r.status,1);assert.deepEqual(fs.readFileSync(path.join(out,'recovery-block.json')),prior);
 }finally{cleanup(dir);}
});

test('two independent sample starters admit exactly one owner',async()=>{
 const dir=temp();try{
  const moduleUrl=pathToFileURL(path.resolve('scripts/tmall-ledger-recovery.mjs')).href;
  const launch=id=>new Promise((resolve,reject)=>{
   const code=`import {beginSample} from ${JSON.stringify(moduleUrl)};try{beginSample(process.argv[1],{runId:process.argv[2],runAttempt:1});}catch{process.exitCode=1;}`;
   const child=spawn(process.execPath,['--input-type=module','-e',code,dir,id],{stdio:'pipe'});child.on('error',reject);child.on('exit',resolve);
  });
  assert.deepEqual((await Promise.all([launch('100'),launch('200')])).sort(),[0,1]);
  const m=json(path.join(dir,'recovery-block.json'));assert.equal(m.reason,'SAMPLE_INCOMPLETE');assert.ok(['100','200'].includes(m.originRunId));
 }finally{cleanup(dir);}
});

test('killed writer leaves a lock and blocker; no expiry steals its state',()=>{
 const dir=temp();try{
  const helper=pathToFileURL(path.resolve('scripts/recovery-file-store.mjs')).href;
  const code=`import path from 'node:path';import {withRecoveryLock,writeRecoveryFile} from ${JSON.stringify(helper)};withRecoveryLock(process.argv[1],()=>{writeRecoveryFile(path.join(process.argv[1],'recovery-block.json'),{schemaVersion:1,reason:'SAMPLE_INCOMPLETE'});process.kill(process.pid,'SIGKILL');});`;
  const result=spawnSync(process.execPath,['--input-type=module','-e',code,dir]);assert.notEqual(result.status,0);
  assert.ok(fs.existsSync(path.join(dir,'.recovery-lock')));
  assert.throws(()=>withRecoveryLock(dir,()=>{}),/RECOVERY_LOCKED_REVIEW_REQUIRED/);
  assert.equal(json(path.join(dir,'recovery-block.json')).reason,'SAMPLE_INCOMPLETE');
 }finally{cleanup(dir);}
});

test('Douyin foreign run and stale/wrong-platform/synthetic ledger never authorize restore',()=>{
 const dir=temp();try{
  const now=Date.now(),at=new Date(now).toISOString(),previous=path.join(dir,'previous');fs.mkdirSync(previous);
  const valid={id:100,run_attempt:1,status:'completed',conclusion:'success',head_branch:'main',event:'schedule',path:'.github/workflows/douyin-daily-broadcast.yml',repository:{full_name:'lijianjun004-star/tcl-live-monitor'},head_repository:{full_name:'lijianjun004-star/tcl-live-monitor'}};
  const state=importReceipt(null,{schemaVersion:319,at,checked:[{key:'synthetic',at,state:'UNKNOWN',reason:'SYNTHETIC_ONLY'}]},{evidenceKind:'real',platform:'douyin'});
  for(const mode of ['foreign','stale','platform','synthetic']){
   const s=structuredClone(state),run=structuredClone(valid);
   if(mode==='foreign')run.head_repository.full_name='other/repo';
   if(mode==='stale')s.latestAt=new Date(now-8*86400000).toISOString();
   if(mode==='platform')s.observations[0].platform='tmall';
   if(mode==='synthetic')s.evidenceKind='synthetic';
   fs.writeFileSync(path.join(previous,'state.json'),JSON.stringify(s));
   fs.writeFileSync(path.join(previous,'cooldown.json'),JSON.stringify({stoppedAt:new Date(now-2*86400000).toISOString()}));
   const out=path.join(dir,mode);assert.equal(dy.restore(previous,out,run,null,now).skip,true);
   assert.ok(fs.existsSync(path.join(out,'recovery-block.json')));
  }
 }finally{cleanup(dir);}
});

test('Douyin newer local stop and corrupt safety lineage remain blocked',()=>{
 const dir=temp();try{
  fs.writeFileSync(path.join(dir,'cooldown.json'),'NEWER_LOCAL_BYTES');
  assert.equal(dy.restore(path.join(dir,'missing'),dir,{id:100}).reason,'LOCAL_STATE_REQUIRES_REVIEW');
  assert.equal(fs.readFileSync(path.join(dir,'cooldown.json'),'utf8'),'NEWER_LOCAL_BYTES');
  assert.throws(()=>dy.prepareRestore(dir),/LOCAL_STATE_REQUIRES_REVIEW/);
 }finally{cleanup(dir);}
});

test('a corrupt Douyin cooldown remains nonreviewable after a later successful skipped run',()=>{
 const dir=temp();try{
  const now=Date.now(),at=new Date(now).toISOString(),prev=path.join(dir,'prev');fs.mkdirSync(prev);
  const r={id:100,run_attempt:1,status:'completed',conclusion:'success',head_branch:'main',event:'schedule',path:'.github/workflows/douyin-daily-broadcast.yml',repository:{full_name:'lijianjun004-star/tcl-live-monitor'},head_repository:{full_name:'lijianjun004-star/tcl-live-monitor'}};
  fs.writeFileSync(path.join(prev,'state.json'),JSON.stringify(importReceipt(null,{schemaVersion:319,at,checked:[]},{platform:'douyin',evidenceKind:'real'})));
  fs.writeFileSync(path.join(prev,'cooldown.json'),'INVALID_SYNTHETIC');
  const a=path.join(dir,'a'),b=path.join(dir,'b');assert.equal(dy.restore(prev,a,r,null,now).reason,'COOLDOWN_INVALID');
  // A malformed cooldown need not be replayed, but its blocker must survive unchanged in meaning.
  fs.copyFileSync(path.join(prev,'state.json'),path.join(a,'state.json'));
  assert.equal(dy.restore(a,b,{...r,id:200},null,now).reason,'PERSISTENT_SAFETY_UNVERIFIED');
 }finally{cleanup(dir);}
});

test('recovery refuses symlink parent directories instead of writing through an alias',()=>{
 const dir=temp();try{
  const actual=path.join(dir,'actual'),alias=path.join(dir,'alias');fs.mkdirSync(actual);fs.symlinkSync(actual,alias,process.platform==='win32'?'junction':'dir');
  assert.throws(()=>withRecoveryLock(alias,()=>{}),/RECOVERY_DIRECTORY_UNSAFE/);
  assert.deepEqual(fs.readdirSync(actual),[]);
 }finally{cleanup(dir);}
});

test('a growing recovery file never causes more than MAX+1 bytes to be read',()=>{
 const dir=temp(),file=path.join(dir,'growing.json'),nativeRead=fs.readSync;
 let totalRead=0,grown=false;
 try{
  fs.writeFileSync(file,'{}');
  fs.readSync=(fd,...args)=>{
   if(!grown){grown=true;fs.appendFileSync(file,Buffer.alloc(13*1024*1024));}
   const count=nativeRead(fd,...args);totalRead+=count;return count;
  };
  assert.throws(()=>readRecoveryFile(file),/UNREADABLE_FILE/);
  assert.equal(totalRead,12*1024*1024+1);
 }finally{fs.readSync=nativeRead;cleanup(dir);}
});

test('replaced recovery lock prevents publication and is never removed on release',()=>{
 for(const replacement of ['directory','owner']){
  const dir=temp();try{
   const file=path.join(dir,'state.json');fs.writeFileSync(file,'PREVIOUS_SYNTHETIC');
   assert.throws(()=>withRecoveryLock(dir,()=>{
    const lock=path.join(dir,'.recovery-lock');
    if(replacement==='directory'){fs.renameSync(lock,path.join(dir,'previous-lock'));fs.mkdirSync(lock);}
    fs.writeFileSync(path.join(lock,'owner.json'),'FOREIGN_OWNER');
    writeRecoveryFile(file,{updated:true});
   }),/RECOVERY_LOCK_CHANGED/);
   assert.equal(fs.readFileSync(file,'utf8'),'PREVIOUS_SYNTHETIC');
   assert.equal(fs.readFileSync(path.join(dir,'.recovery-lock/owner.json'),'utf8'),'FOREIGN_OWNER');
  }finally{cleanup(dir);}
 }
});

test('sample finish cannot erase a different run or attempt sentinel',()=>{
 const dir=temp();try{
  const at=new Date().toISOString(),r=receipt(at);
  fs.writeFileSync(path.join(dir,'receipt.json'),JSON.stringify(r));
  fs.writeFileSync(path.join(dir,'state.json'),JSON.stringify(importReceipt(null,r,{platform:'tmall',evidenceKind:'real'})));
  block(dir,'SAMPLE_INCOMPLETE','99');
  const prior=fs.readFileSync(path.join(dir,'recovery-block.json'));
  assert.throws(()=>finishSample(dir,path.join(dir,'receipt.json'),0,{runId:'200',runAttempt:1}),/BLOCK_NOT_OWNED/);
  assert.deepEqual(fs.readFileSync(path.join(dir,'recovery-block.json')),prior);
 }finally{cleanup(dir);}
});

test('interrupted direct restore persists a blocker before writing any state',()=>{
 const dir=temp(),prev=path.join(dir,'previous'),out=path.join(dir,'output');
 const rename=fs.renameSync;
 try{
  fs.mkdirSync(prev);const now=Date.now(),r=receipt(new Date(now).toISOString());
  fs.writeFileSync(path.join(prev,'state.json'),JSON.stringify(importReceipt(null,r,{platform:'tmall',evidenceKind:'real'})));
  snapshot(prev,{runId:'100',runAttempt:1,now});
  const run={id:100,run_attempt:1,status:'completed',conclusion:'success',head_branch:'main',event:'schedule',path:'.github/workflows/tmall-daily-broadcast.yml',repository:{full_name:'lijianjun004-star/tcl-live-monitor'},head_repository:{full_name:'lijianjun004-star/tcl-live-monitor'}};
  fs.renameSync=(from,to)=>{if(to===path.join(out,'state.json'))throw Error('SYNTHETIC_INTERRUPTED_WRITE');return rename(from,to);};
  assert.throws(()=>restore(prev,out,run,null,now),/SYNTHETIC_INTERRUPTED_WRITE/);
  assert.equal(json(path.join(out,'recovery-block.json')).reason,'RESTORE_UNVERIFIED');
 }finally{fs.renameSync=rename;cleanup(dir);}
});
