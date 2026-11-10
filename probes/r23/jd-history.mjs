/**
 * R2.3 unattended JD observations: pure, conservative cross-run state machine.
 *
 * Only internal room state. Never emits an actual JD start/end time,
 * OFFLINE, an interruption count, or a formal opening-rate denominator.
 * Caller is responsible for obtaining ONE authorized read-only report.
 */
const STATES=new Set(['LIVE','UNKNOWN']);
const ISO=/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/;
const ROOM=/^\d{1,16}$/;
const WINDOW_MS=90*86400_000,MAX_RECORDS=100_000;
const bool=x=>x===true;
const timestamp=x=>typeof x==='string'&&ISO.test(x)&&Number.isFinite(Date.parse(x))&&
  new Date(Date.parse(x)).toISOString().slice(0,19)===x.slice(0,19);
const failedSource=x=>!x||!['OBSERVED','PARTIAL'].includes(x.readiness)||
  x.schema_version!==21||x.platform!=='jd'||x.source!=='TCL_OPS_READ_ONLY';
const empty=()=>({schema_version:23,platform:'jd',version:1,rooms:{},checks:[],events:[],
 last_processed_run:null,last_checked_at:null,source_coverage:'UNKNOWN',
 formal_opening_rate_percent:null,known_actual_start_times:false,
 known_actual_end_times:false,verified_offline_counter:0});

