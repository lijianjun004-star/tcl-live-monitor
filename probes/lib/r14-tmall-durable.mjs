/** R1.4 durable single-store scheduling & history. No network or platform API.
 * Ledger is a portable local JSON document; deployer must provide external persistence
 * before enabling cron. No code path claims official start/end or score.
 */
import { FIRST_TARGET } from './r12-tmall-first.mjs';
import { reduceTmallSingleStore, R13_POLICY } from './r13-tmall-interval-monitor.mjs';

const MINUTE=60_000;
export const STORE_ID='tmall:accountId:2050532947';
export const LEDGER_SCHEMA=14;
export const MAX_SAMPLES=10000;
export const ALLOWED_FAILURE_CODES=Object.freeze([
 'NO_APPROVED_SOURCE','HTTP_ERROR','NETWORK_ERROR','TIMEOUT','PLATFORM_THROTTLED',
 'CAPTCHA_OR_LOGIN_REQUIRED','SITE_ACCESS_BLOCKED','PARSER_ERROR',
 'UNVERIFIED_IDENTITY','PROBE_NOT_RUN','SCHEDULER_DELAY'
]);
const ISO=x=>new Date(x).toISOString();
function at(x,label='INVALID_TIME'){
 if(typeof x!=='string'||!x.trim()||!Number.isFinite(Date.parse(x)))throw Error(label);
 return Date.parse(x);
}
function jsonCopy(x){return JSON.parse(JSON.stringify(x));}
function own(obj,key){return Object.prototype.hasOwnProperty.call(obj,key);}
export function emptyLedger(){
 return {schemaVersion:LEDGER_SCHEMA,platform:'tmall',accountId:FIRST_TARGET.accountId,
         roomNumber:FIRST_TARGET.historicalRoomNum,subjectKey:FIRST_TARGET.key,
         mode:'SINGLE_STORE_ONLY',observations:[],attempts:[],
         provenance:'NO_APPROVED_REALTIME_SOURCE',scoringEnabled:false};
}
export function parseLedger(source){
 const obj=typeof source==='string'?JSON.parse(source):source;
 if(!obj||Array.isArray(obj)||typeof obj!=='object')throw Error('INVALID_LEDGER_OBJECT');
 if(obj.schemaVersion!==LEDGER_SCHEMA||obj.platform!=='tmall'||obj.subjectKey!==FIRST_TARGET.key||
    String(obj.accountId)!==FIRST_TARGET.accountId||
    String(obj.roomNumber)!==FIRST_TARGET.historicalRoomNum||
    obj.mode!=='SINGLE_STORE_ONLY'||obj.scoringEnabled!==false||
    !Array.isArray(obj.observations)||!Array.isArray(obj.attempts))throw Error('LEDGER_IDENTITY_OR_SCHEMA_MISMATCH');
 if(obj.observations.length>MAX_SAMPLES||obj.attempts.length>MAX_SAMPLES)throw Error('LEDGER_LIMIT_EXCEEDED');
 for(const a of obj.attempts){
  if(!a||typeof a!=='object'||!own(a,'at'))throw Error('BAD_ATTEMPT');
  at(a.at);
  if(a.failureCode!=null&&!ALLOWED_FAILURE_CODES.includes(a.failureCode))throw Error('BAD_FAILURE_CODE');
 }
 for(const s of obj.observations){
  if(!s||typeof s!=='object'||typeof s.key!=='string')throw Error('BAD_SAMPLE');
  at(s.at);
  if(own(s,'cookie')||own(s,'token')||own(s,'AppSecret')||own(s,'bodyExcerpt'))throw Error('SENSITIVE_FIELD_BLOCKED');
 }
 return jsonCopy(obj);
}
function sanitizedSample(s){
 if(!s||typeof s!=='object')throw Error('BAD_SAMPLE');
 if(String(s.key)!==FIRST_TARGET.key||String(s.accountId)!==FIRST_TARGET.accountId)throw Error('WRONG_STORE_SAMPLE');
 const timestamp=ISO(at(s.at));
 const codes=(Array.isArray(s.codes)?s.codes:[]).slice(0,6).map(x=>String(x).slice(0,64));
 if(codes.some(x=>!(/^[A-Z0-9_]{1,64}$/.test(x))))throw Error('BAD_STATUS_CODE');
 const n=x=>x===1||x===0?x:null;
 const room=s.roomNumber==null?null:String(s.roomNumber);
 const name=s.observedName==null?null:String(s.observedName);
 if((room&&!/^\d{3,15}$/.test(room))||(name&&name.length>80))throw Error('BAD_SOURCE_IDENTITY_FIELD');
 return {key:FIRST_TARGET.key,accountId:FIRST_TARGET.accountId,
   at:timestamp,roomNumber:room,observedName:name,
   roomStatus:n(s.roomStatus),streamStatus:n(s.streamStatus),
   mtop:String(s.mtop||'UNKNOWN').slice(0,48),codes,
   state:['LIVE','OFFLINE','UNKNOWN'].includes(s.state)?s.state:'UNKNOWN'};
}
function lastAttempt(ledger){
 if(!ledger.attempts.length)return null;
 return ledger.attempts.reduce((a,b)=>at(a.at)>at(b.at)?a:b);
}
export function planTmallTick(ledger,{nowIso=new Date().toISOString(),policy=R13_POLICY}={}){
 const data=parseLedger(ledger),currentTime=at(nowIso);
 const report=reduceTmallSingleStore(data.observations,{asOf:ISO(currentTime),policy});
 const attempt=lastAttempt(data);
 const dueInterval=report.recommendedNextIntervalMinutes;
 const nextDueMs=attempt?at(attempt.at)+dueInterval*MINUTE:null;
 const due=nextDueMs===null||currentTime>=nextDueMs;
 return {
  key:FIRST_TARGET.key,
  mode:report.mode,
  nowIso:ISO(currentTime),
  latestStatus:report.currentStatus,
  latestStatusReason:report.currentStatusReason,
  lastAttemptAt:attempt?.at||null,
  lastAttemptFailureCode:attempt?.failureCode||null,
  intervalMinutes:dueInterval,
  due,
  nextDueAt:nextDueMs==null?ISO(currentTime):ISO(Math.max(currentTime,nextDueMs)),
  sessions:report.sessions.map(s=>({...s})),
  observationCounts:report.observationCounts,
  scoringEligible:false,platformSourceConnected:false,
  note:'Decision to attempt only; not a live data observation'
 };
}
/** One due tick, optionally from an independently approved upstream adapter.
 * NO direct HTTP calls. In offline mode, only a safe UNKNOWN reason is stored.
 * actual rawSource is never persisted.
 */
