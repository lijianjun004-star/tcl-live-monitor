import {normalizeRoomList,SOURCE_ROUTES} from '../lib/tcl-jd-all.mjs';
import {sourceError} from '../lib/source-error.mjs';
import {beijingDate,reading} from './jd-fullday.mjs';

export async function scanFullday({reader,at=Date.now(),clock=Date.now,pause=()=>new Promise(r=>setTimeout(r,1000))}){
  const attemptedAt=new Date(at).toISOString(),rows=[],errors=[];
  let catalog,warnings=[];
  try{
    catalog=normalizeRoomList(await reader(SOURCE_ROUTES.rooms));warnings=catalog.warnings;
    if(!catalog.rooms.length)throw Error('NO_JD_ROOMS_IN_CATALOG');
  }catch(error){return {attemptedAt,completedAt:new Date(clock()).toISOString(),rows,errors:[{stage:'CATALOG',code:sourceError(error)}],warnings,sourceStatus:'FAILED'};}
  for(const room of catalog.rooms){
    const row={roomId:room.roomId,category:room.category,captureBound:room.captureBound,days:[],dailyOk:false,observedAt:null};
    try{
      const doc=await reader(SOURCE_ROUTES.daily,{start_date:beijingDate(at-7*86400e3),end_date:beijingDate(at),platform:'jd',live_room_id:room.roomId});
      const observed=clock(),seen=new Set();
      if(!Array.isArray(doc?.days)||doc.days.length>100)throw Error('SCHEMA_DAILY_ARRAY_MISSING');
      row.days=doc.days.map(d=>{
        const date=d?.date,t=Date.parse(String(date)+'T00:00:00+08:00');
        const r=reading(d,observed);
        if(typeof date!=='string'||!/^\d{4}-\d\d-\d\d$/.test(date)||!Number.isFinite(t)||beijingDate(t)!==date||
          seen.has(date)||r.minuteCount===null||r.latestMinuteAt&&Date.parse(r.latestMinuteAt)>observed+60000)
          throw Error('SCHEMA_DAILY_INVALID');
        seen.add(date);
        return {date,minute_count:r.minuteCount,latest_minute_ts:r.latestMinuteAt};
      });
      row.dailyOk=true;row.observedAt=new Date(observed).toISOString();
      if(row.days.length===0)errors.push({stage:'DAILY',roomId:room.roomId,code:'NO_DAILY_OBSERVATIONS'});
    }catch(error){row.days=[];errors.push({stage:'DAILY',roomId:room.roomId,code:sourceError(error)});}
    rows.push(row);await pause();
  }
  const good=rows.filter(r=>r.dailyOk&&r.days.length>0).length;
  return {attemptedAt,completedAt:new Date(clock()).toISOString(),rows,errors,warnings,
    sourceStatus:!good?'FAILED':errors.length||warnings.length?'PARTIAL':'OBSERVED'};
}