export function validateState(input){
 if(input==null)return empty();
 if(input.schema_version!==23||input.platform!=='jd'||input.version!==1||
    typeof input.rooms!=='object'||input.rooms===null||Array.isArray(input.rooms)||
    !Array.isArray(input.checks)||!Array.isArray(input.events)||
    input.formal_opening_rate_percent!==null||
    input.known_actual_start_times!==false||input.known_actual_end_times!==false||
    input.verified_offline_counter!==0)throw Error('BAD_PERSISTED_STATE');
 for(const [id,room] of Object.entries(input.rooms)){
  if(!ROOM.test(id)||!room||!STATES.has(room.state))throw Error('BAD_PERSISTED_ROOM');
 }
 for(const row of [...input.checks,...input.events]){
  if(!timestamp(row.at)||!ROOM.test(String(row.room_id||'0'))&&row.room_id!==null)
    throw Error('BAD_PERSISTED_EVENT');
 }
 return input;
}
function safeRoom(row){
 if(!row||!ROOM.test(String(row.room_id))||!STATES.has(row.state))throw Error('UNSAFE_ROOM_OBSERVATION');
 return {state:row.state,shop_id:row.shop_id===null?null:String(row.shop_id),
  category:String(row.category||'').slice(0,48),
  reason:String(row.reason||'').replace(/[^A-Za-z0-9_:.-]/g,'_').slice(0,80)};
}
function trimRows(rows,cutoff,limit){
 return rows.filter(x=>Date.parse(x.at)>=cutoff).slice(-limit);
}
export function updateJdHistory(previous,report,{now,run_id,maxAgeMs=15*60_000}={}){
 const state=structuredClone(validateState(previous));
 if(!timestamp(now)||typeof run_id!=='string'||!/^[-\w.:]{1,120}$/.test(run_id))
   throw Error('BAD_RUN_ID_OR_TIME');
 const t=Date.parse(now),cutoff=t-WINDOW_MS;
 if(state.last_processed_run===run_id)return {state,delta:[],duplicate:true,source_accepted:false};
 if(state.last_checked_at&&t<Date.parse(state.last_checked_at)-60_000)
   throw Error('CLOCK_MOVED_BACKWARD');
 const checked=timestamp(report?.checked_at)?Date.parse(report.checked_at):NaN;
 const fresh=Number.isFinite(checked)&&checked<=t+60_000&&t-checked<=maxAgeMs;
 const sourceValid=!failedSource(report)&&fresh;
 const current=new Map();
 if(sourceValid){
  if(!Array.isArray(report.rooms)||report.rooms.length===0||
    report.room_count!==report.rooms.length||
    report.live+report.unknown!==report.rooms.length||
    report.offline!==0||
    report.formal_opening_rate_percent!==null||
    report.formal_attendance_ready!==false||
    report.fully_verified_public_accounts!==false||
    report.fully_verified_schedule!==false)throw Error('SCAN_CONTRACT_MISMATCH');
  for(const row of report.rooms){
   const id=String(row.room_id);
   if(current.has(id))throw Error('SCAN_DUPLICATE_ROOM');
   current.set(id,safeRoom(row));
  }
 }
 const ids=new Set([...Object.keys(state.rooms),...current.keys()]);
 const delta=[],at=now;
 for(const id of [...ids].sort((a,b)=>Number(a)-Number(b))){
  const prev=state.rooms[id]||null;
  const row=current.get(id)||null;
  // Missing room in an incomplete listing or failed source is not OFFLINE.
  const next=row?.state||'UNKNOWN';
  const code=next==='LIVE'?(prev?.state==='LIVE'?'LIVE_STILL_OBSERVED':
    prev?.state==='UNKNOWN'?'LIVE_SIGNAL_RETURNED':'FIRST_LIVE_SEEN'):
    prev?.state==='LIVE'?'LIVE_SIGNAL_LOST_NOT_OFFLINE':
    row?'UNKNOWN_OBSERVED':'SOURCE_OR_ROOM_UNAVAILABLE';
  const event=(!prev||prev.state!==next)?{at,room_id:id,event:code,
    from:prev?.state||null,to:next,reason:row?.reason||'NO_CURRENT_EVIDENCE'}:null;
  if(event){state.events.push(event);delta.push(event);}
  const room={room_id:id,state:next,shop_id:row?.shop_id??prev?.shop_id??null,
    category:row?.category||prev?.category||'',
    reason:row?.reason||(sourceValid?'MISSING_FROM_LATEST_CATALOG':'SOURCE_UNAVAILABLE'),
    first_live_seen_at:next==='LIVE'?(prev?.first_live_seen_at||at):prev?.first_live_seen_at||null,
    last_live_seen_at:next==='LIVE'?at:prev?.last_live_seen_at||null,
    last_observed_at:row?at:prev?.last_observed_at||null,
    actual_started_at:null,actual_ended_at:null};
  state.rooms[id]=room;
  state.checks.push({at,room_id:id,state:next,source_valid:sourceValid,reason:room.reason});
 }
 state.checks=trimRows(state.checks,cutoff,MAX_RECORDS);
 state.events=trimRows(state.events,cutoff,MAX_RECORDS);
 state.last_checked_at=at;state.last_processed_run=run_id;
 state.source_coverage=sourceValid?report.readiness:'UNKNOWN';
 state.formal_opening_rate_percent=null;
 return {state,delta,duplicate:false,source_accepted:sourceValid,
  counts:{LIVE:Object.values(state.rooms).filter(x=>x.state==='LIVE').length,
    UNKNOWN:Object.values(state.rooms).filter(x=>x.state==='UNKNOWN').length,
    OFFLINE:0},
  warning:sourceValid?report.readiness:'SOURCE_UNAVAILABLE_OR_STALE'};
}
export function latestPublicSummary(state,now){
 const s=validateState(state);
 const fresh=timestamp(now)&&timestamp(s.last_checked_at)&&
  Date.parse(now)-Date.parse(s.last_checked_at)>=-60_000&&
  Date.parse(now)-Date.parse(s.last_checked_at)<=15*60_000;
 const rooms=Object.values(s.rooms).sort((a,b)=>Number(a.room_id)-Number(b.room_id))
  .map(r=>({room_id:r.room_id,shop_id:r.shop_id,category:r.category,
   last_observed_state:r.state,current_state:fresh?r.state:'UNKNOWN',
   first_detected_live_at:r.first_live_seen_at,last_detected_live_at:r.last_live_seen_at,
   actual_started_at:null,actual_ended_at:null}));
 return {schema_version:23,generated_at:now,previous_scan_at:s.last_checked_at,
  source_fresh:Boolean(fresh),source_coverage:s.source_coverage,
  room_count:rooms.length,observed_live:rooms.filter(r=>r.current_state==='LIVE').length,
  current_unknown:rooms.filter(r=>r.current_state==='UNKNOWN').length,
  actual_start_times_verified:false,actual_end_times_verified:false,
  offline_determination_validated:false,interruption_count_verified:false,
  opening_rate_percent:null,rooms};
}
