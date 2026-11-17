// Offline filesystem gate. No network, platform reader, secret or bypass switch.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {buildDailyBroadcast} from '../probes/r322/observation-ledger.mjs';
const REPO='lijianjun004-star/tcl-live-monitor', DAY=86400000;
const FILES=['state.json','cooldown.json','recovery-block.json','recovery-reviewed.json'];
const iso=x=>typeof x==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(x)&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString()===x;
const hash=b=>b===null?null:createHash('sha256').update(b).digest('hex');
const json=b=>b===null?null:JSON.parse(b.toString('utf8'));
function read(file) {
 try {const st=fs.lstatSync(file);if(!st.isFile()||st.size>12*1024*1024)throw Error('UNSAFE_FILE');return fs.readFileSync(file);}
 catch(e){if(e.code==='ENOENT')return null;throw Error('UNREADABLE_FILE');}
}
function write(file,value){
 fs.mkdirSync(path.dirname(file),{recursive:true});
 const tmp=file+'.tmp';
 try{fs.writeFileSync(tmp,JSON.stringify(value)+'\n',{mode:0o600});fs.renameSync(tmp,file);}
 finally{fs.rmSync(tmp,{force:true});}
}
export function block(dir,reason,originRunId=null){
 write(path.join(dir,'recovery-block.json'),{schemaVersion:1,reason,originRunId:/^\d+$/.test(String(originRunId))?String(originRunId):null});
}
function ledgerValid(s,now){
 if(!s||s.evidenceKind!=='real'||Object.keys(s).some(k=>!['schemaVersion','evidenceKind','latestAt','retentionTruncated','observations'].includes(k)))return false;
 try{buildDailyBroadcast(s);}catch{return false;}
 return Date.parse(s.latestAt)<=now&&now-Date.parse(s.latestAt)<=7*DAY&&s.observations.every(r=>r.platform==='tmall');
}
function cooldownValid(c,now){return c!==null&&Object.keys(c).length===1&&iso(c.stoppedAt)&&Date.parse(c.stoppedAt)<=now;}
export function runValid(r){return r&&Number.isSafeInteger(r.id)&&r.id>0&&Number.isSafeInteger(r.run_attempt)&&r.run_attempt>0&&r.status==='completed'&&['success','failure','cancelled','timed_out','action_required','neutral','skipped','stale','startup_failure'].includes(r.conclusion)&&r.head_branch==='main'&&['schedule','workflow_dispatch'].includes(r.event)&&r.path==='.github/workflows/tmall-daily-broadcast.yml'&&r.repository?.full_name===REPO&&r.head_repository?.full_name===REPO;}
function approvalValid(a,r,bytes,now){
 // Syntax/binding only. A separate owner-approved PR must establish actual human consent.
 if(!a||Object.keys(a).some(k=>!['schemaVersion','reason','runId','runAttempt','files','approvedBy','approvalUrl','approvedAt','expiresAt'].includes(k))||Object.keys(a.files||{}).length!==FILES.length+1||a.schemaVersion!==1||a.reason!=='RESTORE_CHAIN_REVIEWED'||a.runId!==String(r.id)||a.runAttempt!==r.run_attempt||
    !/^[A-Za-z0-9-]{1,39}$/.test(a.approvedBy||'')||
    !/^https:\/\/github\.com\/lijianjun004-star\/tcl-live-monitor\/(issues|pull)\/\d+#issuecomment-\d+$/.test(a.approvalUrl||'')||
    !iso(a.approvedAt)||!iso(a.expiresAt)||Date.parse(a.approvedAt)>now||Date.parse(a.expiresAt)<=now||
    Date.parse(a.expiresAt)-Date.parse(a.approvedAt)>DAY)return false;
 return [...FILES,'restore-manifest.json'].every(f=>Object.hasOwn(a.files||{},f)&&a.files[f]===hash(bytes[f]));
}
export function decideRestore({run,bytes,approval=null,now=Date.now()}){
 const deny=reason=>({skip:true,reason,reviewed:false});
 if(!Number.isFinite(now)||!runValid(run))return deny('RUN_PROVENANCE_UNVERIFIED');
 let state,cooldown,manifest;
 // Never launder lost/corrupt safety evidence through a successful skipped snapshot.
 if(bytes['recovery-block.json']!==null){
  let marker;try{marker=json(bytes['recovery-block.json']);}catch{return deny('BLOCK_MARKER_INVALID');}
  const reviewable=['REVIEW_REQUIRED','PERSISTENT_REVIEW_REQUIRED','FAILED_RUN_REVIEW_REQUIRED','MANIFEST_MISSING_REVIEW_REQUIRED','ACCESS_LIMIT_COOLDOWN','SOURCE_STOP_REVIEW_REQUIRED','SAMPLE_INCOMPLETE','SAMPLE_UNVERIFIED'];
  if(marker?.schemaVersion!==1||!reviewable.includes(marker.reason))return deny('PERSISTENT_SAFETY_UNVERIFIED');
 }
 try{state=json(bytes['state.json']);}catch{return deny('LEDGER_INVALID');}
 if(!ledgerValid(state,now))return deny('LEDGER_MISSING_INVALID_OR_STALE');
 try{cooldown=json(bytes['cooldown.json']);}catch{return deny('COOLDOWN_INVALID');}
 if(bytes['cooldown.json']!==null&&!cooldownValid(cooldown,now))return deny('COOLDOWN_INVALID');
 if(cooldown&&now-Date.parse(cooldown.stoppedAt)<DAY)return deny('ACCESS_LIMIT_COOLDOWN');
 const reviewed=approvalValid(approval,run,bytes,now);
 try{manifest=json(bytes['restore-manifest.json']);}catch{return deny('MANIFEST_INVALID');}
 if(manifest===null){if(!reviewed)return deny('MANIFEST_MISSING_REVIEW_REQUIRED');}
 else {
  if(manifest.schemaVersion!==1||manifest.platform!=='tmall'||manifest.runId!==String(run.id)||manifest.runAttempt!==run.run_attempt||
     !iso(manifest.savedAt)||Date.parse(manifest.savedAt)>now||now-Date.parse(manifest.savedAt)>7*DAY||
     !FILES.every(f=>Object.hasOwn(manifest.files||{},f)&&manifest.files[f]===hash(bytes[f])))return deny('MANIFEST_INTEGRITY_INVALID');
 }
 if(bytes['recovery-block.json']!==null&&!reviewed)return deny('PERSISTENT_REVIEW_REQUIRED');
 if(run.conclusion!=='success'&&!reviewed)return deny('FAILED_RUN_REVIEW_REQUIRED');
 return {skip:false,reason:reviewed?'EXACT_RECOVERY_REVIEWED':'VERIFIED_RESTORE',reviewed};
}
export function restore(previous,output,run,approval=null,now=Date.now()){
 fs.mkdirSync(output,{recursive:true});
 const bytes=Object.fromEntries([...FILES,'restore-manifest.json'].map(f=>[f,read(path.join(previous,f))]));
 // Preserve independently valid stop data even when the ledger is bad. Never replay raw invalid bytes.
 try{const c=json(bytes['cooldown.json']);if(cooldownValid(c,now))write(path.join(output,'cooldown.json'),c);}catch{}
 try{const s=json(bytes['state.json']);if(ledgerValid(s,now))write(path.join(output,'state.json'),s);}catch{}
 const decision=decideRestore({run,bytes,approval,now});
 if(decision.skip)block(output,decision.reason,run?.id);
 else {
  fs.rmSync(path.join(output,'recovery-block.json'),{force:true});
  if(decision.reviewed)write(path.join(output,'recovery-reviewed.json'),approval);
  else if(bytes['recovery-reviewed.json']!==null){
   // Carry only well-formed historical audit metadata, never native error text.
   const audit=json(bytes['recovery-reviewed.json']);
   if(audit?.schemaVersion===1&&audit.reason==='RESTORE_CHAIN_REVIEWED')write(path.join(output,'recovery-reviewed.json'),audit);
  }
 }
 return decision;
}
export function snapshot(dir,{runId,runAttempt,now=Date.now()}){
 if(!/^\d+$/.test(runId)||!Number.isSafeInteger(runAttempt)||runAttempt<1||!Number.isFinite(now))throw Error('SNAPSHOT_PROVENANCE_INVALID');
 // Fail closed rather than publish an apparently healthy manifest around invalid output.
 for(const [file,valid] of [['state.json',ledgerValid],['cooldown.json',cooldownValid]]){
  const filePath=path.join(dir,file),raw=read(filePath);
  let ok=raw===null;try{if(raw!==null)ok=valid(json(raw),now);}catch{ok=false;}
  if(!ok){fs.rmSync(filePath,{force:true});block(dir,'OUTPUT_UNVERIFIED',runId);}
 }
 if(!fs.existsSync(path.join(dir,'state.json'))&&!fs.existsSync(path.join(dir,'recovery-block.json')))block(dir,'LEDGER_MISSING',runId);
 const files=Object.fromEntries(FILES.map(f=>[f,hash(read(path.join(dir,f)))]));
 write(path.join(dir,'restore-manifest.json'),{schemaVersion:1,platform:'tmall',runId,runAttempt,savedAt:new Date(now).toISOString(),files});
}
function receipt(file){
 const r=json(read(file));
 if(!r||r.schemaVersion!==319||r.platform!=='tmall'||!iso(r.at)||!Array.isArray(r.checked)||!Object.hasOwn(r,'stopped')||(r.stopped!==null&&typeof r.stopped!=='string'))throw Error('RECEIPT_INVALID');
 return r;
}
export function recordStop(dir,file,code,now=Date.now()){
 let r;try{r=receipt(file);}catch{}
 if(!Number.isInteger(code)||code!==0||!r||r.stopped!==null){
  // Durable stop BEFORE ledger import; an importer failure must not lose it.
  write(path.join(dir,'cooldown.json'),{stoppedAt:new Date(now).toISOString()});
  block(dir,r?'SOURCE_STOP_REVIEW_REQUIRED':'SAMPLE_UNVERIFIED',process.env.GITHUB_RUN_ID);
  return true;
 }
 return false;
}
export function finishSample(dir,file,code){
 const r=receipt(file);
 if(code!==0||r.stopped!==null)throw Error('SAMPLE_STOPPED');
 const prior=json(read(path.join(dir,'recovery-block.json')));
 if(prior?.reason!=='SAMPLE_INCOMPLETE')throw Error('BLOCK_NOT_OWNED_BY_SAMPLE');
 // Validate before removing the in-progress sentinel.
 if(!ledgerValid(json(read(path.join(dir,'state.json'))),Date.now()))throw Error('LEDGER_INVALID');
 fs.rmSync(path.join(dir,'recovery-block.json'));
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1])){
 const [mode,arg]=process.argv.slice(2),out='out/ledger';
 try{
  if(mode==='block')block(out,'RESTORE_UNVERIFIED',process.env.GITHUB_RUN_ID);
  else if(mode==='restore'){
   const run=json(read('prev/run.json')),approval=json(read('config/tmall-recovery-approval.json'));
   const result=restore('prev',out,run,approval);
   fs.appendFileSync(process.env.GITHUB_OUTPUT,`skip=${result.skip}\nreason=${result.reason}\n`);
   console.log(JSON.stringify(result));
  }else if(mode==='begin')block(out,'SAMPLE_INCOMPLETE',process.env.GITHUB_RUN_ID);
  else if(mode==='record-stop')recordStop(out,'out/tmall-receipt.json',Number(arg));
  else if(mode==='finish')finishSample(out,'out/tmall-receipt.json',Number(arg));
  else if(mode==='snapshot')snapshot(out,{runId:process.env.GITHUB_RUN_ID,runAttempt:Number(process.env.GITHUB_RUN_ATTEMPT)});
  else throw Error('MODE_INVALID');
 }catch{console.error('TMALL_RECOVERY_OPERATION_BLOCKED');process.exitCode=1;}
}
