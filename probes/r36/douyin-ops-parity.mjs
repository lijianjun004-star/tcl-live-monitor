/**
 * R3.6 | TCL OPS Douyin read-only source adapter.
 * Built from EXISTING repository-source contracts, NOT reverse-engineered
 * from the inaccessible 101.96.215.251 dashboard.
 * 
 * Distinguish internal room id, shop id, public Douyin secUid, and live room id.
 * No inferred identity joins, no OFFLINE, no formal KPI.
 */
import { classifyTclOps, liveMinutesDelta, trackSessionGap } from '../lib/tcl-ops.mjs';
import { SOURCE_ROUTES, beijingDate, extractArray } from '../lib/tcl-jd-all.mjs';

const PLATFORMS = new Set(['dy','douyin','抖音']);
const CAT = new Set(['电视','空调','冰箱','洗衣机','显示器','全品类','本地生活','智能门锁','雷鸟电视','雷鸟显示器','其他']);
const id = v => /^[0-9]{1,16}$/.test(String(v??'')) ? String(v) : null;
const dt = v => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null;
export const isDouyin = v => PLATFORMS.has(String(v??'').trim().toLowerCase());
const sourcePlatform = v => isDouyin(v) ? String(v).trim().toLowerCase() : null;
const safeCategory = s => CAT.has(String(s??'')) ? String(s) : '未核实';
const array = (doc, paths, kind) => extractArray(doc,paths,kind);

function paging(body, len) {
  const declared = body?.total ?? body?.total_count ?? body?.pagination?.total ?? body?.data?.total ?? body?.data?.pagination?.total;
  const total = declared==null ? null : Number(declared);
  if(total!==null && (!Number.isSafeInteger(total) || total<0 || total!==len)) return {complete:false,reason:'PAGINATION_OR_TOTAL_MISMATCH'};
  const hasMore = [body?.has_more,body?.hasMore,body?.pagination?.has_more,body?.data?.has_more].some(x=>x===true);
  const cursor = [body?.next,body?.next_cursor,body?.nextCursor,body?.pagination?.next,body?.data?.next_cursor].some(x=>x!==undefined&&x!==null&&x!==''&&x!==false);
  const offset = Number(body?.offset ?? body?.pagination?.offset ?? 0);
  return {complete:total!==null&&!hasMore&&!cursor&&offset===0,reason:total===null?'TOTAL_NOT_DECLARED':hasMore||cursor||offset>0?'PAGINATION_DETECTED':null};
}

/** The source room list is a candidate catalog, not a verified full census. */
export function inspectDouyinCatalog(payload, max=80) {
  const items=array(payload,[['rooms'],['data','rooms'],['data','list'],['list']],'ROOMS');
  if(items.length>1000)throw Error('SOURCE_ROOM_CATALOG_TOO_LARGE');
  const count=paging(payload,items.length);
  const seen=new Set(), rooms=[],warnings=[], aliases=new Set();
  for(const item of items) {
    const platform=sourcePlatform(item?.platform);
    if(!platform)continue;
    aliases.add(platform);
    const roomId=id(item?.id??item?.live_room_id??item?.room_id);
    const shopId=id(item?.shop_id??item?.shopId??item?.shop?.id);
    if(!roomId){warnings.push('DOUYIN_SOURCE_ROOM_ID_INVALID');continue}
    if(seen.has(roomId)){warnings.push('DOUYIN_SOURCE_ROOM_DUPLICATE');continue}
    seen.add(roomId);
    rooms.push({
      roomId, shopId, platform, category:safeCategory(item?.category),
      captureBound:Boolean(item?.bound_session_key), // never serialize the key itself
    });
  }
  if(rooms.length>max)throw Error('DOUYIN_ROOM_LIMIT_EXCEEDED');
  rooms.sort((a,b)=>a.roomId.localeCompare(b.roomId,'en',{numeric:true}));
  return {
    rooms, aliases:[...aliases].sort(), warnings,
    catalogComplete:count.complete&&warnings.length===0,
    catalogReason:count.reason ?? (warnings.length?'INTEGRITY_WARNINGS':null),
    sourceReportedItems:items.length,
  };
}

/** Avoid treating a shop number or internal capture room id as a Douyin live-room ID. */
export function inspectDouyinShops(payload) {
  const items=array(payload,[[],['shops'],['data','shops'],['data','list'],['list']],'SHOPS');
  const seen=new Set(),shops=[];
  for(const item of items) {
    const platform=sourcePlatform(item?.platform),shopId=id(item?.id??item?.shop_id??item?.shopId);
    if(!platform||!shopId)continue;
    if(seen.has(shopId))throw Error('DOUYIN_SHOP_DUPLICATE');
    seen.add(shopId);shops.push({shopId,platform});
  }
  return shops;
}

