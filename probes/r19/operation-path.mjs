/**
 * R1.9 — fixed, account-first operating path for TCL / FFALCON Douyin.
 *
 * No network, credentials, or browser control here. This is the common path
 * contract for human verification, CodeX and future approved probes.
 */
import {validateRegistry,firstPartyTargets} from './douyin-first.mjs';

export const PATH_VERSION='R19_ACCOUNT_FIRST_V1';
export const PATH_STEPS=Object.freeze([
 '01_LOOKUP_STABLE_ACCOUNT',
 '02_OPEN_EXACT_PROFILE_ONCE',
 '03_VERIFY_SEC_UID_NAME_AND_DOUYIN_ID',
 '04_LOCATE_FRESH_PROFILE_LIVE_BADGE',
 '05_FOLLOW_CURRENT_BADGE_LINK_ONCE',
 '06_CROSS_VERIFY_ROOM_ACCOUNT_AND_LIVE_UI',
 '07_RECORD_PROVENANCE_TIME_AND_UNKNOWN_FALLBACK'
]);

const clean=s=>String(s??'').trim();
const blocked=new Set(['CAPTCHA','AUTH_REQUIRED','SECURITY_CHALLENGE','RATE_LIMIT','TIMEOUT','NETWORK_ERROR','HTTP_FAILURE','ROOM_IDENTITY_MISMATCH']);

/** An exact key, display Douyin ID or secUid resolves to one account only. */
export function findAccount(registry,identifier,{includeAdjacentBusinesses=false}={}){
 validateRegistry(registry);
 const value=clean(identifier);
 if(!value)throw Error('ACCOUNT_IDENTIFIER_REQUIRED');
 const pool=firstPartyTargets(registry,{includeAdjacentBusinesses});
 const matches=pool.filter(t=>[t.key,t.display_douyin_id,t.sec_uid].includes(value));
 if(matches.length!==1)throw Error(matches.length?'AMBIGUOUS_ACCOUNT':'ACCOUNT_NOT_IN_ROSTER');
 return matches[0];
}

/** Search existing registry locally, NOT on Douyin. Never auto-select ambiguous names. */
export function searchRoster(registry,term,{includeAdjacentBusinesses=false}={}){
 const value=clean(term).toLowerCase();
 const pool=firstPartyTargets(registry,{includeAdjacentBusinesses});
 if(!value)return pool;
 return pool.filter(t=>[t.key,t.account_name,t.display_douyin_id,t.business_segment]
  .some(field=>String(field).toLowerCase().includes(value)));
}

export function fixedOperationPath(target){
 if(!target||!target.sec_uid||!target.profile_url)throw Error('INVALID_ACCOUNT');
 return {
  path_version:PATH_VERSION,
  account_key:target.key,
  account_name:target.account_name,
  display_douyin_id:target.display_douyin_id,
  sec_uid:target.sec_uid,
  segment:target.business_segment,
  profile_url:target.profile_url,
  steps:[...PATH_STEPS],
  live_query_url:null,
  current_live_route_id:null,
  current_dynamic_room_id:null,
  historical_route_for_reference_only:target.evidence?.live_route_id??target.legacy_historical_route_id??null,
  historic_profile_live_badge_not_current:true,
  identity_gate:'exact secUid + displayed Douyin ID + matching account name',
  live_gate:'fresh profile live badge -> visible live link -> same account room page with live UI',
  state_until_live_gate:'UNKNOWN',
  absent_badge_result:'UNKNOWN',
  offline_rule:'NOT_VALIDATED_DO_NOT_INFER_OFFLINE',
  safety:'READ_ONLY_ONE_PROFILE_ONE_ROOM_NO_CHALLENGE_BYPASS',
  schedule:'MANUAL_ONLY_NO_CRON',
  scoring_enabled:false
 };
}

/** A deterministic, explicit next action. Never advise retry after a challenge. */
export function nextAction({stage='START',result='UNKNOWN'}={}){
 if(blocked.has(result))return {step:'STOP',state:'UNKNOWN',reason:result,retry:false};
 if(stage==='START')return {step:'OPEN_EXACT_PROFILE',state:'UNKNOWN',retry:false};
 if(stage==='PROFILE_IDENTITY_MISMATCH')return {step:'STOP_AND_FLAG_IDENTITY_CONFLICT',state:'UNKNOWN',retry:false};
 if(stage==='PROFILE_VERIFIED'&&result==='NO_BADGE')
  return {step:'STOP_NO_OFFLINE_ASSERTION',state:'UNKNOWN',retry:false};
 if(stage==='PROFILE_VERIFIED'&&result==='FRESH_BADGE')
  return {step:'FOLLOW_CURRENT_PROFILE_LINK',state:'UNKNOWN',retry:false};
 if(stage==='ROOM_VERIFIED'&&result==='LIVE')
  return {step:'RECORD_LIVE_OBSERVATION',state:'LIVE',retry:false};
 if(stage==='ROOM_VERIFIED'&&result==='OFFLINE')
  return {step:'STOP_UNVALIDATED_OFFLINE_RULE',state:'UNKNOWN',retry:false};
 return {step:'STOP_INSUFFICIENT_EVIDENCE',state:'UNKNOWN',retry:false};
}