export function recordR14Tick(ledger,{
 nowIso, failureCode='NO_APPROVED_SOURCE',
 approvedSample=null,
 policy=R13_POLICY,
}={}){
 const source=parseLedger(ledger);
 const before=planTmallTick(source,{nowIso,policy});
 if(!before.due)return {ledger:source,plan:before,action:'NOT_DUE'};
 const now=before.nowIso;
 const last=lastAttempt(source);
 if(last&&at(now)<=at(last.at))throw Error('NON_MONOTONIC_TICK');
 const out=jsonCopy(source);
 if(approvedSample!==null){
  // This object can only be supplied by an adapter already approved for production.
  // This module DOES NOT certify external provenance; deployment must enforce it.
  const sample=sanitizedSample(approvedSample);
  const drift=at(sample.at)-at(now);
  if(Math.abs(drift)>10*MINUTE)throw Error('SAMPLE_TIMESTAMP_DRIFT');
  if(out.observations.some(x=>x.at===sample.at))throw Error('REPEATED_OR_CONFLICTING_SAMPLE_TIME');
  out.observations.push(sample);
  out.attempts.push({at:now,failureCode:null});
 }else{
  if(!ALLOWED_FAILURE_CODES.includes(failureCode))throw Error('UNSUPPORTED_FAILURE_CODE');
  out.observations.push({
   key:FIRST_TARGET.key,accountId:FIRST_TARGET.accountId,at:now,
   roomNumber:null,observedName:null,roomStatus:null,streamStatus:null,
   mtop:'NOT_AVAILABLE',codes:[],state:'UNKNOWN'
  });
  out.attempts.push({at:now,failureCode});
 }
 if(out.observations.length>MAX_SAMPLES||out.attempts.length>MAX_SAMPLES)throw Error('LEDGER_LIMIT_EXCEEDED');
 return {ledger:out,plan:planTmallTick(out,{nowIso:now,policy}),action:approvedSample?'OBSERVATION_RECORDED':'UNKNOWN_RECORDED'};
}
