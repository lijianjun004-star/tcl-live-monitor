/**
 * R2.0 — Conservative JD scheduled opening-rate readiness.
 *
 * This pure module NEVER polls a platform and NEVER infers OFFLINE from silence.
 * Ops internal room ID != JD public account ID != dynamic JD live session ID.
 * Actual opening rate remains NULL until every due, identity-verified scheduled
 * shift has independently corroborated positive opening evidence.
 */
const ID=/^[0-9]{1,16}$/;
const BJT=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?\+08:00$/;
const UTC=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const ALLOWED_STATES=new Set(['LIVE','OFFLINE','UNKNOWN']);
const MAX_SHIFT_MS=22*60*60*1000;
export const OPENING_GRACE_MS=5*60*1000;

function time(s,{bj=false}={}){
 if(typeof s!=='string'||!(bj?BJT:UTC).test(s))throw Error(bj?'TIME_MUST_BE_BEIJING_OFFSET':'TIME_MUST_BE_ISO_UTC');
 const n=Date.parse(s);
 if(!Number.isFinite(n)||new Date(n).toISOString().slice(0,19)!==new Date(n).toISOString().slice(0,19))throw Error('INVALID_TIME');
 // Reject rolled-over dates (e.g., February 30) rather than accepting JS normalization.
 const x=new Date(n);
 const actual=(bj?new Date(n+8*3600*1000):x).toISOString().slice(0,19);
 if(actual!==s.slice(0,19))throw Error('NONEXISTENT_DATE_TIME');
 return n;
}
function id(v){return typeof v==='string'&&ID.test(v);}
function need(condition,code){if(!condition)throw Error(code);}

export function validateJdCrosswalk(crosswalk){
 need(crosswalk?.schema_version===20&&Array.isArray(crosswalk.entries),'INVALID_CROSSWALK');
 const rooms=new Set(),accounts=new Set();
 for(const e of crosswalk.entries){
  need(id(e.ops_room_id)&&!rooms.has(e.ops_room_id),'DUPLICATE_OR_INVALID_OPS_ROOM');
  need(e.ops_shop_id===null||id(e.ops_shop_id),'INVALID_OPS_SHOP');
  need(['VERIFIED','PENDING','CONFLICT'].includes(e.identity_status),'INVALID_IDENTITY_STATUS');
  if(e.identity_status==='VERIFIED'){
   need(id(e.public_jd_account_id)&&
    typeof e.evidence_ref==='string'&&e.evidence_ref.length>=12&&
    e.evidence_ref.startsWith('https://')&&
    e.ops_shop_id!==null,'VERIFIED_IDENTITY_NEEDS_EVIDENCE');
   need(!accounts.has(e.public_jd_account_id),'PUBLIC_ACCOUNT_AMBIGUOUS');
   accounts.add(e.public_jd_account_id);
  }else{
   need(e.public_jd_account_id===null,'UNVERIFIED_PUBLIC_ACCOUNT_MUST_BE_NULL');
  }
  rooms.add(e.ops_room_id);
 }
 return {mapped_ops_rooms:rooms.size,verified_accounts:accounts.size,
  pending:crosswalk.entries.filter(e=>e.identity_status!=='VERIFIED').length};
}

export function validateJdSchedule(schedule){
 need(schedule?.schema_version===20&&schedule.timezone==='Asia/Shanghai'&&Array.isArray(schedule.shifts),'INVALID_SCHEDULE');
 const keys=new Set();
 for(const s of schedule.shifts){
  need(s.platform==='jd'&&typeof s.shift_id==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(s.shift_id)&&
       !keys.has(s.shift_id),'INVALID_OR_DUPLICATE_SHIFT');
  need(id(s.ops_room_id),'INVALID_SHIFT_OPS_ROOM');
  need(s.schedule_verified===true||s.schedule_verified===false,'SHIFT_VERIFICATION_REQUIRED');
  const start=time(s.starts_at,{bj:true}),end=time(s.ends_at,{bj:true});
  need(end>start&&end-start<=MAX_SHIFT_MS,'INVALID_SHIFT_DURATION');
  const revision=time(s.revision_at,{bj:true});
  if(revision>start)need(false,'RETROACTIVE_SHIFT_EDIT_NOT_ACCEPTED');
  if(s.schedule_verified===true)need(typeof s.schedule_evidence_ref==='string'&&s.schedule_evidence_ref.length>=5,'VERIFIED_SHIFT_NEEDS_SOURCE');
  keys.add(s.shift_id);
 }
 return {total:keys.size};
}

