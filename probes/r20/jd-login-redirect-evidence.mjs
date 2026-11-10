/**
 * Offline review of the visible login redirect after a NORMAL JD public link.
 * The redirect can attest a JD liveId LINK CANDIDATE, not room identity or LIVE.
 * Never touches cookies, authentication, network, or login query parameters.
 */
import {parseJdConsumerLink} from './jd-share-intake.mjs';
export function classifyJdLoginRedirect({final_url,source_url}={}){
 const rejected={schema_version:20,platform:'jd',
  classification:'UNKNOWN_LOGIN_OR_NON_JD_DESTINATION',source_url:null,
  original_source_provenance_verified:false,login_required:false,
  historical_live_id_candidate:null,verified_public_anchor_id:null,
  current_live_state:'UNKNOWN',identity_verified:false,
  ops_room_binding_verified:false,opening_rate_eligible:false};
 let login;
 try{login=new URL(final_url);}catch{return {...rejected,reason:'NO_VALID_FINAL_URL'};}
 if(login.protocol!=='https:'||login.hostname!=='plogin.m.jd.com'||
  login.pathname!=='/login/login'||login.username||login.password)
  return {...rejected,reason:'NOT_JD_LOGIN_REDIRECT'};
 const back=login.searchParams.getAll('returnurl');
 if(back.length!==1)return {...rejected,reason:'MISSING_OR_MULTIPLE_RETURNURL'};
 let target;
 try{target=parseJdConsumerLink(back[0]);}catch{return {...rejected,login_required:true,reason:'RETURNURL_NOT_APPROVED_JD_LIVE_URL'};}
 if(target.kind!=='DYNAMIC_JD_LIVE_SESSION_ONLY')
  return {...rejected,login_required:true,reason:'RETURNURL_NOT_JD_LIVE_SESSION'};
 // Restrict original source to known public user-share URLs; does not prove attribution.
 let cleanSource=null;
 try{
  const u=new URL(source_url);
  if(u.protocol==='https:'&&u.hostname==='t.cn'&&/^\/[A-Za-z0-9_-]{5,30}$/.test(u.pathname)
     &&!u.search&&!u.hash)cleanSource=u.origin+u.pathname;
 }catch{}
 return {...rejected,classification:'JD_HISTORICAL_SESSION_FROM_AUTH_REDIRECT',
  source_url:cleanSource,login_required:true,
  historical_live_id_candidate:target.dynamic_live_id,
  sanitized_jd_live_url:target.clean_url,
  reason:'LOGIN_REDIRECT_EXPOSED_SESSION_LINK_NOT_ACCOUNT_IDENTITY'};
}
