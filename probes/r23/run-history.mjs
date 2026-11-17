#!/usr/bin/env node
/** R2.3: safe file-to-file state carry-forward; NEVER polls platform itself. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {updateJdHistory,latestPublicSummary} from './jd-history.mjs';

function option(name){const i=process.argv.indexOf(name);return i<0?null:process.argv[i+1];}
const source=option('--report'),previous=option('--previous'),
 stateOutput=option('--state-output'),summaryOutput=option('--summary-output'),runId=option('--run-id');
if(!stateOutput||!summaryOutput||!runId)throw Error('Required: --report FILE --previous FILE --state-output FILE --summary-output FILE --run-id ID');
const now=new Date().toISOString();
async function safeRead(file){
 if(!file)return null;
 try{
  const info=await fs.stat(file);
  if(!info.isFile()||info.size>12*1024*1024)throw Error('UNSAFE_INPUT_SIZE');
  return JSON.parse(await fs.readFile(file,'utf8'));
 }catch(e){if(e.code==='ENOENT')return null;throw e;}
}
const saved=await safeRead(previous);
const report=await safeRead(source);
const {state,delta,duplicate,source_accepted,counts,warning}=updateJdHistory(saved,report,{now,run_id:runId});
const summary=latestPublicSummary(state,now);
summary.source_evidence_accepted=source_accepted;
summary.new_state_changes=delta;
summary.duplicate_run=duplicate;
summary.collection_warning=warning||null;
async function atomic(file,data){
 await fs.mkdir(path.dirname(file),{recursive:true});
 const tmp=file+'.'+randomUUID()+'.tmp';
 try{
  await fs.writeFile(tmp,JSON.stringify(data,null,2)+'\n',{flag:'wx',mode:0o600});
  await fs.rename(tmp,file);
 }finally{await fs.rm(tmp,{force:true}).catch(()=>{});}
}
await atomic(stateOutput,state);
await atomic(summaryOutput,summary);
console.log(JSON.stringify({run_id:runId,source_accepted,warning,
  rooms:summary.room_count,observed_live:summary.observed_live,
  unknown:summary.current_unknown,delta_count:delta.length,
  formal_opening_rate_percent:null,stored_check_count:state.checks.length,
  stored_transition_count:state.events.length}));
