/** R1.5 single-store evidence diary. This does not acquire live data or infer exact stream times. */
import {FIRST_TARGET,classifyObservation} from './r12-tmall-first.mjs';
import {reduceTmallSingleStore} from './r13-tmall-interval-monitor.mjs';
import {parseLedger} from './r14-tmall-durable.mjs';

const ms=60000;
const time=s=>Date.parse(s);
const iso=s=>new Date(s).toISOString();
const validDate=s=>typeof s==='string'&&s.trim()!==''&&Number.isFinite(time(s));
const dateBJ=s=>new Date(s).toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'});
const bjTime=s=>s?new Date(s).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'';
const sortedByTime=(a,b)=>time(a.at)-time(b.at);

function collectSource(source){
  if(Array.isArray(source))return {samples:source,kind:'INPUT_OBSERVATIONS'};
  if(!source||typeof source!=='object')throw Error('INVALID_OBSERVATION_INPUT');
  if(source.schemaVersion===14){
    const ledger=parseLedger(source);
    return {samples:ledger.observations,kind:'R14_RECOVERABLE_LEDGER',
      attempts:ledger.attempts};
  }
  if(Array.isArray(source.observations))return {samples:source.observations,kind:'INPUT_OBSERVATIONS'};
  if(Array.isArray(source.runs)){
    const samples=source.runs.flatMap(r=>(r.samples||[]).filter(s=>s.kind!=='summary-only'));
    return {samples,kind:'ARCHIVED_GITHUB_ACTIONS_NOT_REALTIME'};
  }
  throw Error('UNSUPPORTED_OBSERVATION_INPUT');
}
function rowOf(s){
  const x=classifyObservation(s,FIRST_TARGET);
  const observedState=x.state==='LIVE'||x.state==='OFFLINE'?x.state:'UNKNOWN';
  return {at:iso(s.at),day:dateBJ(s.at),state:observedState,
    reason:x.reason,
    accountMatch:x.accountMatches===true,
    roomMatch:x.roomMatches===true,
    isEvidence:observedState!=='UNKNOWN'&&x.accountMatches===true&&x.roomMatches===true,
    sourceLabel:'TCL_GROUP_SINGLE_SOURCE'
  };
}
function uniqueSamples(samples,asOf){
  const limit=time(asOf), records=[],bad=[],seen=new Map();
  for(const s of samples){
    if(!s||!validDate(s.at)){bad.push({reason:'INVALID_OR_MISSING_TIME'});continue;}
    if(time(s.at)>limit){bad.push({at:String(s.at).slice(0,40),reason:'FUTURE_TIMESTAMP'});continue;}
    if(s.key!==FIRST_TARGET.key||String(s.accountId)!==FIRST_TARGET.accountId){
      bad.push({at:s.at,reason:'ACCOUNT_OR_KEY_MISMATCH'});continue;
    }
    const stamp=iso(s.at), signature=JSON.stringify(s);
    if(seen.has(stamp)){
      if(seen.get(stamp)!==signature)throw Error('CONFLICTING_OBSERVATIONS_SAME_TIME');
      continue;
    }
    seen.set(stamp,signature);records.push(s);
  }
  records.sort(sortedByTime);
  return {records,bad};
}
function inferSessionWindow(s,rows){
  const startMs=time(s.firstLiveDetectedAt);
  const before=rows.filter(r=>r.isEvidence&&r.state==='OFFLINE'&&time(r.at)<startMs).at(-1);
  return {
    sequence:s.sequence,
    status:s.status,
    firstLiveDetectedAt:s.firstLiveDetectedAt,
    lastLiveDetectedAt:s.lastLiveDetectedAt,
    firstOfflineDetectedAt:s.firstOfflineDetectedAt,
    endedConfirmedAt:s.endedConfirmedAt,
    estimatedObservedLiveMinutes:s.estimatedContinuousLiveMinutes,
    previousKnownOfflineAt:before?.at||null,
    startBounds:before?{after:before.at,noLaterThan:s.firstLiveDetectedAt}:null,
    endBounds:s.status==='CLOSED'&&s.firstOfflineDetectedAt?
      {after:s.lastLiveDetectedAt,noLaterThan:s.firstOfflineDetectedAt}:null,
    unknownSamples:s.unknownPoints,
    detectedLiveSamples:s.observedLivePoints,
    exactStartEndKnown:false,
    timeLabelsAre:'FIRST_DETECTED_NOT_PLATFORM_EVENT_TIME',
    durationLabelsAre:'ADJACENT_LIVE_SAMPLES_ESTIMATE_ONLY'
  };
}
export function compileR15Diary(source,{asOf=new Date().toISOString()}={}){
  if(!validDate(asOf))throw Error('INVALID_AS_OF');
  const src=collectSource(source);
  const {records,bad}=uniqueSamples(src.samples,asOf);
  const sessions=reduceTmallSingleStore(records,{asOf});
  const rows=records.map(rowOf);
  const active=sessions.sessions.findLast(s=>s.status!=='CLOSED');
  const observedNow=sessions.currentStatus;
  const phase=observedNow==='UNKNOWN'?'UNKNOWN':
    active?.status==='PENDING_END'?'PENDING_END':
    observedNow==='LIVE'?'LIVE':
    sessions.sessions.some(s=>s.status==='CLOSED')?'ENDED_OBSERVED':'OFFLINE_OBSERVED';
  const valid=rows.filter(r=>r.isEvidence).length;
  const attempts=src.attempts?.length||null;
  const dayGroups=Object.entries(rows.reduce((out,r)=>{
    const d=out[r.day]||(out[r.day]={date:r.day,counts:{LIVE:0,OFFLINE:0,UNKNOWN:0},samples:0});
    d.samples++;d.counts[r.state]++;return out;
  },{})).map(([,value])=>value).sort((a,b)=>a.date.localeCompare(b.date));
  return {
    schemaVersion:15,platform:'tmall',store:'TCL集团官方旗舰店',
    accountId:FIRST_TARGET.accountId,historicalRoomNum:FIRST_TARGET.historicalRoomNum,
    reportKind:src.kind,generatedAt:iso(asOf),displayTimezone:'Asia/Shanghai',
    observationIntervalDuringLiveMinutes:15,idleDiscoveryIntervalMinutes:60,
    latestStatus:observedNow,latestPhase:phase,
    latestStatusReason:sessions.currentStatusReason,
    latestObservationAt:sessions.lastObservationAt,
    sourceRequestsMadeByReport:0,
    observationCounts:sessions.observationCounts,
    totalOriginalRecords:src.samples.length,
    retainedObservations:rows.length,validStateObservations:valid,
    droppedSamples:bad,
    confirmedSessions:sessions.sessions.filter(s=>s.status==='CLOSED').length,
    sessions:sessions.sessions.map(s=>inferSessionWindow(s,rows)),
    timeline:rows,days:dayGroups,
    scoreEligible:false,liveSourceConnected:false,
    isPlatformExactTime:false,
    explanation:'Only first observed LIVE/OFFLINE can be reported. The exact stream start/end and actual minute-by-minute runtime cannot be established with 15-minute snapshots.'
  };
}
export function toR15Csv(diary,{kind='timeline'}={}){
 const esc=v=>{
   let str=String(v==null?'':v);
   if(/^[\s]*[=+\-@]/.test(str))str="'"+str; // spreadsheet formula injection guard
   return '"'+str.replaceAll('"','""')+'"';
 };
 let cols,rows;
 if(kind==='sessions'){
  cols=['场次','状态','首次发现开播（北京时间）','最近发现直播（北京时间）',
     '首次发现下播（北京时间）','第二次确认下播（北京时间）','相邻LIVE估算跨度（分钟）','精确时间'];
  rows=diary.sessions.map(s=>[s.sequence,s.status,bjTime(s.firstLiveDetectedAt),
    bjTime(s.lastLiveDetectedAt),bjTime(s.firstOfflineDetectedAt),bjTime(s.endedConfirmedAt),
    s.estimatedObservedLiveMinutes,'否']);
 }else if(kind==='timeline'){
  cols=['采样时间（UTC ISO）','北京时间日期','状态','原因','账号一致','房间一致','有效状态证据'];
  rows=diary.timeline.map(r=>[r.at,r.day,r.state,r.reason,
    r.accountMatch?'是':'否',r.roomMatch?'是':'否',r.isEvidence?'是':'否']);
 }else throw Error('INVALID_EXPORT_KIND');
 return '\uFEFF'+[cols,...rows].map(a=>a.map(esc).join(',')).join('\r\n')+'\r\n';
}