export function inspectDouyinHeartbeat(payload) {
  const items=array(payload,[['rooms'],['data','rooms'],['data','list'],['list']],'HEARTBEATS');
  const map=new Map();
  for(const item of items) {
    // Require explicit platform to avoid collisions with JD numeric room IDs.
    if(!isDouyin(item?.platform))continue;
    const roomId=id(item?.id??item?.live_room_id??item?.room_id);
    if(!roomId)continue;
    const iso=typeof item?.last_heartbeat_at==='string'?item.last_heartbeat_at:null;
    if(map.has(roomId)&&map.get(roomId)!==iso)throw Error('DOUYIN_HEARTBEAT_DUPLICATE_CONFLICT');
    map.set(roomId,iso);
  }
  return map;
}

export function evaluateDouyinRoom({room,day,heartbeatAt=null,heartbeatAvailable=true,date,at,previous=null}) {
  const base={
    roomId:room.roomId,shopId:room.shopId,category:room.category,
    platform:room.platform,captureBound:room.captureBound,
    status:'UNKNOWN',reason:'UNVERIFIED',offlineCandidate:false,
    statusSource:'TCL_OPS_INTERNAL_UNVERIFIED_AGAINST_DOUYIN_PUBLIC',
    minuteCount:null,minutesDelta:null,sessionCount:null,heartbeatAlive:false,
    exactStartAt:null,exactEndAt:null,publicAccountMatched:false,
  };
  if(date!==beijingDate(new Date(at)))return {...base,reason:'HISTORICAL_DATE_CANNOT_PROVE_CURRENT_STATUS'};
  if(!heartbeatAvailable)return {...base,reason:'HEARTBEAT_API_UNAVAILABLE'};
  if(!room.captureBound)return {...base,reason:'CAPTURE_UNBOUND'};
  if(!day || typeof day!=='object')return {...base,reason:'NO_DAY_EVIDENCE'};
  const validCount=Number.isInteger(day.minute_count)&&day.minute_count>=0?day.minute_count:null;
  if(validCount===null)return {...base,reason:'MINUTE_COUNT_INVALID'};
  const verdict=classifyTclOps({day:{...day,minute_count:validCount},heartbeatAt,now:at,offlineRuleValidated:false});
  const status=verdict.state==='LIVE' && verdict.agentAlive?'LIVE':'UNKNOWN';
  const reason=verdict.state==='LIVE'&&!verdict.agentAlive?'CAPTURE_AGENT_NOT_VERIFIED':verdict.reason;
  const comparable=previous?.roomId===room.roomId&&previous?.date===date&&Number.isSafeInteger(previous?.at)&&previous.at<at;
  const delta=comparable?liveMinutesDelta(previous?.minuteCount,validCount):null;
  return {
    ...base,status,reason,offlineCandidate:Boolean(verdict.offlineCandidate),
    heartbeatAlive:Boolean(verdict.agentAlive),minuteCount:validCount,minutesDelta:delta,
    sessionCount:Number.isInteger(day.session_count)&&day.session_count>=0?day.session_count:null,
  };
}

export function douyinRegistrySummary(config) {
  const list=config?.douyin;
  if(!Array.isArray(list))throw Error('APPROVED_DOUYIN_REGISTRY_MISSING');
  const keys=new Set(),sec=new Set(),ids=new Set();
  let approvedScoring=0;
  for(const item of list) {
    if(item?.scopeApproved!==true || !item.key || !item.profileUrl || !item.displayDouyinId)throw Error('DOUYIN_REGISTRY_TARGET_NOT_APPROVED');
    const profile=new URL(item.profileUrl);
    if(profile.protocol!=='https:'||profile.hostname!=='www.douyin.com'||!/^\/user\/MS4wLjABAAAA[\w-]{20,}$/.test(profile.pathname))throw Error('DOUYIN_REGISTRY_URL_INVALID');
    if(keys.has(item.key)||sec.has(profile.pathname)||ids.has(item.displayDouyinId))throw Error('DOUYIN_REGISTRY_DUPLICATE');
    keys.add(item.key);sec.add(profile.pathname);ids.add(item.displayDouyinId);
    if(item.scoringEligible===true)approvedScoring++;
  }
  // Source operator room id is not a public Douyin room id, even if both are numbers.
  return {approvedAccounts:list.length,approvedScoringAccounts:approvedScoring,
    publicIdentityLinkedToOpsRooms:false,scoringAllowedFromInternalSnapshot:false};
}

