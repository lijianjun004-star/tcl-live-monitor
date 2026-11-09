/**
 * Offline audit for read-only browser evidence produced by the R1.9 fixed path.
 * Historical room observations are never promoted to CURRENT LIVE.
 */
import {validateRegistry} from './douyin-first.mjs';
const ROUTE=/^[1-9][0-9]{7,17}$/;
const SESSION=/^[1-9][0-9]{15,22}$/;

function isLiveUrl(value,route,session,{allowNoSession=false}={}){
 if(!value)return false;
 try{
  const url=new URL(value);
  if(url.protocol!=='https:'||url.host!=='live.douyin.com'||url.pathname!=='/'+route)return false;
  const found=url.searchParams.get('room_id');
  return found===session||(allowNoSession&&found===null);
 }catch{return false;}
}
export function auditFixedPathEvidence(registry,evidence){
 validateRegistry(registry);
 if(evidence?.schema_version!==1||evidence.observation_time_precision!=='DATE_ONLY'||
  !/^\d{4}-\d{2}-\d{2}$/.test(evidence.observation_date_beijing||'')||
  !Array.isArray(evidence.runs))throw Error('INVALID_EVIDENCE_FORMAT');
 const accountKeys=new Set(),runUrls=new Set();
 const results=[];
 for(const r of evidence.runs){
  const target=registry.targets.find(t=>t.key===r.account_key);
  if(!target)throw Error('UNREGISTERED_ACCOUNT');
  if(accountKeys.has(r.account_key))throw Error('DUPLICATE_ACCOUNT_OBSERVATION');
  if(runUrls.has(r.source_run_url))throw Error('DUPLICATE_BROWSER_RUN');
  const sameAccount=r.account_name===target.account_name&&
    r.sec_uid===target.sec_uid&&
    r.display_douyin_id===target.display_douyin_id&&
    r.profile_url===target.profile_url;
  if(!sameAccount||r.profile_identity_verified!==true)throw Error('ACCOUNT_IDENTITY_MISMATCH');
  if(!/^https:\/\/agent\.tinyfish\.ai\/runs\/[a-f0-9-]{36}$/.test(r.source_run_url||''))throw Error('INVALID_BROWSER_RUN_URL');
  if(!ROUTE.test(r.live_route_id)||!SESSION.test(r.dynamic_room_id_from_profile_link))
   throw Error('BAD_ROUTE_OR_SESSION_ID');
  if(!isLiveUrl(r.requested_live_url,r.live_route_id,r.dynamic_room_id_from_profile_link))
   throw Error('REQUESTED_ROOM_LINK_MISMATCH');
  if(r.current_room_payload_attested!==false)throw Error('MISSING_PAYLOAD_PROVENANCE');
  if(!['LIVE','UNKNOWN'].includes(r.status_at_observation))throw Error('UNVALIDATED_OFFLINE_STATUS');
  const roomValid=!!r.final_live_url&&isLiveUrl(r.final_live_url,r.live_route_id,r.dynamic_room_id_from_profile_link,{allowNoSession:true});
  if(r.status_at_observation==='LIVE'&&(
   r.blocked!==false||r.blocker!==null||r.profile_live_badge!==true||
   r.room_page_identity_verified!==true||r.live_ui_verified!==true||!roomValid))
   throw Error('LIVE_WITHOUT_TWO_PAGE_EVIDENCE');
  if(r.status_at_observation==='UNKNOWN'&&r.blocked&&
    (!r.blocker||r.room_page_identity_verified||r.live_ui_verified))throw Error('INVALID_BLOCKED_UNKNOWN');
  if(!['PENDING','NOT_ASSESSED','VERIFIED'].includes(r.business_ownership_review))
   throw Error('OWNER_REVIEW_STATUS_REQUIRED');
  accountKeys.add(r.account_key);runUrls.add(r.source_run_url);
  results.push({
   account_key:r.account_key,account_name:r.account_name,
   observed_date_beijing:evidence.observation_date_beijing,
   time_precision:evidence.observation_time_precision,
   status_at_observation:r.status_at_observation,
   current_state:'UNKNOWN',
   captured_dynamic_room_id:r.dynamic_room_id_from_profile_link,
   dynamic_room_id_source:'PROFILE_CLICKED_LINK',
   live_route_id:r.live_route_id,
   has_room_confirmation:r.room_page_identity_verified&&r.live_ui_verified,
   business_ownership_review:r.business_ownership_review,
   blocker:r.blocker
  });
 }
 return {
  schema_version:1,records:results,
  historical_live_observations:results.filter(x=>x.status_at_observation==='LIVE').length,
  historical_unknown_observations:results.filter(x=>x.status_at_observation==='UNKNOWN').length,
  current_live_claims:0,current_offline_claims:0,
  ongoing_monitor_enabled:false,precise_stream_duration_known:false
 };
}
