// Restore policy for a bounded GitHub API result; no network or source access in this module.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {validateOperationalPrevious} from '../probes/r327/jd-fullday.mjs';
import {readHistoryJson,verifyHistoryPair} from '../probes/lib/history-files.mjs';
const REPO='lijianjun004-star/tcl-live-monitor';
const conclusions=new Set(['success','failure','cancelled','timed_out','action_required','neutral','skipped','stale','startup_failure']);
export function latestCompletedRun(document,{currentRunId=null}={}){
  if(!document||!Array.isArray(document.workflow_runs)||!Number.isSafeInteger(document.total_count)||document.total_count<0)throw Error('RUN_HISTORY_INVALID');
  const runs=document.workflow_runs.filter(r=>String(r?.id)!==String(currentRunId));
  if(!runs.length){if(document.total_count!==0)throw Error('RUN_HISTORY_INCOMPLETE');return null;}
  for(const r of runs){
    if(!Number.isSafeInteger(r?.id)||r.id<=0||r.status!=='completed'||r.head_branch!=='main'||
      !['schedule','workflow_dispatch'].includes(r.event)||r.path!=='.github/workflows/jd-fullday-rate.yml'||
      !Number.isSafeInteger(r.repository?.id)||r.repository.id!==r.head_repository?.id||r.repository.full_name!==REPO||r.head_repository?.full_name!==REPO||
      !Number.isSafeInteger(r.run_attempt)||r.run_attempt<1||!Number.isFinite(Date.parse(r.created_at))||!conclusions.has(r.conclusion))throw Error('RUN_PROVENANCE_INVALID');
  }
  return runs.sort((a,b)=>Date.parse(b.created_at)-Date.parse(a.created_at)||b.id-a.id)[0];
}
export function verifyRestored(directory){
  for(const file of ['.jd-history.lock','state.json.lock','recovery-block.json'])if(fs.existsSync(path.join(directory,file)))throw Error('RESTORE_REVIEW_REQUIRED');
  const state=readHistoryJson(path.join(directory,'state.json')),summary=readHistoryJson(path.join(directory,'report.json'));
  validateOperationalPrevious(state);verifyHistoryPair(state,summary);
  if(!state.lastRunAt||summary.generatedAt!==state.lastRunAt)throw Error('RESTORE_TIME_MISMATCH');
  return {state,summary,legacy:!state._historyCommit};
}
function main(){
  const [action,input,output]=process.argv.slice(2);
  try{
    if(action==='select'){
      const run=latestCompletedRun(readHistoryJson(input),{currentRunId:process.env.GITHUB_RUN_ID});
      console.log(run?String(run.id):'-');
    }else if(action==='verify'){
      const {state,legacy}=verifyRestored(input);
      fs.writeFileSync(output,JSON.stringify(state)+'\n',{flag:'wx',mode:0o600});
      console.log(JSON.stringify({restored:true,legacyUnverified:legacy,lastAttemptedAt:state.lastAttemptedAt??state.lastRunAt,sourceStatus:state.sourceStatus??'UNKNOWN'}));
    }else throw Error('INVALID_ACTION');
  }catch{console.error('JD_FULLDAY_RESTORE_BLOCKED');process.exitCode=1;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main();