export function validateJdObservations(observations){
 need(Array.isArray(observations),'INVALID_OBSERVATIONS');
 const keys=new Set();
 for(const o of observations){
  need(o.platform==='jd'&&id(o.ops_room_id),'INVALID_OBSERVATION_ROOM');
  need(o.ops_shop_id===null||id(o.ops_shop_id),'INVALID_OBSERVATION_SHOP');
  need(ALLOWED_STATES.has(o.state),'INVALID_OBSERVATION_STATE');
  need(typeof o.source==='string'&&o.source.length>0,'OBSERVATION_SOURCE_REQUIRED');
  need(typeof o.source_ref==='string'&&o.source_ref.length>0,'OBSERVATION_REFERENCE_REQUIRED');
  need(typeof o.identity_attested==='boolean'&&typeof o.state_attested==='boolean','OBSERVATION_ATTESTATION_REQUIRED');
  const t=time(o.observed_at);
  const key=o.ops_room_id+'|'+t+'|'+o.source;
  need(!keys.has(key),'DUPLICATE_OBSERVATION');
  keys.add(key);
 }
 return observations.length;
}

/**
 * A true observation of a room at 10:00 does not prove that it opened at 09:00.
 * The five-minute grace window applies only to a LIVE observation itself
 * (not to the oldest reported minute, and not to a synthetic replay).
 */
export function evaluateJdOpening({schedule,crosswalk,observations=[],as_of}){
 validateJdCrosswalk(crosswalk);
 validateJdSchedule(schedule);
 validateJdObservations(observations);
 const now=time(as_of);
 const identities=new Map(crosswalk.entries.map(x=>[x.ops_room_id,x]));
 const results=[];
 for(const s of schedule.shifts){
  const starts=time(s.starts_at,{bj:true}),ends=time(s.ends_at,{bj:true});
  if(starts>now)continue;
  const map=identities.get(s.ops_room_id);
  let status='UNKNOWN',reason='NO_CONFIRMED_LIVE_OBSERVATION';
  const goodIdentity=map?.identity_status==='VERIFIED';
  if(!s.schedule_verified){status='BLOCKED_SCHEDULE';reason='SCHEDULE_NOT_VERIFIED';}
  else if(!goodIdentity){status='BLOCKED_IDENTITY';reason=map?.identity_status==='CONFLICT'?'IDENTITY_CONFLICT':'PUBLIC_JD_ACCOUNT_NOT_VERIFIED';}
  else {
   const rows=observations.filter(o=>
    o.ops_room_id===s.ops_room_id&&
    o.ops_shop_id===map.ops_shop_id&&
    o.state==='LIVE'&&o.state_attested===true&&o.identity_attested===true&&
    o.source==='TCL_OPS_READ_ONLY'&&
    time(o.observed_at)>=starts&&time(o.observed_at)<=Math.min(now,ends));
   if(rows.length){
    rows.sort((a,b)=>time(a.observed_at)-time(b.observed_at));
    const first=time(rows[0].observed_at);
    if(first<=starts+OPENING_GRACE_MS){
      status='OPEN_CONFIRMED_WITHIN_GRACE';reason='FRESH_LIVE_OBSERVED_IN_GRACE';
    }else{
      status='OPEN_CONFIRMED_TIME_UNKNOWN';reason='LIVE_SEEN_AFTER_GRACE_START_MAY_BE_EARLIER';
    }
   }
  }
  results.push({
   shift_id:s.shift_id,ops_room_id:s.ops_room_id,ops_shop_id:map?.ops_shop_id??null,
   planned_start_at:s.starts_at,planned_end_at:s.ends_at,status,reason,
   observed_opened:status.startsWith('OPEN_CONFIRMED'),
   on_time_observed:status==='OPEN_CONFIRMED_WITHIN_GRACE'
  });
 }
 const due=results.length,confirmed=results.filter(x=>x.observed_opened).length,
  timely=results.filter(x=>x.on_time_observed).length;
 const fullCoverage=due>0&&confirmed===due;
 const allTimely=fullCoverage&&timely===due;
 return {
  schema_version:20,as_of,timezone:'Asia/Shanghai',
  scheduled_shifts_total:schedule.shifts.length,due_shifts:due,
  observed_opened_shifts:confirmed,confirmed_within_grace:timely,
  unknown_or_blocked_shifts:due-confirmed,
  opening_rate_percent:fullCoverage?100:null,
  opening_rate_status:due===0?'NO_DUE_SCHEDULE':fullCoverage?'ALL_DUE_SHIFTS_POSITIVELY_OBSERVED':'NOT_READY_UNRESOLVED_DENOMINATOR',
  on_time_rate_percent:allTimely?100:null,
  on_time_rate_status:allTimely?'ALL_DUE_SHIFTS_OBSERVED_WITHIN_GRACE':'NOT_READY_UNKNOWN_START_TIMES',
  actual_open_start_times_known:false,offline_detection_validated:false,
  observations_used_for_inference:'ATTESTED_LIVE_ONLY',
  results
 };
}
