// TCL 京东店铺与房间的只读自动发现器。仅查询现有、已授权的运营平台 GET API。
// 不保留主播姓名、成交额、session key、原始 body、Cookie 或 Token。
import { classifyTclOps, liveMinutesDelta } from './tcl-ops.mjs';

export const SOURCE_ROUTES = Object.freeze({
  shops: '/api/shops', rooms: '/api/capture/rooms',
  heartbeats: '/api/assistant/active-rooms', daily: '/api/capture/room-overview/daily',
});
const MAX_RESPONSE_BYTES = 1_000_000;
const JD = new Set(['jd', 'jingdong', '京东']);
export const EXPECTED_SOURCE_CATEGORY = Object.freeze({ '1': '冰箱', '14': '洗衣机', '15': '空调', '16': '全品类', '17': '电视', '18': '显示器' });
export const isJD = platform => JD.has(String(platform ?? '').trim().toLowerCase());
const safeId = value => { const s = String(value ?? '').trim(); return /^[0-9]{1,16}$/.test(s) ? s : null; };
export const beijingDate = instant => {
  const d = instant instanceof Date ? instant : new Date(instant);
  if (!Number.isFinite(d.getTime())) return 'INVALID_DATE';
  const parts = {};
  for (const p of new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d)) {
    if (p.type === 'year' || p.type === 'month' || p.type === 'day') parts[p.type] = p.value;
  }
  return `${parts.year}-${parts.month}-${parts.day}`;
};

export function extractArray(json, paths, label) {
  for (const path of paths) {
    const value = path.reduce((v, key) => v?.[key], json);
    if (Array.isArray(value)) return value;
  }
  throw new Error('SCHEMA_' + label + '_ARRAY_MISSING');
}

function declaredTotal(body) {
  const raw = body?.total ?? body?.total_count ?? body?.pagination?.total ?? body?.data?.total ?? body?.data?.pagination?.total;
  const total = Number(raw);
  return raw != null && Number.isInteger(total) && total >= 0 ? total : null;
}

/** All JD records from one response. Does not interpret a shop ID as a room ID. */
export function normalizeRoomList(body, maxRooms = 100) {
  const input = extractArray(body, [['rooms'], ['data', 'rooms'], ['data', 'list'], ['list']], 'ROOMS');
  const total = declaredTotal(body);
  // A truncated list is not a complete census. Do not silently declare zero or all rooms found.
  // A successful first page is not necessarily the complete catalog. Treat every
  // declared continuation as incomplete even when page length matches total.
  const hasMore = body?.has_more === true || body?.hasMore === true ||
    body?.pagination?.has_more === true || body?.pagination?.hasMore === true ||
    body?.data?.has_more === true || body?.data?.pagination?.has_more === true;
  const hasNext = [body?.next_cursor, body?.nextCursor, body?.next,
    body?.pagination?.next_cursor, body?.pagination?.nextCursor,
    body?.pagination?.next, body?.data?.next_cursor].some(v => v !== null && v !== undefined && v !== '' && v !== false);
  const offset = body?.offset ?? body?.pagination?.offset ?? body?.data?.offset;
  if (hasMore || hasNext || (offset !== undefined && Number(offset) > 0) || (total !== null && total > input.length))
    throw new Error('CATALOG_PAGINATED_OR_INCOMPLETE');
  if (total !== null && total < input.length) throw new Error('CATALOG_TOTAL_MISMATCH');
  const seen = new Set(), warnings = [], rooms = [];
  for (const item of input) {
    if (!isJD(item?.platform)) continue;
    const roomId = safeId(item?.id ?? item?.live_room_id ?? item?.room_id);
    if (!roomId) { warnings.push('JD_ROOM_ID_INVALID'); continue; }
    if (seen.has(roomId)) { warnings.push('JD_ROOM_DUPLICATE:' + roomId); continue; }
    seen.add(roomId);
    const shopId = safeId(item?.shop_id ?? item?.shopId ?? item?.shop?.id);
    const category = String(item?.category ?? '').slice(0, 60);
    const categoryMismatch = EXPECTED_SOURCE_CATEGORY[roomId] && category && category !== EXPECTED_SOURCE_CATEGORY[roomId];
    if (categoryMismatch) warnings.push(`CATEGORY_MAPPING_CONFLICT:${roomId}`);
    rooms.push({ roomId, shopId, category, captureBound: Boolean(item?.bound_session_key),
      categoryMappingConflict: Boolean(categoryMismatch) });
  }
  if (rooms.length > maxRooms) throw new Error('ROOM_LIMIT_EXCEEDED');
  rooms.sort((a,b) => a.roomId.localeCompare(b.roomId, 'en', {numeric:true}));
  return { rooms, warnings, reportedItems: input.length,
    catalogScope: total === null ? 'API_RESPONSE_NOT_PROVEN_EXHAUSTIVE' : 'API_DECLARED_COMPLETE',
    isUnambiguous: warnings.length === 0 };
}

