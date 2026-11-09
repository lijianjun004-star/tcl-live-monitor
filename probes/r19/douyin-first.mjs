/** R1.9: pure roster planning and cautious live-badge parsing. No network I/O. */
import {createCheck} from '../r18/core/scheduler.mjs';
const SEGS=new Set(['TCL_MAIN','TCL_AIR','TCL_TV','TCL_LOCAL_LIFE','FFALCON_TV','FFALCON_MONITORS','RAYNEO_AR_SEPARATE','THIRD_PARTY_DEALER']);
const SEC=/^MS4wLjABAAAA[A-Za-z0-9_-]{20,}$/;
const ROUTE=/^[1-9][0-9]{7,17}$/, ROOM=/^[1-9][0-9]{15,22}$/;
const DENY=/验证码|安全验证|滑块验证|captcha|unusual traffic|请先登录|登录后观看|扫码登录|访问过于频繁|异常流量/i;
const SKIP=new Set(['RAYNEO_AR_SEPARATE','THIRD_PARTY_DEALER']);

export function validateRegistry(registry){
 if(registry?.schema_version!==19||!Array.isArray(registry.targets))throw Error('INVALID_R19_REGISTRY');
 const sec=new Set(),keys=new Set(),ids=new Set();
 for(const t of registry.targets){
  if(!t?.key||keys.has(t.key))throw Error('DUPLICATE_OR_MISSING_KEY');
  if(!SEC.test(t.sec_uid)||sec.has(t.sec_uid))throw Error('DUPLICATE_OR_INVALID_SEC_UID');
  if(!t.display_douyin_id||ids.has(t.display_douyin_id))throw Error('DUPLICATE_OR_MISSING_DOUYIN_ID');
  if(t.profile_url!=='https://www.douyin.com/user/'+t.sec_uid)throw Error('BAD_PROFILE_URL');
  if(!SEGS.has(t.business_segment)||t.score_eligible!==false||t.monitored_only!==true)throw Error('INVALID_SCOPE');
  if(!t.evidence||!['PROFILE_LIVE_BADGE','NO_LIVE_BADGE','NOT_CHECKED_THIS_ROUND'].includes(t.evidence.kind))throw Error('BAD_EVIDENCE_KIND');
  if(t.evidence.kind==='PROFILE_LIVE_BADGE'){
   if(!ROUTE.test(t.evidence.live_route_id)||!ROOM.test(t.evidence.webcast_room_id)||!t.evidence.run_url?.startsWith('https://agent.tinyfish.ai/runs/'))throw Error('BAD_LIVE_BADGE_EVIDENCE');
  }else if(t.evidence.live_route_id||t.evidence.webcast_room_id)throw Error('UNATTESTED_ROOM_IN_CURRENT_EVIDENCE');
  if(t.evidence.room_page_second_verification!==false)throw Error('WRONG_ROOM_VERIFICATION');
  sec.add(t.sec_uid);keys.add(t.key);ids.add(t.display_douyin_id);
 }
 return {total:registry.targets.length,distinct_sec_uid:sec.size,
  live_badges:registry.targets.filter(t=>t.evidence.kind==='PROFILE_LIVE_BADGE').length};
}
export function firstPartyTargets(registry,{includeAdjacentBusinesses=false}={}){
 validateRegistry(registry);
 return registry.targets.filter(t=>includeAdjacentBusinesses||!SKIP.has(t.business_segment));
}
export function planHourlyDouyinChecks(registry,at,{includeAdjacentBusinesses=false}={}){
 return firstPartyTargets(registry,{includeAdjacentBusinesses}).map(t=>({
  ...createCheck({platform:'douyin',account_id:t.display_douyin_id,mode:'hourly',planned_check_at:at,actual_check_at:at}),
  account_key:t.key,profile_url:t.profile_url,business_segment:t.business_segment
 }));
}
export function planManualDouyinCheck(target,at,requestId){
 if(!target||!SEC.test(target.sec_uid))throw Error('INVALID_TARGET');
 return {...createCheck({platform:'douyin',account_id:target.display_douyin_id,mode:'manual',actual_check_at:at,request_id:requestId}),
  account_key:target.key,profile_url:target.profile_url};
}
function identityMatches(s,t){
 const title=String(s.title||'').trim(),text=String(s.body_excerpt||'');
 const profile=String(s.profile_url||'').split('?')[0];
 if(profile!==t.profile_url||!title.includes(t.account_name))return false;
 const id=String(t.display_douyin_id);
 const escaped=id.replace(/[-./\\^$*+?()[\]{}|]/g,'\\$&');
 return new RegExp('抖音号\\s*[:：]\\s*'+escaped+'(?![\\w.-])').test(text)||s.display_douyin_id===id;
}
/* A profile live badge is not full room-page validation. Old badge snapshots
 * must never be treated as current status without a new visit.
 */
export function classifyFreshProfileCapture(s,t,{now=new Date().toISOString(),max_age_ms=600000}={}){
 let observed=null;
 try{if(s?.observed_at)observed=new Date(s.observed_at).toISOString();}catch{}
 const blank={account_key:t?.key??null,profile_url:t?.profile_url??null,
  actual_observed_at:observed,normalized_state:'UNKNOWN',source_attested:false,
  live_badge_observed:false,live_route_id:null,webcast_room_id:null,
  reason:'NO_VALID_TARGET_EVIDENCE',room_page_second_verification:false};
 if(!observed||!t||!s)return {...blank,reason:'INVALID_CAPTURE_TIME'};
 const nowMs=Date.parse(now),age=nowMs-Date.parse(observed);
 if(!Number.isFinite(nowMs)||!Number.isFinite(age)||age>max_age_ms||age < -60000)return {...blank,reason:'STALE_OR_FUTURE_PROFILE_CAPTURE'};
 if(DENY.test(String(s.title||'')+' '+String(s.body_excerpt||'')))return {...blank,reason:'ACCESS_OR_AUTH_BLOCKED'};
 if(!identityMatches(s,t))return {...blank,reason:'ACCOUNT_IDENTITY_MISMATCH'};
 const links=(Array.isArray(s.live_anchors)?s.live_anchors:[]).filter(a=>String(a.text||'').includes('直播中'));
 const candidates=[];
 for(const a of links){
  const m=/^https:\/\/live\.douyin\.com\/([1-9]\d{7,17})(?:\?([^#]*))?$/.exec(String(a.href||''));
  if(!m)continue;
  const r=/(?:^|&)room_id=([1-9]\d{15,22})(?:&|$)/.exec(m[2]||'');
  if(r)candidates.push({live_route_id:m[1],webcast_room_id:r[1]});
 }
 if(!candidates.length)return {...blank,reason:'NO_VERIFIED_PROFILE_LIVE_BADGE'};
 const distinct=new Set(candidates.map(x=>x.live_route_id+'|'+x.webcast_room_id));
 if(distinct.size!==1)return {...blank,reason:'CONFLICTING_LIVE_BADGE_LINKS'};
 return {...blank,...candidates[0],live_badge_observed:true,
  reason:'PROFILE_LIVE_BADGE_OBSERVED_ROOM_SECOND_CHECK_PENDING'};
}
