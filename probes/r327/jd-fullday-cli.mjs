// ONE authorized read-only pass. All diagnostics use bounded codes, never response bodies.
import {networkReader} from '../lib/tcl-jd-all.mjs';
import {withHistoryTransaction} from '../lib/history-files.mjs';
import {update,report,validateState} from './jd-fullday.mjs';
import {scanFullday} from './scan-fullday.mjs';
const arg=n=>{const i=process.argv.indexOf(n);return i>0?process.argv[i+1]:null;};
const previous=arg('--previous'),stateOutput=arg('--state-output'),summaryOutput=arg('--report-output');
if(!previous||!stateOutput||!summaryOutput){console.error('USAGE: explicit --previous FILE or --previous - is required');process.exit(2);}
try{
  const result=await withHistoryTransaction({previous:previous==='-'?null:previous,stateOutput,summaryOutput},async saved=>{
    validateState(saved);
    const scan=await scanFullday({reader:networkReader(process.env.TCL_OPS_BASE_URL)});
    const state=update(saved,scan.rows,scan.completedAt,{sourceStatus:scan.sourceStatus});
    const summary={generatedAt:scan.completedAt,attemptedAt:scan.attemptedAt,completedAt:scan.completedAt,
      lastSuccessfulSourceAt:state.lastSuccessfulSourceAt,sourceStatus:scan.sourceStatus,errors:scan.errors,
      window:state.window,warnings:scan.warnings,formalAttendanceReady:false,rows:report(state)};
    return {state,summary,scan};
  });
  const {scan,state,summary}=result;
  console.log('R327_JD_FULLDAY '+JSON.stringify({rooms:scan.rows.length,dailyOk:scan.rows.filter(r=>r.dailyOk).length,
    warnings:scan.warnings.length,sourceStatus:scan.sourceStatus,errors:scan.errors,
    attemptedAt:scan.attemptedAt,completedAt:scan.completedAt,lastSuccessfulSourceAt:state.lastSuccessfulSourceAt,
    days:Object.keys(state.days).length,withEstimate:summary.rows.filter(r=>r.ratePercent!==null).length,
    formalAttendanceReady:false}));
  if(scan.sourceStatus!=='OBSERVED')process.exitCode=2;
}catch{console.error('JD_FULLDAY_OPERATION_BLOCKED');process.exitCode=2;}