export function normalizeShopList(body) {
  const input = extractArray(body, [['shops'], ['data', 'shops'], ['data', 'list'], ['list']], 'SHOPS');
  const result=[], seen=new Set();
  for (const item of input) {
    if (!isJD(item?.platform)) continue;
    const shopId=safeId(item?.id ?? item?.shop_id ?? item?.shopId);
    if (!shopId || seen.has(shopId)) continue;
    result.push({ shopId }); seen.add(shopId);
  }
  return result.sort((a,b)=>a.shopId.localeCompare(b.shopId,'en',{numeric:true}));
}

export function normalizeHeartbeats(body) {
  const input = extractArray(body, [['rooms'], ['data', 'rooms'], ['data', 'list'], ['list']], 'HEARTBEATS');
  const hb=new Map();
  for(const item of input) {
    // The capture service serves several platforms; a numeric room id alone
    // must not allow a Douyin agent to authenticate a JD room.
    if (item?.platform != null && !isJD(item.platform)) continue;
    const id=safeId(item?.id ?? item?.live_room_id ?? item?.room_id);
    if (!id) continue;
    const value=item.last_heartbeat_at ?? null;
    if (hb.has(id) && hb.get(id) !== value) throw new Error('HEARTBEAT_ROOM_DUPLICATE');
    hb.set(id,value);
  }
  return hb;
}

export function evaluateRoom({room, day, heartbeatAt, at, date, previous=null, heartbeatDataAvailable=true}) {
  const today=beijingDate(new Date(at));
  const base={roomId:room.roomId, shopId:room.shopId, category:room.category,
    captureBound:room.captureBound, categoryMappingConflict:room.categoryMappingConflict,
    date, status:'UNKNOWN', reason:'NO_VALID_EVIDENCE', offlineCandidate:false,
    minutesDelta:null, agentAlive:false};
  if(date!==today) return {...base, reason:'HISTORICAL_DAY_NOT_CURRENT_STATE'};
  if(!heartbeatDataAvailable) return {...base, reason:'HEARTBEAT_SOURCE_UNAVAILABLE'};
  if(!room.captureBound) return {...base, reason:'CAPTURE_UNBOUND'};
  if(!day || typeof day!=='object' || !Object.prototype.hasOwnProperty.call(day,'minute_count'))
    return {...base, reason:'DAILY_DATA_MISSING_OR_INVALID'};
  const count = Number(day.minute_count);
  const validCount = Number.isInteger(count) && count>=0 ? count : null;
  const cleanDay = {...day, minute_count:validCount};
  const verdict=classifyTclOps({day:cleanDay,heartbeatAt,now:at,offlineRuleValidated:false});
  // The baseline classifies fresh status=1 as LIVE even without heartbeat. Keep stricter
  // authoritative counts separate until independent capture agent evidence is available.
  const state=verdict.state==='LIVE' && !verdict.agentAlive ? 'UNKNOWN' : verdict.state;
  const reason=verdict.state==='LIVE' && !verdict.agentAlive ? 'LIVE_UNCONFIRMED_CAPTURE_AGENT' : verdict.reason;
  const previousComparable=previous?.date===date && previous?.roomId===room.roomId &&
    Number.isInteger(previous?.minuteCount) && previous.minuteCount>=0 &&
    Number.isInteger(previous?.at) && previous.at < at;
  const delta=previousComparable && validCount!==null ? liveMinutesDelta(previous.minuteCount,validCount) : null;
  // Delta is capture-minute_count difference, NOT independently proven wall-clock live duration.
  return {...base,status:state,reason,offlineCandidate:Boolean(verdict.offlineCandidate),
    agentAlive:Boolean(verdict.agentAlive), minutesDelta:delta,
    latestMinuteAgeMin:verdict.minuteAgeMin??null, minuteCount:validCount};
}

