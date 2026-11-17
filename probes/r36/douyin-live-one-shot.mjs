/**
 * R3.6 experimental TCL OPS Douyin one-shot LIVE / UNKNOWN probe.
 * Never scheduled, persisted or scored; never interprets absent capture as OFFLINE.
 * Do NOT publish room IDs, shop metadata, raw responses or credentials.
 */
import fs from 'node:fs/promises';
import {PATHS, query, inspectRoomCatalog, isDouyin} from './douyin-ops-qa.mjs';
import {classifyTclOps} from '../lib/tcl-ops.mjs';
import {beijingDate} from '../lib/tcl-jd-all.mjs';

const safeId=x=>/^\d{1,16}$/.test(String(x??''))?String(x):null;

export function trustedDouyinHeartbeatMap(body){
 const input=[body?.rooms,body?.data?.rooms,body?.data?.list,body?.list].find(Array.isArray);
 if(!input)throw Error('HEARTBEAT_SCHEMA_UNVERIFIED');
 const map=new Map(),warnings=[];
 for(const item of input){
  // Avoid cross-platform collisions: require the capture source to identify Douyin.
  if(!isDouyin(item?.platform))continue;
  const rid=safeId(item?.id??item?.live_room_id??item?.room_id);
  if(!rid)continue;
  if(map.has(rid)){warnings.push('HEARTBEAT_DUPLICATE');map.delete(rid);continue;}
  const t=item?.last_heartbeat_at;
  map.set(rid,typeof t==='string'&&Number.isFinite(Date.parse(t))?t:null);
 }
 return {map,warnings};
}
export function decideSourceDouyinState({room,day,heartbeatAt,now,date}){
 const base={state:'UNKNOWN',reason:'NO_VALIDATED_SIGNAL',offlineCandidate:false};
 if(date!==beijingDate(new Date(now)))return {...base,reason:'HISTORICAL_NOT_REALTIME'};
 if(!room?.bound)return {...base,reason:'CAPTURE_UNBOUND'};
 if(!heartbeatAt)return {...base,reason:'CAPTURE_HEARTBEAT_UNVERIFIED'};
 if(!day||typeof day!=='object')return {...base,reason:'DAILY_MISSING'};
 const result=classifyTclOps({day,heartbeatAt,now,offlineRuleValidated:false});
 if(result.state==='LIVE'&&result.agentAlive){
  return {...base,state:'LIVE',reason:result.reason};
 }
 return {...base,reason:result.reason,offlineCandidate:result.offlineCandidate===true};
}
export async function scanDouyinNow(get=query,now=Date.now()){
 const date=beijingDate(new Date(now));
 const output={schemaVersion:36,mode:'ISOLATED_READONLY_ONE_SHOT',date,source:'TCL_OPS_EXISTING_API',
   catalogScope:'UNAVAILABLE',observedRooms:0,boundRooms:0,roomsWithTrustedHeartbeat:0,
   attemptedDaily:0,LIVE:0,UNKNOWN:0,OFFLINE:0,offlineCandidates:0,
   reasons:{},errors:[],formalOpeningRate:null,formalDurationRate:null,
   verifiedCoverage:false,verifiedExactStartEnd:false};
 let catalog;
 try{catalog=inspectRoomCatalog(await get(PATHS.rooms));}
 catch(e){output.errors.push('ROOM_CATALOG:'+e.message);return output;}
 output.catalogScope=catalog.scope;
 output.observedRooms=catalog.rooms.length;
 output.boundRooms=catalog.rooms.filter(r=>r.bound).length;
 if(catalog.rooms.length>20){output.errors.push('ROOM_LIMIT_NOT_COMPLETE');return output;}
 let heartbeats=new Map();
 try{heartbeats=trustedDouyinHeartbeatMap(await get(PATHS.active)).map}
 catch(e){output.errors.push('HEARTBEAT:'+e.message)}
 for(const room of catalog.rooms){
  if(heartbeats.get(room.roomId))output.roomsWithTrustedHeartbeat++;
  let verdict={state:'UNKNOWN',reason:'DAILY_API_UNAVAILABLE',offlineCandidate:false};
  try{
   // The platform code comes from the source catalog, not a guessed 'dy' label.
   const daily=await get(PATHS.daily,{start_date:date,end_date:date,platform:room.platform,live_room_id:room.roomId});
   output.attemptedDaily++;
   const days=Array.isArray(daily?.days)?daily.days:Array.isArray(daily?.data?.days)?daily.data.days:null;
   if(!days)verdict={state:'UNKNOWN',reason:'DAILY_SCHEMA_UNVERIFIED'};
   else verdict=decideSourceDouyinState({room,day:days.find(d=>d?.date===date)||null,heartbeatAt:heartbeats.get(room.roomId)||null,now,date});
  }catch(e){output.errors.push('DAILY:'+e.message)}
  output[verdict.state==='LIVE'?'LIVE':'UNKNOWN']++;
  if(verdict.offlineCandidate)output.offlineCandidates++;
  output.reasons[verdict.reason]=(output.reasons[verdict.reason]||0)+1;
 }
 // A directory without declared complete census is never complete coverage.
 return output;
}
if(process.argv[1]?.endsWith('douyin-live-one-shot.mjs')){
 const result=await scanDouyinNow();
 await fs.writeFile('r36-douyin-live-safe.json',JSON.stringify(result,null,2)+'\n');
 console.log('R36_DOUYIN_REALTIME_SAFE '+JSON.stringify(result));
 if(result.catalogScope==='UNAVAILABLE')process.exitCode=2;
}
