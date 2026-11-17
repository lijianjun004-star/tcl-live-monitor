/**
 * JD mobile App share-link intake — offline, strict provenance, no redirects.
 * Raw share texts / URLs and query strings MUST NOT be committed to GitHub.
 * No share URL (including an official JD URL) proves a LIVE session by itself.
 */
const jdHost=h=>h==='jd.com'||h.endsWith('.jd.com')||h==='jd.hk'||h.endsWith('.jd.hk')||h==='3.cn'||h.endsWith('.3.cn');
const externalShort=new Set(['t.cn']);
const knownNonLiveHost=new Set(['mall.jd.com','item.jd.com','search.jd.com','www.jd.com']);
const sensitive=/^(?:token|access_token|auth|authorization|cookie|session|sessionid|ticket|sign|signature|pwd|password|sk|apikey|api_key|secret)$/i;
const hrefs=/https?:\/\/[^\s"'<>，。！？；、）)】]+/giu;

function parseVisibleJdLiveHash(u){
 if(u.hostname.toLowerCase()!=='lives.jd.com')return null;
 const m=/^#\/([1-9][0-9]{3,15})(?:\?([^#]*))?$/.exec(u.hash);
 if(!m)return null;
 const qp=new URLSearchParams(m[2]||'');
 const keys=[...qp.keys()];
 if(keys.some(k=>sensitive.test(k)))return {error:'SECRET_BEARING_URL_REJECTED'};
 const suppliedId=qp.get('id');
 if(suppliedId!==null&&suppliedId!==m[1])return {error:'LIVE_ROUTE_QUERY_ID_CONFLICT'};
 return {route_id:m[1],source:'VISIBLE_JD_LIVE_URL_FRAGMENT_ONLY'};
}

export function classifyJdShareLink(raw){
 if(typeof raw!=='string'||raw.length===0||raw.length>4096)throw Error('INVALID_SHARE_URL_INPUT');
 let u;
 try{u=new URL(raw);}catch{return{result:'INVALID_URL',verified:false};}
 if(u.username||u.password)return{result:'URL_WITH_CREDENTIALS_REJECTED',verified:false};
 if(!['http:','https:'].includes(u.protocol))return{result:'UNSAFE_PROTOCOL',verified:false};
 const host=u.hostname.toLowerCase();
 // No raw query values, fragments or credentials ever leave this parser.
 const queryKeys=[...new Set([...u.searchParams.keys()].map(k=>k.toLowerCase()))].sort();
 if(queryKeys.some(k=>sensitive.test(k)))return{
  result:'SECRET_BEARING_URL_REJECTED',verified:false,
  hostname:host,query_key_count:queryKeys.length
 };
 const route=parseVisibleJdLiveHash(u);
 if(route?.error)return {result:route.error,verified:false,hostname:host};
 const isJd=jdHost(host);
 const short=externalShort.has(host);
 const entryType=route?.route_id?'JD_LIVE_ROUTE_CANDIDATE_UNVERIFIED':!isJd?(short?'EXTERNAL_SHORTLINK_UNRESOLVED':'NON_JD_DOMAIN') :
  knownNonLiveHost.has(host)?'JD_NON_LIVE_PAGE_UNVERIFIED':
  'JD_DOMAIN_PAGE_TYPE_UNVERIFIED';
 const canOpenInAuthorizedBrowser=(isJd||short)&&u.protocol==='https:';
 return{
  result:entryType,verified:false,
  hostname:host, safe_origin:u.origin,
  path_omitted:true,path_segment_count:u.pathname.split('/').filter(Boolean).length,
  jd_live_url_route_id_candidate:route?.route_id??null,
  route_candidate_source:route?.source??null,
  current_room_id_verified:false,
  has_query:u.search.length>0,query_key_count:queryKeys.length,
  sensitive_query_values_removed:true,fragment_removed:true,
  can_open_in_authorized_browser:canOpenInAuthorizedBrowser,
  page_identity_verified:false,room_identity_verified:false,
  ops_room_id:null,ops_shop_id:null,
  public_jd_account_id:null,live_session_id:null,
  current_live_state:'UNKNOWN',
  safe_follow_up:isJd?'OPEN_VISIBLE_PAGE_ONCE_AND_VERIFY_ANCHOR_IDENTITY':
   short?'RESOLVE_ONLY_WITH_NORMAL_USER_BROWSER_NO_AUTO_FOLLOW':
   'REJECT_AND_LOOKUP_OFFICIAL_STORE'
 };
}

export function intakeJdAppShareText(text){
 if(typeof text!=='string'||text.length===0||text.length>12000)throw Error('INVALID_SHARE_TEXT');
 const matches=[...text.matchAll(hrefs)].map(m=>m[0]).slice(0,20);
 const seen=new Set(),links=[];
 for(const raw of matches){
  // Only use raw URL internally; never include it in the returned object.
  const o=classifyJdShareLink(raw);
  const id=raw;
  if(!seen.has(id)){seen.add(id);links.push(o);}
 }
 return{
  schema_version:20,origin:'JD_MOBILE_APP_USER_SHARED_TEXT',
  raw_text_retained:false,raw_link_retained:false,network_requests:0,
  redirects_followed:0,login_attempts:0,
  account_to_ops_mapping_proven:false,observed_current_live:false,
  opening_rate_contribution:null,
  urls_detected:matches.length,candidates:links
 };
}
