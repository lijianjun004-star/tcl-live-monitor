/**
 * R2.0 — JD consumer live share link intake (offline, no redirects followed).
 * JD store URL, seller venderId, internal ops roomId, stable anchor profile,
 * and dynamic liveId are distinct identity layers.
 */
const ID=/^[1-9][0-9]{4,19}$/;
const SHORT=/^\/[A-Za-z0-9_-]{4,48}\/?$/;
const ALLOWED=new Set(['3.cn','zhibo.jd.com','lives.jd.com','mall.jd.com',
  'm.jd.com','pro.m.jd.com','item.m.jd.com','jd.com','www.jd.com']);
function assertAllowedURL(value){
 let u;
 try{u=new URL(value);}catch{throw Error('INVALID_URL');}
 if(u.protocol!=='https:'||!ALLOWED.has(u.hostname.toLowerCase())||u.username||u.password||u.port)
  throw Error('NOT_HTTPS_ALLOWED_JD_HOST');
 if(u.href.length>4096)throw Error('URL_TOO_LONG');
 return u;
}
export function parseJdConsumerLink(raw){
 if(typeof raw!=='string'||raw.length>5000)throw Error('INVALID_INPUT');
 const input=raw.trim();
 // Clipboard can contain a JD marketing sentence; only use exactly one HTTPS URL.
 const found=input.match(/https:\/\/[^\s<>，。；、"'“”‘’]+/g)||[];
 if(found.length!==1)throw Error('EXPECTED_EXACTLY_ONE_HTTPS_LINK');
 const u=assertAllowedURL(found[0]);
 const hostname=u.hostname.toLowerCase(),path=u.pathname;
 const base={platform:'jd',raw_url_was_not_preserved:true,host:hostname,kind:'UNCLASSIFIED_JD_LINK',
  clean_url:null,stable_anchor_id:null,dynamic_live_id:null,public_jd_account_id:null,
  internal_ops_room_id:null,state:'UNKNOWN',identity_verified:false,live_verified:false,
  can_promote_crosswalk:false,can_update_opening_rate:false,
  next_action:'REVIEW_VISIBLE_PAGE_AND_RECORD_SHOP_PROFILE_LINK'};
 if(hostname==='3.cn'){
  if(!SHORT.test(path)||u.search||u.hash)throw Error('INVALID_JD_SHORTLINK');
  return {...base,kind:'JD_APP_SHARE_SHORTLINK_UNRESOLVED',
   clean_url:'https://3.cn'+path,
   next_action:'OPEN_ONCE_IN_NORMAL_BROWSER_VERIFY_FINAL_JD_HOST_AND_ANCHOR_IDENTITY'};
 }
 if(hostname==='zhibo.jd.com'&&path==='/liveroom'){
  const id=u.searchParams.getAll('liveId');
  if(id.length!==1||!ID.test(id[0]))throw Error('INVALID_JD_LIVE_ID');
  return {...base,kind:'DYNAMIC_JD_LIVE_SESSION_ONLY',dynamic_live_id:id[0],
   clean_url:'https://zhibo.jd.com/liveroom?liveId='+id[0],
   next_action:'VERIFY_ROOM_PUBLIC_PAGE_AND_FIND_STABLE_ANCHOR_PROFILE'};
 }
 if(hostname==='lives.jd.com'){
  const match=/^\/([1-9][0-9]{4,19})(?:\/(?:live|notice|closed|replay))?\/?$/.exec(u.hash.slice(1));
  if(path!=='/'||!match)throw Error('UNKNOWN_JD_LIVES_LINK_FORMAT');
  return {...base,kind:'DYNAMIC_JD_LIVE_SESSION_ONLY',dynamic_live_id:match[1],
   clean_url:'https://lives.jd.com/#/'+match[1],
   next_action:'VERIFY_ROOM_PUBLIC_PAGE_AND_FIND_STABLE_ANCHOR_PROFILE'};
 }
 if(hostname==='mall.jd.com'){
  return {...base,kind:'JD_STORE_PAGE_NOT_LIVE',clean_url:u.origin+u.pathname,
   next_action:'DO_NOT_INFER_OFFLINE_OR_PUBLIC_LIVE_ACCOUNT_FROM_STORE_PAGE'};
 }
 return {...base,kind:'JD_MOBILE_OR_SITE_LINK_NEEDS_INSPECTION',
  clean_url:u.origin+u.pathname,
  next_action:'READ_VISIBLE_PAGE_TO_CLASSIFY;DO_NOT_ASSUME_LIVE'};
}
/**
 * Review evidence must combine an ordinary visible share-page account with
 * an independently verified ops room mapping; a public venderId alone is NOT
 * an anchor profile identity.
 */
export function reviewJdLinkIdentity(candidate,evidence){
 if(candidate?.platform!=='jd'||candidate.identity_verified||candidate.live_verified)
  throw Error('INVALID_CANDIDATE');
 const fail={status:'PENDING',public_jd_account_id:null,ops_room_id:null,
  live_id:candidate.dynamic_live_id||null,ready_for_opening_rate:false};
 if(!evidence)return {...fail,reason:'NO_INDEPENDENT_IDENTITY_EVIDENCE'};
 const stable=String(evidence.anchor_profile_url||'');
 const internal=String(evidence.ops_crosswalk_evidence_url||'');
 if(!stable||!internal||!evidence.account_name||
  !evidence.public_account_id||!evidence.ops_room_id)
  return {...fail,reason:'INCOMPLETE_TWO_SIDED_IDENTITY'};
 // Two explicitly independent, human reviewed evidence sources are mandatory.
 try{
  const a=assertAllowedURL(stable);
  const b=new URL(internal);
  if(b.protocol!=='https:'||a.hostname==='mall.jd.com'||!b.hostname)
   return {...fail,reason:'UNTRUSTED_IDENTITY_PROVENANCE'};
 }catch{return {...fail,reason:'INVALID_IDENTITY_PROVENANCE'};}
 if(evidence.independently_reviewed!==true)
  return {...fail,reason:'PENDING_MANUAL_CROSSWALK_REVIEW'};
 return {
  status:'EVIDENCE_SUBMITTED_REQUIRES_REAL_SOURCE_CHECK',
  public_jd_account_id:String(evidence.public_account_id),
  ops_room_id:String(evidence.ops_room_id),
  live_id:candidate.dynamic_live_id||null,
  ready_for_opening_rate:false,
  reason:'NEEDS_REAL_IDENTITY_VERIFICATION_AND_SCHEDULE_LINK'
 };
}
