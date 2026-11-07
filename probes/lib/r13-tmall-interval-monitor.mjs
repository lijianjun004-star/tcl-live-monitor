/** R1.3 interval-only session tracker. Pure reducer, never contacts Taobao.
 * Input MUST be a chronological record of independently obtained, read-only samples.
 * All temporal claims are observation times, not exact platform start/end timestamps.
 */
import { FIRST_TARGET, classifyObservation } from './r12-tmall-first.mjs';

export const R13_POLICY = Object.freeze({
  liveIntervalMinutes: 15,
  idleDiscoveryMinutes: 60,
  offlineConfirmations: 2,
  confirmationMaxGapMinutes: 25,
  contiguousLiveMaxGapMinutes: 22,
  freshnessMinutes: 30,
});
const MS = 60_000;
const iso = x => new Date(x).toISOString();
const finiteTime = x => typeof x === 'string' && x.trim() !== '' && Number.isFinite(Date.parse(x));
const validInt = (v,min,max) => Number.isSafeInteger(v) && v >= min && v <= max;

export function assertR13Policy(p = R13_POLICY) {
  for (const [k,min,max] of [
    ['liveIntervalMinutes',5,60], ['idleDiscoveryMinutes',15,1440],
    ['offlineConfirmations',2,3], ['confirmationMaxGapMinutes',5,120],
    ['contiguousLiveMaxGapMinutes',5,120], ['freshnessMinutes',1,120],
  ]) if (!validInt(p[k],min,max)) throw new Error('INVALID_POLICY_'+k);
  return p;
}

function beginSession(sample,index) {
  return {
    sequence:index, status:'OPEN',
    firstLiveDetectedAt:sample.at,
    lastLiveDetectedAt:sample.at,
    firstOfflineDetectedAt:null,
    endedConfirmedAt:null,
    estimatedContinuousLiveMinutes:0,
    observedLivePoints:1,
    unknownPoints:0,
    offlineCandidatesDiscarded:0,
    endWindow:null,
    _pending:null,
    _previous:null
  };
}

/** A LIVE pair separated by <=22 min and with no other observation in between
 * contributes to an explicitly ESTIMATED time-span. It does NOT prove uninterrupted video.
 */
