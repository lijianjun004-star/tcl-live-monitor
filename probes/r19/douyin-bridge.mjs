/** Pure two-page corroboration: badge evidence alone cannot become LIVE. */
import {classifyFreshProfileCapture} from './douyin-first.mjs';
const BLOCK=/(验证码|安全验证|滑块|captcha|登录后观看|扫码登录|请先登录|直播已结束|直播已经结束|直播结束|主播已下播|暂未开播|主播暂未开播|访问过于频繁|异常流量)/i;
const ROOMID=/^[1-9][0-9]{15,22}$/;
function sameUrl(url,route,roomid){
 try{
  const u=new URL(url);
  return u.protocol==='https:'&&u.hostname==='live.douyin.com'&&u.pathname==='/'+route&&
     u.searchParams.get('room_id')===roomid;
 }catch{return false;}
}
/**
 * Douyin can canonicalize a normal room link by removing its room_id query.
 * Accept only an explicitly captured navigation URL matching the profile's
 * fresh live link, plus a final URL on the exact same live.douyin.com route.
 * Never accept a redirect to an unrelated site, room or different room_id.
 */
function roomNavigationMatches(room,route,roomid){
 if(!room.requested_url) return sameUrl(room.url,route,roomid);
 if(!sameUrl(room.requested_url,route,roomid)) return false;
 try{
  const u=new URL(room.url);
  return u.protocol==='https:'&&u.hostname==='live.douyin.com'&&
    u.pathname==='/'+route&&
    (!u.searchParams.has('room_id')||u.searchParams.get('room_id')===roomid);
 }catch{return false;}
}
export function corroborateDouyin(profile,room,target,{now=new Date().toISOString()}={}){
 const a=classifyFreshProfileCapture(profile,target,{now});
 const blank={account_key:target.key,account_id:target.display_douyin_id,
  state:'UNKNOWN',source_attested:false,live_id:null,room_id:a.live_route_id,
  dynamic_room_id:a.webcast_room_id,room_page_second_verification:false,
  observed_at:a.actual_observed_at,reason:a.reason,profile_badge:a.live_badge_observed};
 if(!a.live_badge_observed)return blank;
 if(!room)return {...blank,reason:'ROOM_PAGE_NOT_VISITED'};
 if(room.error_code||room.httpStatus!==200)return {...blank,reason:room.error_code||'ROOM_PAGE_HTTP_FAILURE'};
 const rtext=String(room.title||'')+' '+String(room.bodyExcerpt||'')+' '+String(room.metaDescription||'');
 if(BLOCK.test(rtext))return {...blank,reason:'ROOM_ACCESS_OR_ENDED'};
 if(!ROOMID.test(a.webcast_room_id||''))return {...blank,reason:'INVALID_DYNAMIC_ROOM_ID'};
 if(!roomNavigationMatches(room,a.live_route_id,a.webcast_room_id))return {...blank,reason:'ROOM_LINK_MISMATCH'};
 if(room.title!==target.account_name+'的抖音直播间 - 抖音直播')return {...blank,reason:'ROOM_TITLE_IDENTITY_MISMATCH'};
 if(!String(room.metaDescription||'').startsWith('欢迎来到'+target.account_name+'的抖音直播间'))return {...blank,reason:'ROOM_META_IDENTITY_MISMATCH'};
 if(room.videoVisible!==true&&room.liveBadgeVisible!==true)return {...blank,reason:'ROOM_LIVE_UI_SIGNAL_MISSING'};
 let seen=NaN;
 try{seen=Date.parse(room.observed_at);}catch{}
 const n=Date.parse(now);
 if(!Number.isFinite(seen)||!Number.isFinite(n)||n-seen>600000||seen-n>60000)return {...blank,reason:'ROOM_EVIDENCE_STALE'};
 return {...blank,state:'LIVE',source_attested:true,live_id:a.webcast_room_id,
  room_page_second_verification:true,observed_at:new Date(seen).toISOString(),
  dynamic_room_id_source:'FRESH_PROFILE_BADGE_LINK',current_room_payload_attested:false,
  reason:'LIVE_BADGE_AND_ROOM_PAGE_MATCH'};
}
