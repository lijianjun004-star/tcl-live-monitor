// R3.6: evidence-only Douyin source contract, no authentication/captcha bypass.
// This PUBLIC repository must never log raw room/shop payloads or source credentials.
import fs from 'node:fs/promises';
export const PATHS=Object.freeze({rooms:'/api/capture/rooms',shops:'/api/shops',daily:'/api/capture/room-overview/daily',active:'/api/assistant/active-rooms'});
export const isDouyin=p=>['dy','douyin','抖音'].includes(String(p??'').trim().toLowerCase());
const id=x=>/^\d{1,16}$/.test(String(x??''))?String(x):null;
function rows(b,kind){
 const a=kind==='shops'&&Array.isArray(b)?b:[b?.[kind],b?.data?.[kind],b?.data?.list,b?.list].find(Array.isArray);
 if(!Array.isArray(a))throw Error('SCHEMA_'+kind.toUpperCase()+'_UNCONFIRMED');
 if(a.length>(kind==='rooms'?500:1000))throw Error('SOURCE_CATALOG_LIMIT');
 return a;
}
export function inspectRoomCatalog(body){
 const list=rows(body,'rooms'), platformCounts={},roomIds=new Set(),rooms=[],warnings=[];
 for(const r of list){
  const platform=String(r?.platform??'').trim().toLowerCase()||'(missing)';
  platformCounts[platform]=(platformCounts[platform]||0)+1;
  if(!isDouyin(platform))continue;
  const roomId=id(r?.id??r?.live_room_id??r?.room_id);
  if(!roomId){warnings.push('DOUYIN_ID_UNCONFIRMED');continue}
  if(roomIds.has(roomId)){warnings.push('DOUYIN_DUPLICATE_ROOM');continue}
  roomIds.add(roomId);
  rooms.push({roomId,platform,shopId:id(r?.shop_id??r?.shopId??r?.shop?.id),bound:Boolean(r?.bound_session_key)});
 }
 const t=body?.total??body?.total_count??body?.pagination?.total??body?.data?.total;
 const total=t==null?null:Number(t);
 const incomplete=body?.has_more===true||body?.hasMore===true||body?.pagination?.has_more===true||
  Boolean(body?.next_cursor??body?.nextCursor)||(Number.isInteger(total)&&total>list.length);
 return {rooms,platformCounts,warnings,scope:incomplete?'PAGINATED_OR_INCOMPLETE':
  total===null?'API_RESPONSE_NOT_PROVEN_EXHAUSTIVE':total===list.length?'API_DECLARED_COMPLETE':'TOTAL_CONFLICT'};
}
export function inspectShops(body){
 const set=new Set();
 for(const x of rows(body,'shops'))if(isDouyin(x?.platform)){const v=id(x?.id??x?.shop_id??x?.shopId);if(v)set.add(v)}
 return set;
}
export function inspectDaily(body,date){
 const days=Array.isArray(body?.days)?body.days:Array.isArray(body?.data?.days)?body.data.days:null;
 if(!days)return {schema:'UNCONFIRMED',datePresent:false,status:'UNKNOWN'};
 const day=days.find(d=>d?.date===date);
 return {schema:'DAYS_ARRAY',datePresent:Boolean(day),
   minuteCountField:Number.isInteger(day?.minute_count)&&day.minute_count>=0,
   sessionCountField:Number.isInteger(day?.session_count)&&day.session_count>=0,
   latestMinuteField:typeof day?.latest_minute_ts==='string'&&Number.isFinite(Date.parse(day.latest_minute_ts)),
   status:'UNKNOWN'}; // Historical metrics NEVER prove current live/offline status.
}
export async function query(path,params={},fetchImpl=fetch){
 if(!Object.values(PATHS).includes(path))throw Error('API_ROUTE_NOT_ALLOWED');
 const origin=new URL(process.env.TCL_OPS_BASE_URL||'http://101.96.215.251');
 if(origin.hostname!=='101.96.215.251'||!['http:','https:'].includes(origin.protocol)||
    !['','/'].includes(origin.pathname)||origin.search||origin.hash||origin.username||origin.password)
   throw Error('SOURCE_ORIGIN_NOT_ALLOWED');
 const url=new URL(path,origin);
 for(const [k,v] of Object.entries(params))url.searchParams.set(k,String(v));
 const resp=await fetchImpl(url,{method:'GET',redirect:'manual',headers:{accept:'application/json'},signal:AbortSignal.timeout(15000)});
 if(!resp.ok)throw Error('SOURCE_HTTP_'+resp.status);
 const length=Number(resp.headers?.get?.('content-length'));
 if(Number.isFinite(length)&&length>800000)throw Error('SOURCE_BODY_TOO_LARGE');
 const raw=await resp.text();
 if(Buffer.byteLength(raw)>800000)throw Error('SOURCE_BODY_TOO_LARGE');
 try{return JSON.parse(raw)}catch{throw Error('SOURCE_NOT_JSON')}
}
export async function audit(get=query,date='2026-10-21'){
 if(!/^20\d\d-\d\d-\d\d$/.test(date))throw Error('DATE_INVALID');
 const errors=[], shapes=[];
 let catalog=null,shops=null;
 try{catalog=inspectRoomCatalog(await get(PATHS.rooms))}
 catch(e){return {version:36,platform:'douyin',source:'TCL_OPS_READ_ONLY',catalogScope:'UNAVAILABLE',roomsFound:0,
  realTimeStatus:'UNKNOWN',errors:['ROOM_CATALOG:'+e.message],fullCloneVerified:false}}
 if(catalog.rooms.length){
  try{shops=inspectShops(await get(PATHS.shops))}
  catch(e){errors.push('SHOP_CATALOG:'+e.message)}
  for(const room of catalog.rooms.slice(0,4)){
   try{const day=await get(PATHS.daily,{start_date:date,end_date:date,platform:room.platform,live_room_id:room.roomId});
     shapes.push(inspectDaily(day,date))}
   catch(e){errors.push('DAILY:'+e.message)}
  }
 }else errors.push('NO_SOURCE_CONFIRMED_DOUYIN_ROOM');
 return {version:36,platform:'douyin',source:'TCL_OPS_READ_ONLY',catalogScope:catalog.scope,
  platformCounts:catalog.platformCounts,roomsFound:catalog.rooms.length,
  boundRooms:catalog.rooms.filter(r=>r.bound).length,
  linkedRooms:shops===null?null:catalog.rooms.filter(r=>r.shopId&&shops.has(r.shopId)).length,
  shopsFound:shops?.size??null,
  testedDailyRooms:shapes.length,
  dailySchema:shapes.reduce((a,x)=>(a[x.schema]=(a[x.schema]||0)+1,a),{}),
  errors:errors.slice(0,6),warnings:catalog.warnings.slice(0,6),
  realTimeStatus:'UNKNOWN',offlineValidated:false,fullCloneVerified:false};
}
if(process.argv[1]?.endsWith('douyin-ops-qa.mjs')){
 const report=await audit();
 await fs.writeFile('r36-douyin-qa-safe.json',JSON.stringify(report,null,2)+'\n');
 console.log('R36_SAFE_DOUYIN_SCHEMA '+JSON.stringify(report));
 if(report.catalogScope==='UNAVAILABLE')process.exitCode=2;
}
