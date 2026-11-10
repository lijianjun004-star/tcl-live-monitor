/**
 * TCL R2.4: observed presenter segments, independent of platform LIVE.
 *
 * A digital presenter may follow a confirmed human end, never overlap an
 * active human segment. Evidence is a reviewed observation, NOT face-stability
 * heuristics, and these functions do not obtain/verify video or platform data.
 * Human/digital durations and actual start/end times remain unverified/null.
 */
const PLATFORMS=new Set(['jd','tmall','douyin']);
const REVIEWED=new Set(['REVIEWED_LIVE_VIDEO','REVIEWED_REPLAY','OPERATOR_ATTESTED']);
const KINDS=new Set(['HUMAN_PRESENT','HUMAN_STOP_OBSERVED',
 'DIGITAL_PRESENT','DIGITAL_STOP_OBSERVED','SIGNAL_UNKNOWN']);
const IDENTIFIER=/^[A-Za-z0-9:_-]{1,90}$/;
function time(x){
 return typeof x==='string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(x)
   && Number.isFinite(Date.parse(x)) && new Date(x).toISOString()===x;
}
export function createPresenterLedger({platform,shop_key}={}){
 if(!PLATFORMS.has(platform)||typeof shop_key!=='string'||!IDENTIFIER.test(shop_key))
  throw Error('INVALID_PRESENTER_SCOPE');
 return {schema_version:24,platform,shop_key,active_mode:null,current_presenter:'UNKNOWN',
  last_checked_at:null,last_observation:null,last_closed_mode:null,
  segments:[],review_flags:[],actual_human_minutes:null,actual_digital_minutes:null,
  actual_start_times_verified:false,actual_end_times_verified:false};
}
function ensureLedger(s){
 if(!s||s.schema_version!==24||!PLATFORMS.has(s.platform)||
  typeof s.shop_key!=='string'||!IDENTIFIER.test(s.shop_key)||
  !Array.isArray(s.segments)||!Array.isArray(s.review_flags)||
  ![null,'HUMAN','DIGITAL'].includes(s.active_mode)||
  ![null,'HUMAN','DIGITAL'].includes(s.last_closed_mode)||
  s.actual_human_minutes!==null||s.actual_digital_minutes!==null||
  s.actual_start_times_verified!==false||s.actual_end_times_verified!==false)
  throw Error('INVALID_PRESENTER_LEDGER');
 return s;
}
export function addPresenterObservation(previous,observation){
 const s=structuredClone(ensureLedger(previous));
 const o=observation;
 if(!o||o.platform!==s.platform||o.shop_key!==s.shop_key||
   !IDENTIFIER.test(String(o.id||''))||!KINDS.has(o.kind)||!time(o.observed_at))
   throw Error('INVALID_PRESENTER_OBSERVATION');
 const fingerprint=JSON.stringify({id:o.id,platform:o.platform,shop_key:o.shop_key,
  kind:o.kind,observed_at:o.observed_at,evidence:o.evidence||null});
 if(s.last_observation?.id===o.id){
  if(s.last_observation.fingerprint!==fingerprint)throw Error('OBSERVATION_ID_CONFLICT');
  return {ledger:s,duplicate:true,flags:[]};
 }
 if(s.last_checked_at&&Date.parse(o.observed_at)<Date.parse(s.last_checked_at))
  throw Error('OUT_OF_ORDER_PRESENTER_OBSERVATION');
 const flags=[];
 function mark(code){
  const f={observed_at:o.observed_at,observation_id:o.id,code};
  s.review_flags.push(f);flags.push(f);
 }
 const isUnknown=o.kind==='SIGNAL_UNKNOWN';
 if(isUnknown){
  s.current_presenter='UNKNOWN';
  mark('SIGNAL_MISSING_DO_NOT_ASSUME_STOP');
 }else if(!REVIEWED.has(o.evidence)){
  // A model guess, fixed face or failed network probe is not sufficient proof.
  s.current_presenter='UNKNOWN';
  mark('PRESENTER_EVIDENCE_NOT_REVIEWED');
 }else if(s.platform==='douyin'&&o.kind.startsWith('DIGITAL_')){
  s.current_presenter='UNKNOWN';
  mark('TCL_DOUYIN_DIGITAL_POLICY_REVIEW');
 }else if(o.kind.endsWith('_PRESENT')){
  const mode=o.kind.startsWith('HUMAN_')?'HUMAN':'DIGITAL';
  if(s.active_mode&&s.active_mode!==mode){
   s.current_presenter='UNKNOWN';
   mark('PRESENTER_SWITCH_WITHOUT_CONFIRMED_END');
  }else if(s.active_mode===mode){
   const a=s.segments.at(-1);
   if(!a||a.mode!==mode||a.stop_detected_at)throw Error('INVALID_ACTIVE_SEGMENT');
   if(s.current_presenter==='UNKNOWN'||Date.parse(o.observed_at)-Date.parse(a.last_seen_at)>15*60000)
    a.continuity_verified=false;
   a.last_seen_at=o.observed_at;
   s.current_presenter=mode;
  }else{
   s.segments.push({segment_id:o.id,mode,first_detected_at:o.observed_at,
    last_seen_at:o.observed_at,stop_detected_at:null,
    human_end_before_digital_confirmed:mode==='DIGITAL'?s.last_closed_mode==='HUMAN':null,
    continuity_verified:false,actual_started_at:null,actual_ended_at:null});
   if(mode==='DIGITAL'&&s.last_closed_mode!=='HUMAN')
    mark('PRIOR_HUMAN_END_NOT_OBSERVED');
   s.active_mode=mode;s.current_presenter=mode;
  }
 }else if(o.kind.endsWith('_STOP_OBSERVED')){
  const mode=o.kind.startsWith('HUMAN_')?'HUMAN':'DIGITAL';
  if(s.active_mode!==mode){
   s.current_presenter='UNKNOWN';
   mark('PRESENTER_STOP_WITHOUT_ACTIVE_SEGMENT');
  }else{
   const a=s.segments.at(-1);
   if(!a||a.mode!==mode||a.stop_detected_at)throw Error('INVALID_ACTIVE_SEGMENT');
   a.stop_detected_at=o.observed_at;
   s.active_mode=null;s.current_presenter='UNKNOWN';s.last_closed_mode=mode;
  }
 }
 s.last_checked_at=o.observed_at;
 s.last_observation={id:o.id,fingerprint};
 return {ledger:s,duplicate:false,flags};
}
export function presenterSnapshot(ledger){
 const s=ensureLedger(ledger);
 return {schema_version:24,platform:s.platform,shop_key:s.shop_key,
  current_presenter:s.current_presenter,active_mode_unconfirmed_if_unknown:s.active_mode,
  segments:s.segments.map(x=>({...x})),review_flags:s.review_flags.map(x=>({...x})),
  live_status:'UNKNOWN',actual_human_minutes:null,actual_digital_minutes:null,
  actual_start_times_verified:false,actual_end_times_verified:false,
  note:'Presenter evidence is independent of stream LIVE/OFFLINE; no duration or formal attendance inferred'};
}