function correctRoomDay(doc,date) {
  const days=Array.isArray(doc?.days)?doc.days:Array.isArray(doc?.data?.days)?doc.data.days:null;
  if(!days)return null;
  return days.find(d=>d?.date===date)??null;
}
function simpleSummary(rooms) {
  return rooms.reduce((n,r)=>{n[r.status]=(n[r.status]||0)+1;return n},{LIVE:0,OFFLINE:0,UNKNOWN:0});
}

export async function scanDouyinOps({reader,config,at=Date.now(),maxRooms=60}) {
  if(typeof reader!=='function')throw Error('READONLY_READER_REQUIRED');
  if(!Number.isFinite(at)||at<=0)throw Error('INVALID_TIME');
  const date=beijingDate(new Date(at)), registry=douyinRegistrySummary(config);
  const report={
    schemaVersion:36,platform:'douyin',source:'TCL_OPS_APPROVED_READONLY_API',
    checkedAt:new Date(at).toISOString(),date,
    sourceAccess:'UNVERIFIED',catalogComplete:false, warnings:[],
    ...registry,rooms:[],summary:{LIVE:0,OFFLINE:0,UNKNOWN:0},
    formalOpeningRatePercent:null,formalFullDurationRatePercent:null,exhaustive:false,
  };
  let rooms;
  try {rooms=inspectDouyinCatalog(await reader(SOURCE_ROUTES.rooms),maxRooms);}
  catch(e){report.warnings.push('ROOMS_UNAVAILABLE_OR_INVALID');return report}
  report.sourceAccess='ROOM_CATALOG_RECEIVED';report.catalogComplete=rooms.catalogComplete;
  report.warnings.push(...rooms.warnings);
  if(rooms.catalogReason)report.warnings.push(rooms.catalogReason);
  report.sourceReportedItems=rooms.sourceReportedItems;
  report.platformAliasesObserved=rooms.aliases;
  if(!rooms.rooms.length)report.warnings.push('NO_DOUYIN_ROOMS_IN_RESPONSE_NOT_OFFLINE');
  const pair=await Promise.allSettled([reader(SOURCE_ROUTES.shops),reader(SOURCE_ROUTES.heartbeats)]);
  let shops=null,heartbeat=null;
  try{if(pair[0].status==='fulfilled')shops=inspectDouyinShops(pair[0].value)}catch{}
  try{if(pair[1].status==='fulfilled')heartbeat=inspectDouyinHeartbeat(pair[1].value)}catch{}
  if(!shops)report.warnings.push('DOUYIN_SHOPS_UNAVAILABLE');
  if(!heartbeat)report.warnings.push('DOUYIN_HEARTBEATS_UNAVAILABLE');
  const shopSet=new Set((shops||[]).map(s=>s.shopId));
  report.shopCount=shops?.length??null;
  report.rooms=[];
  for(const room of rooms.rooms) {
    let day=null,apiError=false;
    try {
      // Use the *observed source platform* verbatim, never guess jd/dy aliases.
      const doc=await reader(SOURCE_ROUTES.daily,{start_date:date,end_date:date,platform:room.platform,live_room_id:room.roomId});
      day=correctRoomDay(doc,date);
    } catch {apiError=true}
    const state=apiError
      ? {roomId:room.roomId,shopId:room.shopId,category:room.category,platform:room.platform,status:'UNKNOWN',reason:'DOUYIN_DAILY_API_ERROR',offlineCandidate:false,exactStartAt:null,exactEndAt:null,publicAccountMatched:false}
      : evaluateDouyinRoom({room,day,heartbeatAt:heartbeat?.get(room.roomId)??null,heartbeatAvailable:heartbeat!==null,date,at});
    report.rooms.push({
      ...state,
      opsShopIdentityMatched:shops!==null&&room.shopId!==null&&shopSet.has(room.shopId),
      // Ops identity joins are not equivalent to public Douyin account identity.
      publicDouyinRoomId:null,
    });
  }
  report.summary=simpleSummary(report.rooms);
  report.shopJoinCount=report.rooms.filter(x=>x.opsShopIdentityMatched).length;
  report.unresolvedOpsRoomShopCount=report.rooms.length-report.shopJoinCount;
  return report;
}

/** No raw response bodies or user data in serializable output. */
export function summarizeDouyinGap(prev,cur){
  if(!prev||!cur||!Number.isSafeInteger(cur.at))return {event:null};
  const r=trackSessionGap(prev,cur);
  return {event:r.event??null,calibratedOffline:false,
    exactDownTime:null,exactStartTime:null,next:r.next};
}