export function scanSummary(observations) {
  return observations.reduce((s,o)=>{s[o.status]=(s[o.status]||0)+1;return s;}, {LIVE:0,OFFLINE:0,UNKNOWN:0});
}

export function networkReader(base, fetchFn=globalThis.fetch, timeoutMs=20000) {
  if(!base) throw new Error('BASE_NOT_SET');
  const root=new URL(base);
  if(!['http:','https:'].includes(root.protocol)) throw new Error('BASE_PROTOCOL_INVALID');
  if(root.username || root.password || root.search || root.hash || (root.pathname!=='/' && root.pathname!=='')) throw new Error('BASE_MUST_BE_ORIGIN');
  return async (path, params=null) => {
    if(!Object.values(SOURCE_ROUTES).includes(path)) throw new Error('PATH_NOT_ALLOWED');
    const url=new URL(path,root);
    if(params) for(const [k,v] of Object.entries(params)) url.searchParams.set(k,String(v));
    const response=await fetchFn(url, {method:'GET',redirect:'error',signal:AbortSignal.timeout(timeoutMs),headers:{accept:'application/json'}});
    if(!response.ok) throw new Error('HTTP_ERROR');
    const length=Number(response.headers?.get?.('content-length'));
    if(Number.isFinite(length)&&length>MAX_RESPONSE_BYTES) throw new Error('BODY_TOO_LARGE');
    let body;
    if (response.body && typeof response.body.getReader === 'function') {
      // A misleading/missing Content-Length must never allow an unbounded
      // response allocation. Check each chunk before concatenating.
      const stream=response.body.getReader(), chunks=[];
      let readBytes=0;
      try {
        for (;;) {
          const {done,value}=await stream.read();
          if(done) break;
          readBytes+=value.byteLength;
          if(readBytes>MAX_RESPONSE_BYTES) {
            await stream.cancel().catch(()=>{});
            throw new Error('BODY_TOO_LARGE');
          }
          chunks.push(Buffer.from(value));
        }
      } finally { stream.releaseLock(); }
      body=Buffer.concat(chunks,readBytes).toString('utf8');
    } else {
      // Compatibility for minimal HTTP mock responses used in regression tests.
      body=await response.text();
      if(Buffer.byteLength(body,'utf8')>MAX_RESPONSE_BYTES) throw new Error('BODY_TOO_LARGE');
    }
    try { return JSON.parse(body); } catch { throw new Error('INVALID_JSON'); }
  };
}

async function mapBounded(items, limit, fn) {
  let i=0; const output=new Array(items.length);
  await Promise.all(Array.from({length:Math.min(limit,items.length)}, async ()=>{
    while(i<items.length) { const idx=i++; output[idx]=await fn(items[idx]); }
  }));
  return output;
}

/** Deterministic per-room partitioning; adding a room doesn't shuffle old ones. */
export function roomBelongsToShard(roomId, shardIndex, shardTotal) {
  if (!Number.isInteger(shardIndex) || !Number.isInteger(shardTotal) || shardTotal<1 || shardTotal>16 || shardIndex<0 || shardIndex>=shardTotal)
    throw new Error('SHARD_INVALID');
  const id=safeId(roomId);
  if (!id) throw new Error('SHARD_ROOM_ID_INVALID');
  return BigInt(id)%BigInt(shardTotal)===BigInt(shardIndex);
}

