/**
 * R2.1: reliability gate for sanitized TCL OPS read-only JD scans.
 * Does not access JD nor TCL source, does not calculate formal opening rate.
 */
export const FRESHNESS_MS=15*60*1000;
const ISO=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const ID=/^\d{1,16}$/;
const statuses=new Set(['LIVE','OFFLINE','UNKNOWN']);
const bjt=(d)=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(d);
export function acceptJdOpsScan(scan,{now=new Date().toISOString(),maxAgeMs=FRESHNESS_MS}={}){
 const empty={schema_version:21,platform:'jd',readiness:'BLOCKED',checked_at:null,
  age_seconds:null,source:'TCL_OPS_READ_ONLY',live:0,unknown:0,offline:0,room_count:0,
  rooms:[],warnings:[],formal_opening_rate_percent:null,formal_attendance_ready:false,
  fully_verified_public_accounts:false,fully_verified_schedule:false,
  current_source_state:'UNKNOWN',reason:'INVALID_SCAN_REPORT'};
 if(!scan||scan.schemaVersion!==2||scan.source!=='TCL_OPS_READ_ONLY'||
    !ISO.test(String(scan.checkedAt||'')))return empty;
 const t=Date.parse(scan.checkedAt),n=Date.parse(now),age=n-t;
 if(!Number.isFinite(t)||!Number.isFinite(n)||age>maxAgeMs||age< -60000)
   return {...empty,checked_at:scan.checkedAt,reason:'STALE_OR_FUTURE_SCAN'};
 if(scan.shard?.index!==0||scan.shard?.total!==1||scan.summaryScope!=='ALL_SOURCE_ROOMS')
   return {...empty,checked_at:scan.checkedAt,reason:'INCOMPLETE_SHARDED_SCAN'};
 if(scan.catalogStatus==='UNAVAILABLE'||!Array.isArray(scan.rooms)||scan.summary===null)
   return {...empty,checked_at:scan.checkedAt,reason:'SOURCE_UNAVAILABLE'};
 const expected=bjt(new Date(t));
 if(scan.date!==expected)return {...empty,checked_at:scan.checkedAt,reason:'BEIJING_DATE_MISMATCH'};
 const seen=new Set(),sanitized=[],sums={LIVE:0,OFFLINE:0,UNKNOWN:0};
 for(const r of scan.rooms){
  if(!r||!ID.test(String(r.roomId||''))||seen.has(String(r.roomId))||
     !statuses.has(r.status)||typeof r.reason!=='string')
   return {...empty,checked_at:scan.checkedAt,reason:'ROOM_SCHEMA_OR_DUPLICATE'};
  if(r.status==='OFFLINE')return {...empty,checked_at:scan.checkedAt,reason:'OFFLINE_NOT_FIELD_VALIDATED'};
  const room={room_id:String(r.roomId),shop_id:r.shopId===null?null:String(r.shopId),
    category:String(r.category||'').slice(0,50),state:r.status,reason:r.reason,
    agent_alive:r.agentAlive===true,
    minute_age_min:Number.isFinite(r.latestMinuteAgeMin)?r.latestMinuteAgeMin:null,
    offline_candidate:r.offlineCandidate===true};
  if(room.shop_id!==null&&!ID.test(room.shop_id))
   return {...empty,checked_at:scan.checkedAt,reason:'INVALID_SHOP_ID'};
  sanitized.push(room);seen.add(room.room_id);sums[room.state]++;
 }
 if(!scan.summary||['LIVE','UNKNOWN','OFFLINE'].some(k=>scan.summary[k]!==sums[k]))
   return {...empty,checked_at:scan.checkedAt,reason:'SUMMARY_COUNT_CONFLICT'};
 if(sanitized.length!==scan.discoveredRoomCount)
   return {...empty,checked_at:scan.checkedAt,reason:'PARTIAL_ROOM_CATALOG'};
 if(!['API_DECLARED_COMPLETE','API_RESPONSE_NOT_PROVEN_EXHAUSTIVE'].includes(scan.roomListScope))
   return {...empty,checked_at:scan.checkedAt,reason:'ROOM_CATALOG_SCOPE_UNVERIFIED'};
 const warnings=Array.isArray(scan.warnings)?scan.warnings.map(x=>String(x).slice(0,100)).slice(0,20):[];
 const integrityBlocked=warnings.some(x=>/CONFLICT|DUPLICATE|NOT_PROVEN_COMPLETE|UNVERIFIED|API_UNAVAILABLE|SCHEMA/i.test(x));
 return {...empty,readiness:integrityBlocked?'PARTIAL':'OBSERVED',
  checked_at:scan.checkedAt,age_seconds:Math.round(age/1000),
  live:sums.LIVE,offline:0,unknown:sums.UNKNOWN,room_count:sanitized.length,
  rooms:sanitized,warnings,
  current_source_state:sums.UNKNOWN===sanitized.length?'UNKNOWN':'MIXED_OBSERVED',
  reason:integrityBlocked?'INTEGRITY_WARNINGS':'READ_ONLY_CURRENT_DAY_OBSERVATION',
  catalog_complete_attested:scan.roomListScope==='API_DECLARED_COMPLETE',
  formal_opening_rate_percent:null,formal_attendance_ready:false};
}
