/** R3.9 public DOM signal normalizer - no network calls or raw HTML serialization. */
const LIVE_LABEL=/(?:直播中|正在直播|开播中)/u;
const NUMBER=/^\d{5,24}$/;
const MAX=10000;
const COUNTS=['totalAnchors','liveHostAnchorCount','liveLabeledAnchorCount','visibleLiveTextMentions','liveRelatedButtons','domTextLength','validNormalizedAnchors'];
const int=x=>Number.isSafeInteger(x)&&x>=0?Math.min(x,MAX):0;

/** Query/hash tracking parameters are discarded, never persisted as identity. */
export function canonicalPublicLiveAnchor(candidate){
  if(!candidate||typeof candidate!=='object')return null;
  let u;try{u=new URL(candidate.href)}catch{return null}
  if(u.protocol!=='https:'||u.hostname!=='live.douyin.com'||u.port||u.username||u.password)return null;
  const match=/^\/(\d{5,24})\/?$/.exec(u.pathname);
  if(!match||!NUMBER.test(match[1]))return null;
  const evidence=[candidate.text,candidate.ariaLabel,candidate.title,candidate.childLabel]
    .filter(x=>typeof x==='string').join(' ').slice(0,256);
  if(!LIVE_LABEL.test(evidence))return null;
  return {href:'https://live.douyin.com/'+match[1],text:'直播中'};
}
export function normalizedPublicLiveAnchors(candidates){
  const seen=new Set(),out=[];
  if(!Array.isArray(candidates))return out;
  for(const item of candidates.slice(0,200)){
    const result=canonicalPublicLiveAnchor(item);
    if(!result||seen.has(result.href))continue;
    seen.add(result.href);out.push(result);
    if(out.length===10)break;
  }
  return out;
}
/** Whitelisted numerical counters only. Never include page title/body, href or identifiers. */
export function safePublicDomDiagnostics(raw, normalizedCount=0, delayed=false){
  const obj={};
  for(const key of COUNTS)obj[key]=key==='validNormalizedAnchors'?int(normalizedCount):int(raw?.[key]);
  obj.delayedDomResample=delayed===true;
  return obj;
}
export function identifyDomGap(metrics){
  if(metrics?.validNormalizedAnchors>0)return 'LIVE_ANCHOR_CANDIDATE_NEEDS_ROOM_CROSSCHECK';
  if(metrics?.liveHostAnchorCount>0&&metrics?.liveLabeledAnchorCount===0)return 'ROOM_LINK_WITHOUT_EXPLICIT_LIVE_LABEL';
  if(metrics?.visibleLiveTextMentions>0&&metrics?.liveHostAnchorCount===0)return 'VISIBLE_LIVE_LABEL_WITHOUT_ROOM_HREF';
  if(metrics?.totalAnchors===0||metrics?.domTextLength===0)return 'PUBLIC_DOM_NOT_READY_OR_EMPTY';
  return 'NO_PUBLIC_LIVE_LINK_EVIDENCE';
}
