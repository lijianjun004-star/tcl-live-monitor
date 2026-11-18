// Local recovery only. No platform requests, credentials or recovery-approval creation.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {buildDailyBroadcast} from '../probes/r322/observation-ledger.mjs';
import {restorePolicy,reviewedRecovery} from './douyin-restore-policy.mjs';
import {readRecoveryFile as read,writeRecoveryFile as write,removeRecoveryFile as remove,withRecoveryLock} from './recovery-file-store.mjs';
const REPO='lijianjun004-star/tcl-live-monitor',DAY=86400000;
const FILES=['state.json','cooldown.json','recovery-block.json','recovery-reviewed.json'];
const json=b=>b===null?null:JSON.parse(b.toString('utf8'));
const iso=x=>typeof x==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(x)&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString()===x;
const hash=b=>b===null?null:createHash('sha256').update(b).digest('hex');
const marker=(dir,reason,extra={})=>write(path.join(dir,'recovery-block.json'),{schemaVersion:1,reason,...extra});
function ledgerValid(s,now){
 if(!s||s.evidenceKind!=='real')return false;
 try{buildDailyBroadcast(s);}catch{return false;}
 return Date.parse(s.latestAt)<=now&&now-Date.parse(s.latestAt)<=7*DAY&&s.observations.every(r=>r.platform==='douyin');
}
export function runValid(r){return r&&Number.isSafeInteger(r.id)&&r.id>0&&Number.isSafeInteger(r.run_attempt)&&r.run_attempt>0&&r.status==='completed'&&['success','failure','cancelled','timed_out','action_required','neutral','skipped','stale','startup_failure'].includes(r.conclusion)&&r.head_branch==='main'&&['schedule','workflow_dispatch'].includes(r.event)&&r.path==='.github/workflows/douyin-daily-broadcast.yml'&&r.repository?.full_name===REPO&&r.head_repository?.full_name===REPO;}
export function prepareRestore(dir){
 return withRecoveryLock(dir,()=>{
  if(FILES.some(f=>read(path.join(dir,f))!==null))throw Error('LOCAL_STATE_REQUIRES_REVIEW');
  marker(dir,'RESTORE_UNVERIFIED');
 });
}
export function restore(previous,output,run,approval=null,now=Date.now()){
 return withRecoveryLock(output,()=>{
  for(const name of FILES){
   const raw=read(path.join(output,name));if(raw===null)continue;
   let initial=false;try{const m=json(raw);initial=name==='recovery-block.json'&&m.schemaVersion===1&&m.reason==='RESTORE_UNVERIFIED';}catch{}
   if(!initial){marker(output,'LOCAL_STATE_REQUIRES_REVIEW');return {skip:true,reason:'LOCAL_STATE_REQUIRES_REVIEW'};}
  }
  marker(output,'RESTORE_UNVERIFIED');
  const bytes=Object.fromEntries(FILES.map(f=>[f,read(path.join(previous,f))]));
  const deny=reason=>{marker(output,reason);return {skip:true,reason};};
  if(!Number.isFinite(now)||!runValid(run))return deny('RUN_PROVENANCE_UNVERIFIED');
  let state,cooldown,prior;
  try{state=json(bytes['state.json']);}catch{return deny('LEDGER_INVALID');}
  if(!ledgerValid(state,now))return deny('LEDGER_MISSING_INVALID_OR_STALE');
  try{cooldown=json(bytes['cooldown.json']);}catch{return deny('COOLDOWN_INVALID');}
  // Preserve valid state before deciding whether access can resume. Write failures propagate.
  write(path.join(output,'state.json'),state);
  if(cooldown!==null){
   if(Object.keys(cooldown).length!==1||!iso(cooldown.stoppedAt)||Date.parse(cooldown.stoppedAt)>now)return deny('COOLDOWN_INVALID');
   write(path.join(output,'cooldown.json'),cooldown);
  }
  try{prior=json(bytes['recovery-block.json']);}catch{return deny('PERSISTENT_SAFETY_UNVERIFIED');}
  const reviewable=['REVIEW_REQUIRED','PERSISTENT_RECOVERY_REVIEW_REQUIRED','LATEST_RUN_FAILED_REVIEW_REQUIRED','COOLDOWN_ABSENCE_REVIEW_REQUIRED','ACCESS_LIMIT_COOLDOWN','SAMPLE_INCOMPLETE','SOURCE_STOP_REVIEW_REQUIRED','SAMPLE_UNVERIFIED'];
  if(bytes['recovery-block.json']!==null&&(!prior||!reviewable.includes(prior.reason)))return deny('PERSISTENT_SAFETY_UNVERIFIED');
  const policyRun={...run,databaseId:run.id};
  const reviewed=reviewedRecovery(approval,{run:policyRun,stateSha256:hash(bytes['state.json']),cooldownSha256:hash(bytes['cooldown.json']),blockSha256:hash(bytes['recovery-block.json']),now});
  const decision=restorePolicy({run:reviewed?{...policyRun,conclusion:'success'}:policyRun,downloaded:true,ledgerValid:true,cooldown,cooldownAbsenceReviewed:reviewed&&cooldown===null,recoveryBlocked:prior!==null&&!reviewed,now});
  if(decision.skip)return deny(decision.reason);
  if(reviewed)write(path.join(output,'recovery-reviewed.json'),approval);
  else if(bytes['recovery-reviewed.json']!==null){
   const audit=json(bytes['recovery-reviewed.json']);
   if(audit?.schemaVersion===1&&audit.reason==='ENCRYPTION_FAILURE_ONLY')write(path.join(output,'recovery-reviewed.json'),audit);
  }
  remove(path.join(output,'recovery-block.json'));
  return decision;
 });
}
export function beginSample(dir,{runId=process.env.GITHUB_RUN_ID,runAttempt=Number(process.env.GITHUB_RUN_ATTEMPT),now=Date.now()}={}){
 return withRecoveryLock(dir,()=>{
  if(!/^[1-9]\d*$/.test(runId)||!Number.isSafeInteger(runAttempt)||runAttempt<1||!Number.isFinite(now))throw Error('SAMPLE_PROVENANCE_INVALID');
  if(read(path.join(dir,'recovery-block.json'))!==null)throw Error('EXISTING_SAFETY_BLOCK');
  const c=json(read(path.join(dir,'cooldown.json')));
  if(c!==null&&(!iso(c.stoppedAt)||Object.keys(c).length!==1||now-Date.parse(c.stoppedAt)<DAY))throw Error('COOLDOWN_BLOCKED');
  write(path.join(dir,'recovery-block.json'),{schemaVersion:1,reason:'SAMPLE_INCOMPLETE',originRunId:runId,runAttempt,startedAt:new Date(now).toISOString()},{exclusive:true});
 });
}
function readReceipt(file){
 const r=json(read(file));
 if(!r||r.schemaVersion!==319||!iso(r.at)||!Array.isArray(r.checked)||!Object.hasOwn(r,'stopped')||(r.stopped!==null&&typeof r.stopped!=='object'))throw Error('RECEIPT_INVALID');
 return r;
}
export function recordStop(dir,file,code,now=Date.now()){
 return withRecoveryLock(dir,()=>{
  let r;try{r=readReceipt(file);}catch{}
  if(code!==0||!r||r.stopped!==null){
   write(path.join(dir,'cooldown.json'),{stoppedAt:new Date(now).toISOString()});
   marker(dir,r?'SOURCE_STOP_REVIEW_REQUIRED':'SAMPLE_UNVERIFIED');return true;
  }
  return false;
 });
}
export function finishSample(dir,{runId=process.env.GITHUB_RUN_ID,runAttempt=Number(process.env.GITHUB_RUN_ATTEMPT),now=Date.now()}={}){
 return withRecoveryLock(dir,()=>{
  const prior=json(read(path.join(dir,'recovery-block.json')));
  if(prior?.reason!=='SAMPLE_INCOMPLETE'||prior.originRunId!==runId||prior.runAttempt!==runAttempt||!iso(prior.startedAt))throw Error('BLOCK_NOT_OWNED_BY_SAMPLE');
  const state=json(read(path.join(dir,'state.json')));
  if(!ledgerValid(state,now)||Date.parse(state.latestAt)<Date.parse(prior.startedAt))throw Error('LEDGER_INVALID');
  remove(path.join(dir,'recovery-block.json'));
 });
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1])){
 const [mode,arg]=process.argv.slice(2),out='out/ledger';
 try{
  if(mode==='prepare')prepareRestore(out);
  else if(mode==='restore'){
   const decision=restore('prev',out,json(read('prev/run.json')),json(read('config/douyin-recovery-approval.json')));
   fs.appendFileSync(process.env.GITHUB_OUTPUT,`skip=${decision.skip}\nreason=${decision.reason}\n`);console.log(JSON.stringify(decision));
  }else if(mode==='begin')beginSample(out);
  else if(mode==='record-stop')recordStop(out,'out/r316-rpa-public.json',Number(arg));
  else if(mode==='finish')finishSample(out);
  else throw Error('MODE_INVALID');
 }catch{console.error('DOUYIN_RECOVERY_OPERATION_BLOCKED');process.exitCode=1;}
}
