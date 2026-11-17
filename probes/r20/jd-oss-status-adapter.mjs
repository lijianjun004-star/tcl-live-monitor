/**
 * R2.0 JD public-source open-status adapter (offline normalization only).
 *
 * Design studied from ihmily/streamget (MIT), reference pinned SHA:
 * 016a8d6fbef4f5f14c0ec986dc3528c5a22235ab
 * streamget/platforms/jd/live_stream.py
 *
 * Do not mirror upstream default is_live=false as OFFLINE. It can mean a
 * failed redirect, missing authorId/liveId, login wall or API error.
 * This module does NOT make platform requests or install dependencies.
 */
const ID=/^[1-9]\d{4,22}$/;
const TS=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
function validTime(value){return typeof value==='string'&&TS.test(value)&&Number.isFinite(Date.parse(value));}
function safeId(v){return typeof v==='string'&&ID.test(v)?v:null;}
function clean(s){return typeof s==='string'?s.trim().slice(0,150):'';}
const BASE={
 platform:'jd',source:'OSS_STREAMGET_JD_UPSTREAM_NORMALIZED',
 state:'UNKNOWN',source_attested:false,identity_attested:false,
 live_id:null,public_anchor_id:null,public_anchor_name:null,
 blocked:false,negative_offline_attested:false,
 recording_url_excluded:true,schedule_match_attested:false,
 eligible_for_opening_rate:false
};
/**
 * @param {object} input Evidence from a user-authorized ONE-SHOT caller. 
 * Caller must not supply raw cookies, stream URLs or user credentials.
 * Positive status requires real platform status=1 + anchor identity + fresh
 * observation. A truthy is_live boolean ALONE is insufficient.
 */
export function normalizeJdOssStatus(input,{now=new Date().toISOString(),maxAgeMs=5*60_000}={}){
 const out={...BASE,reason:'NO_EVIDENCE',observed_at:null};
 if(!input||typeof input!=='object'||Array.isArray(input))return out;
 const seen=input.observed_at,observed=Date.parse(seen),current=Date.parse(now);
 if(!validTime(seen)||!validTime(now)||!Number.isFinite(observed)||!Number.isFinite(current))
  return {...out,reason:'INVALID_OBSERVATION_TIMESTAMP'};
 if(observed>current+60_000||current-observed>maxAgeMs)
  return {...out,reason:'STALE_OR_FUTURE_EVIDENCE'};
 out.observed_at=seen;
 if(input.access_result==='LOGIN_REQUIRED'||input.access_result==='CAPTCHA'||
    input.access_result==='HTTP_403'||input.access_result==='HTTP_429'||input.access_result==='SECURITY_CHALLENGE')
  return {...out,blocked:true,reason:'ACCESS_OR_AUTH_BLOCKED'};
 if(input.access_result!=='OK'||input.http_status!==200)
  return {...out,reason:'SOURCE_FAILED_OR_UNAVAILABLE'};
 if(input.platform!=='jd'||input.source_method!=='JD_VISIBLE_SOURCE_STATUS')
  return {...out,reason:'SOURCE_PROVENANCE_UNVERIFIED'};
 const anchorId=safeId(input.public_anchor_id),liveId=safeId(input.live_id);
 const anchorName=clean(input.public_anchor_name);
 const identity=anchorId&&anchorName&&input.anchor_identity_confirmed===true&&
  input.verified_profile_url?.startsWith('https://')&&
  input.room_to_anchor_match===true;
 if(!identity)return {...out,reason:'PUBLIC_ANCHOR_IDENTITY_NOT_VERIFIED'};
 out.identity_attested=true;
 out.public_anchor_id=anchorId;
 out.public_anchor_name=anchorName;
 if(input.status_code===1&&input.is_live===true&&liveId&&input.room_live_ui_observed===true){
  return {...out,state:'LIVE',live_id:liveId,source_attested:true,
   reason:'FRESH_ANCHOR_ROOM_STATUS_1_CORROBORATED'};
 }
 // status !=1, missing liveId, is_live=false or unsupported fields must
 // NOT be converted into OFFLINE without independently validated negative.
 return {...out,reason:'NO_CORROBORATED_LIVE_OR_NEGATIVE_EVIDENCE'};
}
export function summarizeJdOssScan(rows){
 if(!Array.isArray(rows))throw Error('ROWS_MUST_BE_ARRAY');
 const counts={LIVE:0,OFFLINE:0,UNKNOWN:0};
 const cleanRows=[];
 for(const r of rows){
  if(!r||!['LIVE','UNKNOWN'].includes(r.state)||r.eligible_for_opening_rate!==false)
   throw Error('INVALID_JD_OSS_NORMALIZED_ROW');
  counts[r.state]++;
  cleanRows.push({
   public_anchor_id:r.public_anchor_id||null,
   live_id:r.live_id||null,state:r.state,
   reason:r.reason,observed_at:r.observed_at||null
  });
 }
 return {scope:'EXPERIMENTAL_PUBLIC_SOURCE_ONLY',counts,rows:cleanRows,
  opening_rate_percent:null,offline_validated:false,
  source_connection_tested:false,
  linked_ops_rooms:0,verified_scheduled_shifts:0,
  eligible_for_production:false};
}