export function reduceTmallSingleStore(rawSamples, {
  asOf = new Date().toISOString(),
  target = FIRST_TARGET,
  policy = R13_POLICY,
} = {}) {
  assertR13Policy(policy);
  if (!Array.isArray(rawSamples)) throw new TypeError('SAMPLES_MUST_BE_ARRAY');
  if (!finiteTime(asOf)) throw new Error('INVALID_AS_OF');
  const now=Date.parse(asOf), dedup=new Map(), observations=[], excluded=[];
  for (const row of rawSamples) {
    if (!row || typeof row!=='object') { excluded.push({reason:'INVALID_ROW'});continue; }
    if (!finiteTime(row.at)) { excluded.push({reason:'MISSING_OBSERVATION_TIME'});continue; }
    const t=Date.parse(row.at);
    if (t>now){excluded.push({at:row.at,reason:'FUTURE_OBSERVATION'});continue;}
    const key=iso(row.at), fingerprint=JSON.stringify(row);
    if (dedup.has(key)) {
      if(dedup.get(key)!==fingerprint) throw new Error('CONFLICTING_SAMPLES_AT_SAME_TIME');
      continue;
    }
    dedup.set(key,fingerprint);
    const classified=classifyObservation(row,target);
    const checked=(classified.accountMatches===true && classified.roomMatches===true &&
      ['LIVE','OFFLINE'].includes(classified.state));
    observations.push({
      at:key,state:checked?classified.state:'UNKNOWN',
      reason:classified.reason,
      accountVerified:classified.accountMatches===true,
      roomVerified:classified.roomMatches===true,
      countedAsEvidence:checked
    });
  }
  observations.sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
  const sessions=[];
  let active=null, last=null, nextSequence=1;
  for(const sample of observations){
    const currentMs=Date.parse(sample.at);
    if(sample.state==='LIVE'){
      if(!active) active=beginSession(sample,nextSequence++);
      else {
        if(active._pending){
          active._pending=null;
          active.offlineCandidatesDiscarded++;
        } else if(last?.state==='LIVE' &&
            currentMs-Date.parse(last.at)<=policy.contiguousLiveMaxGapMinutes*MS) {
          active.estimatedContinuousLiveMinutes+=Math.round((currentMs-Date.parse(last.at))/MS*100)/100;
        }
        active.lastLiveDetectedAt=sample.at;
        active.observedLivePoints++;
      }
      active.status='OPEN';
    }else if(sample.state==='OFFLINE'){
      if(active){
        if(active._pending && last?.state==='OFFLINE' &&
          currentMs-Date.parse(last.at)<=policy.confirmationMaxGapMinutes*MS){
          active.status='CLOSED';
          active.firstOfflineDetectedAt=active._pending.firstOfflineAt;
          active.endedConfirmedAt=sample.at;
          active.endWindow={
            afterLastLive:active.lastLiveDetectedAt,
            noLaterThanFirstObservedOffline:active._pending.firstOfflineAt,
            meaning:'END_BOUND_ONLY_IF_SAMPLES_CORRECT_NOT_EXACT_END'
          };
          delete active._pending;delete active._previous;
          sessions.push(active); active=null;
        }else{
          active._pending={firstOfflineAt:sample.at};
          active.status='PENDING_END';
        }
      }
    }else if(active){
      active.unknownPoints++;
      if(active._pending){
        active.offlineCandidatesDiscarded++;
        active._pending=null;
        active.status='OPEN';
      }
    }
    last=sample;
  }
  if(active){
    delete active._previous;
    // _pending is an internal candidate only; no confirmed end timestamp yet.
    if(active._pending){active.firstOfflineDetectedAt=active._pending.firstOfflineAt;}
    delete active._pending;
    sessions.push(active);
  }
  const recent=last && (now-Date.parse(last.at)<=policy.freshnessMinutes*MS);
  const statusNow=(recent && last.countedAsEvidence)?last.state:'UNKNOWN';
  const activeSession=sessions.findLast(s=>s.status!=='CLOSED')||null;
  const mode=activeSession?'LIVE_FOLLOW_UP':'IDLE_DISCOVERY';
  const minutes=mode==='LIVE_FOLLOW_UP'?policy.liveIntervalMinutes:policy.idleDiscoveryMinutes;
  return {
    schemaVersion:1, mode, targetKey:target.key, accountId:target.accountId,
    historicalRoomNum:target.historicalRoomNum, asOf:iso(asOf),
    currentStatus:statusNow, currentStatusReason:statusNow==='UNKNOWN'
      ?(last?(recent?last.reason:'LAST_OBSERVATION_STALE'):'NO_OBSERVATIONS')
      :last.reason,
    lastObservationAt:last?.at||null,
    recommendedNextIntervalMinutes:minutes,
    nextCheckNotBefore:iso(now+minutes*MS),
    lastKnownObservation:last||null,
    observationCounts:Object.fromEntries(['LIVE','OFFLINE','UNKNOWN'].map(k=>[k,observations.filter(o=>o.state===k).length])),
    sessions:sessions.map(s=>({
      sequence:s.sequence,status:s.status,
      firstLiveDetectedAt:s.firstLiveDetectedAt,
      lastLiveDetectedAt:s.lastLiveDetectedAt,
      firstOfflineDetectedAt:s.firstOfflineDetectedAt,
      endedConfirmedAt:s.endedConfirmedAt,
      estimatedContinuousLiveMinutes:s.estimatedContinuousLiveMinutes,
      observedLivePoints:s.observedLivePoints,
      unknownPoints:s.unknownPoints,
      offlineCandidatesDiscarded:s.offlineCandidatesDiscarded,
      endWindow:s.endWindow,
      durationQualification:'ESTIMATE_FROM_ADJACENT_LIVE_SAMPLES_NOT_ACTUAL_DURATION',
      timeQualification:'DETECTION_TIMES_NOT_EXACT_PLATFORM_START_END'
    })),
    excluded, scoreEligible:false, actualStartEndKnown:false,
    scheduledPollingEnabled:false,
    sourceAccessValidated:false,
    note:'No network or cron. Only authenticated observations may change LIVE/OFFLINE; clock intervals are estimates.'
  };
}

export function renderR13Markdown(report){
  const cn=t=>t?new Date(t).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'未确认';
  const fmt=s=>s===null?'未确认':s;
  const list=report.sessions.length?report.sessions.map(s=>
    '| '+s.sequence+' | '+s.status+' | '+cn(s.firstLiveDetectedAt)+' | '+
    cn(s.firstOfflineDetectedAt)+' | '+cn(s.endedConfirmedAt)+' | '+
    s.estimatedContinuousLiveMinutes+'（估算） |'
  ).join('\n'):'| — | 无已确认场次 | — | — | — | — |';
  return '# TCL集团官方旗舰店｜R1.3 定时观察（仅有证据才更新）\n\n'+
    '**数据计算时间（北京时间）：** '+cn(report.asOf)+'\n\n'+
    '**当前状态：** '+report.currentStatus+'（'+report.currentStatusReason+'）\n\n'+
    '**下次建议巡检：** '+report.recommendedNextIntervalMinutes+' 分钟后（'+report.mode+'）\n\n'+
    '| 场次 | 过程状态 | 首次发现开播（北京时间） | 首次发现下播（北京时间） | 第二次确认下播 | 相邻 LIVE 估算跨度（分钟） |\n'+
    '|---|---|---|---|---|---:|\n'+list+'\n\n'+
    '> 开播/下播时间是观察时间，不是平台真实的开关播时刻。LIVE 相邻采样跨度是估算，不是可证明的连续在线时长。UNKNOWN/漏检的间隔不补算。下播后只保留低频发现新场次的任务，不能完全停止发现任务又自动识别下一次开播。\n\n'+
    '状态计数：'+Object.entries(report.observationCounts).map(([k,v])=>k+'='+v).join('，')+
    '。正式考核：关闭。巡检调度：未启用。';
}
