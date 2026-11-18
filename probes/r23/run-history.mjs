#!/usr/bin/env node
/** R2.3: safe file-to-file state carry-forward; NEVER polls platform itself. */
import {readHistoryJson,withHistoryTransaction} from '../lib/history-files.mjs';
import {updateJdHistory,latestPublicSummary} from './jd-history.mjs';

function option(name){const i=process.argv.indexOf(name);return i<0?null:process.argv[i+1];}
const source=option('--report'),previous=option('--previous'),
 stateOutput=option('--state-output'),summaryOutput=option('--summary-output'),runId=option('--run-id');
if(!stateOutput||!summaryOutput||!runId)throw Error('Required: --report FILE --previous FILE --state-output FILE --summary-output FILE --run-id ID');
const now=new Date().toISOString();
try {
const result=await withHistoryTransaction({stateOutput,summaryOutput,previous},async saved=>{
const report=readHistoryJson(source,{required:false});
const {state,delta,duplicate,source_accepted,counts,warning}=updateJdHistory(saved,report,{now,run_id:runId});
const summary=latestPublicSummary(state,now);
summary.source_evidence_accepted=source_accepted;
summary.new_state_changes=delta;
summary.duplicate_run=duplicate;
summary.collection_warning=warning||null;
return {state,summary,delta,source_accepted,warning};
});
const {state,summary,delta,source_accepted,warning}=result;
console.log(JSON.stringify({run_id:runId,source_accepted,warning,
  rooms:summary.room_count,observed_live:summary.observed_live,
  unknown:summary.current_unknown,delta_count:delta.length,
  formal_opening_rate_percent:null,stored_check_count:state.checks.length,
  stored_transition_count:state.events.length}));

} catch {console.error('JD_HISTORY_OPERATION_BLOCKED');process.exitCode=1;}