const validCalendarDate = date => {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const d=new Date(`${date}T12:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0,10)===date;
};

/** Bounded read-only discovery and state scan. Never writes to the source system. */
export async function scanJdSource({reader, at=Date.now(), date=beijingDate(new Date(at)), previous=null,
  concurrency=3, maxRooms=100, shardIndex=0, shardTotal=1}) {
  if(!validCalendarDate(date)) throw new Error('DATE_FORMAT_INVALID');
  if(!Number.isInteger(concurrency) || concurrency<1 || concurrency>5) throw new Error('CONCURRENCY_LIMIT');
  if (!Number.isInteger(shardIndex) || !Number.isInteger(shardTotal) || shardTotal<1 || shardTotal>16 || shardIndex<0 || shardIndex>=shardTotal)
    throw new Error('SHARD_INVALID');
  const response={schemaVersion:2,checkedAt:new Date(at).toISOString(),date,source:'TCL_OPS_READ_ONLY',
    catalogStatus:'UNKNOWN',roomListScope:'UNKNOWN',warnings:[],shopCount:null,rooms:[],summary:null,
    shard:{index:shardIndex,total:shardTotal},summaryScope:shardTotal===1?'ALL_SOURCE_ROOMS':'SHARD_ONLY',
    discoveredRoomCount:null};
  let normalized;
  try { normalized=normalizeRoomList(await reader(SOURCE_ROUTES.rooms), maxRooms); }
  catch(e) { response.catalogStatus='UNAVAILABLE';response.warnings.push('ROOM_LIST_'+(e.message||'ERROR'));return response; }
  response.warnings.push(...normalized.warnings);
  response.discoveredRoomCount=normalized.rooms.length;
  const selectedRooms=normalized.rooms.filter(r=>roomBelongsToShard(r.roomId,shardIndex,shardTotal));
  response.roomListScope=normalized.catalogScope;
  response.catalogStatus=normalized.warnings.length?'PARTIAL_WITH_INTEGRITY_WARNINGS':'RECEIVED';
  const shopsResult=await Promise.allSettled([reader(SOURCE_ROUTES.shops),reader(SOURCE_ROUTES.heartbeats)]);
  let shops=null, heartbeat=null;
  let shopCatalogComplete=false;
  if(shopsResult[0].status==='fulfilled') {
    try{
      const shopBody=shopsResult[0].value;
      shops=normalizeShopList(shopBody);response.shopCount=shops.length;
      const allShops=extractArray(shopBody,[['shops'],['data','shops'],['data','list'],['list']],'SHOPS');
      const total=declaredTotal(shopBody);
      const hasNext=shopBody?.has_more===true || shopBody?.hasMore===true ||
        shopBody?.pagination?.has_more===true ||
        Boolean(shopBody?.next_cursor || shopBody?.nextCursor || shopBody?.pagination?.next_cursor);
      shopCatalogComplete=total!==null && total===allShops.length && !hasNext &&
        shops.length===allShops.filter(x=>isJD(x?.platform)).length;
      if(!shopCatalogComplete) response.warnings.push('SHOP_CATALOG_NOT_PROVEN_COMPLETE');
    } catch{response.warnings.push('SHOPS_SCHEMA_UNVERIFIED');}
  }else response.warnings.push('SHOPS_API_UNAVAILABLE');
  if(shopsResult[1].status==='fulfilled') {
    try{heartbeat=normalizeHeartbeats(shopsResult[1].value);}
    catch{response.warnings.push('HEARTBEATS_SCHEMA_UNVERIFIED');}
  }else response.warnings.push('HEARTBEATS_API_UNAVAILABLE');
  const withShopId=normalized.rooms.filter(r=>r.shopId!==null);
  response.shopJoinStatus = withShopId.length===0 ? 'NO_ROOM_TO_SHOP_ID_JOIN' :
    withShopId.length===normalized.rooms.length ? 'ALL_ROOM_SHOP_IDS_PRESENT' : 'PARTIAL_ROOM_SHOP_IDS';
  response.unmatchedShopIds=shops && withShopId.length===normalized.rooms.length ?
    shops.map(s=>s.shopId).filter(id=>!withShopId.some(r=>r.shopId===id)) : null;
  response.rooms=await mapBounded(selectedRooms,concurrency,async room=>{
    let doc;
    try{doc=await reader(SOURCE_ROUTES.daily,{start_date:date,end_date:date,platform:'jd',live_room_id:room.roomId});}
    catch{return {roomId:room.roomId,shopId:room.shopId,category:room.category,status:'UNKNOWN',reason:'DAILY_API_ERROR',captureBound:room.captureBound,categoryMappingConflict:room.categoryMappingConflict};}
    const days=Array.isArray(doc?.days)?doc.days:Array.isArray(doc?.data?.days)?doc.data.days:null;
    if(!days) return {roomId:room.roomId,shopId:room.shopId,category:room.category,status:'UNKNOWN',reason:'DAILY_SCHEMA_INVALID',captureBound:room.captureBound,categoryMappingConflict:room.categoryMappingConflict};
    const day=days.find(d=>d?.date===date) ?? null;
    return evaluateRoom({room, day, heartbeatAt:heartbeat?.get(room.roomId)??null, heartbeatDataAvailable:heartbeat!==null, at, date, previous:previous?.rooms?.find(x=>x.roomId===room.roomId)??null});
  });
  response.summary=scanSummary(response.rooms);
  const knownShops=new Set((shops??[]).map(s=>s.shopId));
  const roomShopLinksComplete=shops!==null && normalized.rooms.every(r=>r.shopId!==null && knownShops.has(r.shopId)) &&
    response.unmatchedShopIds?.length===0;
  const roomCatalogComplete=normalized.catalogScope==='API_DECLARED_COMPLETE' &&
    !response.warnings.some(w=>w.startsWith('JD_ROOM_'));
  response.monitoringCoverage={jdRoomCount:response.rooms.length,
    discoveredRoomCount:normalized.rooms.length, shopsWithUnresolvedRoomMapping:response.unmatchedShopIds?.length??null,
    roomCatalogComplete, shopCatalogComplete, roomShopLinksComplete,
    exhaustive:shardTotal===1 && roomCatalogComplete && shopCatalogComplete && roomShopLinksComplete};
  return response;
}

/** Save just the minimal comparable state, not business metrics or raw API payloads. */
export function makePreviousSnapshot(report, now=Date.now()) {
  return {date:report.date,at:now,rooms:report.rooms.map(x=>({roomId:x.roomId,date:report.date,at:now,minuteCount:x.minuteCount??null}))};
}

/** Merge comparable safe state. Never overwrite last valid evidence with an error/empty scan. */
export function mergePreviousSnapshot(previous, report, now=Date.now()) {
  if (!report || report.catalogStatus==='UNAVAILABLE' || !validCalendarDate(report.date) || !Array.isArray(report.rooms)) return null;
  if (!Number.isSafeInteger(now) || now<0) return null;
  const compatible=previous && previous.date===report.date && Number.isSafeInteger(previous.at);
  if (compatible && previous.at >= now) return null; // stale/out-of-order writer
  const map=new Map();
  if (compatible && Array.isArray(previous.rooms)) for(const old of previous.rooms) {
    const roomId=safeId(old?.roomId);
    if (!roomId || old?.date!==report.date || !Number.isSafeInteger(old?.at) ||
      old.at>now || !Number.isInteger(old?.minuteCount) || old.minuteCount<0) continue;
    map.set(roomId,{roomId,date:report.date,at:old.at,minuteCount:old.minuteCount});
  }
  let changes=0;
  for(const room of report.rooms) {
    const roomId=safeId(room?.roomId);
    if (!roomId || !Number.isInteger(room.minuteCount) || room.minuteCount<0) continue;
    map.set(roomId,{roomId,date:report.date,at:now,minuteCount:room.minuteCount});
    changes++;
  }
  if (!changes) return null;
  return {date:report.date,at:now,rooms:[...map.values()].sort((a,b)=>a.roomId.localeCompare(b.roomId,'en',{numeric:true}))};
}
