// CLI: run only in authorized isolated test environments. Safe output: IDs, states, minute_count delta.
import {sourceError} from './lib/source-error.mjs';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { networkReader, scanJdSource, beijingDate, mergePreviousSnapshot } from './lib/tcl-jd-all.mjs';
const usage = 'Usage: TCL_OPS_BASE_URL=<authorized-origin> node probes/tcl-jd-all.mjs [--date YYYY-MM-DD] [--previous FILE] [--output FILE] [--shard-index N --shard-total N]';
const args=process.argv.slice(2);
function option(name){const i=args.indexOf(name);return i>=0?args[i+1]:null;}
if (args.includes('--help')) {console.log(usage);process.exit(0);}
const shardIndex=option('--shard-index')===null?0:Number(option('--shard-index'));
const shardTotal=option('--shard-total')===null?1:Number(option('--shard-total'));
if (option('--previous') && option('--previous')===option('--output')) {
  console.error('State file and public report must be different files.');process.exit(2);
}
let previous=null;
if(option('--previous')) {
  try{previous=JSON.parse(await fs.readFile(option('--previous'),'utf8'));if(!previous||!/^\d{4}-\d{2}-\d{2}$/.test(previous.date)||!Number.isSafeInteger(previous.at)||!Array.isArray(previous.rooms))throw Error('BAD_PREVIOUS');}
  catch(e){if(e.code!=='ENOENT'){console.error('PRIOR_STATE_INVALID');process.exit(2);}}
}
try {
  const at=Date.now();
  const date=option('--date')??beijingDate(new Date(at));
  const report=await scanJdSource({reader:networkReader(process.env.TCL_OPS_BASE_URL),at,date,previous,shardIndex,shardTotal,clock:Date.now});
  const publicReport={...report,rooms:report.rooms.map(({minuteCount,...room})=>room)};
  const json=JSON.stringify(publicReport,null,2)+'\n';
  if(option('--output')) await fs.writeFile(option('--output'),json);
  console.log(`catalog=${report.catalogStatus} scope=${report.roomListScope} shard=${shardIndex}/${shardTotal} observedJdRooms=${report.rooms.length} discoveredJdRooms=${report.discoveredRoomCount??'UNKNOWN'} shops=${report.shopCount??'UNKNOWN'} LIVE=${report.summary?.LIVE??'UNKNOWN'} OFFLINE=${report.summary?.OFFLINE??'UNKNOWN'} UNKNOWN=${report.summary?.UNKNOWN??'UNKNOWN'}`);
  console.log('JD_SOURCE_STATUS '+JSON.stringify({attemptedAt:report.attemptedAt,completedAt:report.completedAt,samplingStatus:report.samplingStatus,errors:report.errors}));
  for(const r of publicReport.rooms) console.log(`jd-${r.roomId} shop=${r.shopId??'?'} ${r.category||'?'} ${r.status} reason=${r.reason}${r.minutesDelta!==undefined && r.minutesDelta!==null?' minuteCountDelta='+r.minutesDelta:''}`);
  // Only current-day valid observations can update the persistent comparison state.
  // Store via a temp file + atomic rename so a crash cannot truncate evidence.
  if(option('--previous') && date===beijingDate(new Date(at))) {
    const safeNext=mergePreviousSnapshot(previous,report,at);
    if(safeNext) {
      const temp=`${option('--previous')}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temp,JSON.stringify(safeNext,null,2)+'\n',{flag:'wx',mode:0o600});
        await fs.rename(temp,option('--previous'));
      } finally { await fs.rm(temp,{force:true}).catch(()=>{}); }
    }
  }
  if(report.catalogStatus==='UNAVAILABLE'||report.errors.length>0||report.samplingStatus==='FAILED') process.exitCode=2;
} catch(e) {console.error('Scan stopped safely:', sourceError(e));process.exitCode=2;}
