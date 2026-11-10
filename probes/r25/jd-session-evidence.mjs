/**
 * R2.5 JD observational session boundary ledger (OFFLINE evidence gate).
 *
 * No network traffic. Caller must validate evidence provenance externally.
 * An "attested" object is only a caller assertion, not a digital signature.
 * This is an experimental accounting aid, not a production JD status oracle.
 * HUMAN vs DIGITAL requires its own video-evidence chain.
 */
import {createHash} from 'node:crypto';

const ID=/^[A-Za-z0-9:_-]{1,90}$/;
const UTC=/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const STATES=new Set(['LIVE','OFFLINE','UNKNOWN']);
const SOURCE_LIVE='VERIFIED_INTERNAL_LIVE';
const SOURCE_OFFLINE='VERIFIED_JD_PLATFORM_NEGATIVE';
const MIN_NEGATIVE_GAP_MS=5*60_000;
const MAX_NEGATIVE_GAP_MS=30*60_000;
const EVIDENCE_FRESH_MS=3*60_000;
const HISTORY_MAX=2000;

function checkTime(value){
 return typeof value==='string' && UTC.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString()===value;
}
function fail(message){throw new Error(message);}
function hash(o){return createHash('sha256').update(JSON.stringify(o)).digest('hex');}
function isEvidenceValid(o){
 const e=o.evidence;
 if(!e||e.identity_verified!==true||e.source_attested!==true||
   typeof e.capture_id!=='string'||!ID.test(e.capture_id)||
   !checkTime(e.captured_at))return false;
 const delay=Date.parse(o.observed_at)-Date.parse(e.captured_at);
 if(delay < -60_000||delay>EVIDENCE_FRESH_MS)return false;
 if(o.stream_state==='LIVE')return e.method===SOURCE_LIVE && e.positive_live_confirmed===true;
 if(o.stream_state==='OFFLINE')return e.method===SOURCE_OFFLINE &&
  e.negative_offline_confirmed===true && e.platform_live_indicator_checked===true;
 return false;
}
export function newJdSessionLedger(room_key){
 if(typeof room_key!=='string'||!ID.test(room_key))fail('INVALID_ROOM_KEY');
 return {schema_version:25,platform:'jd',room_key,stream_state:'UNKNOWN',
  last_checked_at:null,last_observation:null,seen:{},
  active_session_id:null,pending_offline:null,last_confirmed_offline_at:null,
  sessions:[],flags:[],actual_start_times_verified:false,
  actual_end_times_verified:false,opening_rate_percent:null,
  completed_duration_minutes:null,verified_interruption_count:null};
}
export function validateJdSessionLedger(s){
 if(!s||s.schema_version!==25||s.platform!=='jd'||!ID.test(s.room_key||'')||
 !STATES.has(s.stream_state)||!Array.isArray(s.sessions)||!Array.isArray(s.flags)||
 !s.seen||typeof s.seen!=='object'||Array.isArray(s.seen)||
 s.actual_start_times_verified!==false||s.actual_end_times_verified!==false||
 s.opening_rate_percent!==null||s.completed_duration_minutes!==null||
 s.verified_interruption_count!==null)fail('INVALID_SESSION_LEDGER');
 if(s.last_checked_at!==null&&!checkTime(s.last_checked_at))fail('INVALID_LEDGER_TIME');
 if(s.active_session_id!==null&&!ID.test(s.active_session_id))fail('INVALID_ACTIVE_SESSION');
 if(s.pending_offline!==null&&
   (!checkTime(s.pending_offline.at)||!ID.test(s.pending_offline.capture_id)))fail('INVALID_PENDING_NEGATIVE');
 if(s.sessions.length>HISTORY_MAX)fail('SESSION_LIMIT_REACHED');
 for(const x of s.sessions){
  if(!ID.test(x.session_id)||!checkTime(x.first_live_observed_at)||
   !checkTime(x.last_live_observed_at)||
   x.actual_started_at!==null||x.actual_ended_at!==null)fail('INVALID_SESSION_RECORD');
 }
 return s;
}
export function applyJdSessionEvidence(previous,observation){
 const s=structuredClone(validateJdSessionLedger(previous));
 const o=observation;
 if(!o||o.platform!=='jd'||o.room_key!==s.room_key||
  !ID.test(String(o.observation_id||''))||!checkTime(o.observed_at)||
  !STATES.has(o.stream_state))fail('INVALID_OBSERVATION');
 const fp=hash(o);
 if(s.seen[o.observation_id]){
  if(s.seen[o.observation_id]!==fp)fail('OBSERVATION_ID_REUSED_WITH_DIFFERENT_PAYLOAD');
  return {ledger:s,duplicate:true,accepted:false,flags:[]};
 }
 if(s.last_checked_at && Date.parse(o.observed_at)<Date.parse(s.last_checked_at))
  fail('OUT_OF_ORDER_OBSERVATION');
 const flags=[];
 const flag=code=>{
  const f={observation_id:o.observation_id,at:o.observed_at,code};
  flags.push(f);s.flags.push(f);
 };
 const valid=isEvidenceValid(o);
 let next='UNKNOWN';
 if(o.stream_state==='UNKNOWN')flag('UNKNOWN_NOT_OFFLINE');
 else if(!valid)flag('EVIDENCE_UNVERIFIED_OR_STALE');
 else if(o.stream_state==='LIVE'){
  next='LIVE';
  if(s.pending_offline!==null){
   flag('OFFLINE_CANDIDATE_INVALIDATED_BY_LIVE');
   s.pending_offline=null;
  }
  if(s.active_session_id===null){
   const sessionId=o.observation_id;
   if(s.sessions.length>=HISTORY_MAX)fail('SESSION_LIMIT_REACHED');
   s.sessions.push({
    session_id:sessionId,
    first_live_observed_at:o.observed_at,
    last_live_observed_at:o.observed_at,
    start_window:{
     after_confirmed_offline_at:s.last_confirmed_offline_at,
     by_first_live_at:o.observed_at
    },
    first_verified_offline_at:null,confirmed_offline_at:null,
    end_window:null,actual_started_at:null,actual_ended_at:null,
    presenter_type:'UNKNOWN'
   });
   s.active_session_id=sessionId;
  }else{
   const active=s.sessions.findLast(x=>x.session_id===s.active_session_id);
   if(!active||active.confirmed_offline_at)fail('ACTIVE_SESSION_INCONSISTENT');
   active.last_live_observed_at=o.observed_at;
  }
 }else{
  // The source must independently demonstrate that the exact JD account/room
  // is offline. Internal capture-agent silence, partial catalogs, blocked pages,
  // or one negative image cannot close a broadcast.
  if(s.active_session_id===null){
   flag('NEGATIVE_WITHOUT_ACTIVE_SESSION');
  }else if(s.pending_offline===null){
   s.pending_offline={at:o.observed_at,capture_id:o.evidence.capture_id};
   flag('FIRST_NEGATIVE_PENDING_CONFIRMATION');
  }else{
   const elapsed=Date.parse(o.observed_at)-Date.parse(s.pending_offline.at);
   if(o.evidence.capture_id===s.pending_offline.capture_id){
    flag('DUPLICATE_CAPTURE_NOT_INDEPENDENT');
   }else if(elapsed<MIN_NEGATIVE_GAP_MS){
    flag('NEGATIVE_CONFIRMATION_TOO_SOON');
   }else if(elapsed>MAX_NEGATIVE_GAP_MS){
    s.pending_offline={at:o.observed_at,capture_id:o.evidence.capture_id};
    flag('NEGATIVE_CONFIRMATION_WINDOW_EXPIRED');
   }else{
    const active=s.sessions.findLast(x=>x.session_id===s.active_session_id);
    if(!active||active.confirmed_offline_at)fail('ACTIVE_SESSION_INCONSISTENT');
    active.first_verified_offline_at=s.pending_offline.at;
    active.confirmed_offline_at=o.observed_at;
    active.end_window={after_last_live_at:active.last_live_observed_at,
     by_first_verified_offline_at:s.pending_offline.at};
    s.active_session_id=null;
    s.pending_offline=null;
    s.last_confirmed_offline_at=o.observed_at;
    next='OFFLINE';
    flag('OFFLINE_CONFIRMED_BY_TWO_NEGATIVE_OBSERVATIONS');
   }
  }
 }
 // Unconfirmed negatives, signal failures or unverifiable reports must show
 // UNKNOWN, even if the preceding scan had LIVE.
 s.stream_state=next;
 s.last_checked_at=o.observed_at;
 s.last_observation={id:o.observation_id,at:o.observed_at,state:next};
 s.seen[o.observation_id]=fp;
 if(Object.keys(s.seen).length>HISTORY_MAX){
  delete s.seen[Object.keys(s.seen)[0]];
 }
 if(s.flags.length>HISTORY_MAX)s.flags=s.flags.slice(-HISTORY_MAX);
 return {ledger:s,duplicate:false,accepted:valid,flags};
}
export function jdSessionSnapshot(ledger){
 const s=validateJdSessionLedger(ledger);
 return {schema_version:25,platform:'jd',room_key:s.room_key,stream_state:s.stream_state,
  checked_at:s.last_checked_at,active_session_id:s.active_session_id,
  sessions:structuredClone(s.sessions),pending_offline_review:Boolean(s.pending_offline),
  actual_start_times_verified:false,actual_end_times_verified:false,
  opening_rate_percent:null,completed_duration_minutes:null,
  verified_interruption_count:null,
  note:'Boundary intervals are observed evidence, not exact start/end or continuous human-live duration'};
}
