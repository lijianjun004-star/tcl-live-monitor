/** Read-only multi-source status projection for dashboard preview only.
 * Does NOT alter the underlying three-platform probes or scoring engine.
 * UNKNOWN always when missing, stale or contradictory.
 */
const ALLOWED = new Set(['LIVE','OFFLINE','UNKNOWN']);
const numTime = t => { const n=typeof t==='number'?t:Date.parse(String(t??'')); return Number.isFinite(n)?n:null;};
const validFresh = (t,now,maxAgeMs) => t!==null&&t<=now&&t>=now-maxAgeMs;
const cleanReason = (r,fallback) => typeof r==='string'&&/^[A-Z][A-Z0-9_; :-]{0,100}$/.test(r)?r:fallback;
export function mergeLiveObservations(registry,{jdReport=null,publicReport=null,now=Date.now(),maxAgeMinutes=12}={}){
 if(!registry?.entries||!Array.isArray(registry.entries))throw Error('REGISTRY_INVALID');
 if(!Number.isFinite(now)||!Number.isFinite(maxAgeMinutes)||maxAgeMinutes<=0||maxAgeMinutes>120)throw Error('CLOCK_INVALID');
 const identities=new Set();
 for(const item of registry.entries){
  if(!item||!['jd','tmall','douyin'].includes(item.platform)||typeof item.key!=='string'||identities.has(item.key))throw Error('REGISTRY_IDENTITY_CONFLICT');
  identities.add(item.key);
 }
 const corroborated=o=>{
  if(o.platform==='douyin')return o.profileIdentityVerified===true&&o.roomPageIdentityVerified===true&&
    (o.state!=='LIVE'||(/^\d{5,24}$/.test(String(o.observedRoomId??''))&&String(o.observedRoomId)===String(o.checkedRoomId)));
  if(o.platform==='tmall')return typeof o.observed?.accountId==='string'&&typeof o.observed?.roomNumber==='string';
  return false;
 };
 const age=maxAgeMinutes*60_000;const rows=[];
 const jdAt=numTime(jdReport?.checkedAt);
 const validJD=jdReport?.schemaVersion===2 && jdReport?.source==='TCL_OPS_READ_ONLY' && Array.isArray(jdReport?.rooms);
 const jdMap=new Map(),jdDuplicateIds=new Set();
 for(const o of validJD?jdReport.rooms:[]){
  if(!/^\d{1,20}$/.test(String(o?.roomId??'')))continue;
  const id=String(o.roomId);if(jdMap.has(id))jdDuplicateIds.add(id);
  else jdMap.set(id,o);
 }
 const pubMap=new Map(),sharedRoomAccounts=new Map();
 for(const o of publicReport?.schemaVersion===1&&Array.isArray(publicReport.observations)?publicReport.observations:[]){
  const k=String(o.platform)+':'+String(o.accountId);
  const a=pubMap.get(k)??[];a.push(o);pubMap.set(k,a);
  const t=numTime(o.at);
  if(validFresh(t,now,age)&&o.state==='LIVE'&&/^\d{5,24}$/.test(String(o.observedRoomId??''))){
   const rk=String(o.platform)+':'+String(o.observedRoomId);
   const set=sharedRoomAccounts.get(rk)??new Set();set.add(String(o.accountId));sharedRoomAccounts.set(rk,set);
  }
 }
 for(const item of registry.entries){
  let state='UNKNOWN',reason='NO_FRESH_OBSERVATION',observedAt=null;
  if(item.source==='ops-platform'&&item.platform==='jd'&&validJD&&validFresh(jdAt,now,age)){
   const o=jdMap.get(item.opsRoomId);
   if(jdDuplicateIds.has(String(item.opsRoomId))) reason='JD_DUPLICATE_OBSERVATIONS';
   else if(o && (o.categoryMappingConflict===true || item.categoryMappingConflict===true)){
    state='UNKNOWN';reason='JD_CATEGORY_MAPPING_CONFLICT';observedAt=jdReport.checkedAt;
   }else if(o && o.captureBound===true && ALLOWED.has(o.status)){
    state=o.status==='LIVE'&&o.agentAlive===true?'LIVE':'UNKNOWN';
    reason=o.status==='OFFLINE'?'OFFLINE_RULE_UNVERIFIED':o.status==='LIVE'?(o.agentAlive===true?'FRESH_JD_OPS_OBSERVATION':'JD_AGENT_NOT_VERIFIED'):cleanReason(o.reason,'JD_OBSERVATION_UNKNOWN');
    observedAt=jdReport.checkedAt;
   }else reason='JD_OBSERVATION_UNVERIFIED';
  }
  if(item.source==='public-probe-existing'){
   const candidates=(pubMap.get(item.platform+':'+item.platformAccountId)??pubMap.get(item.platform+':'+item.key.split(':').slice(2).join(':'))??[])
    .map(o=>({...o,_at:numTime(o.at)})).filter(o=>validFresh(o._at,now,age)).sort((a,b)=>b._at-a._at);
   if(candidates.length){
    const top=candidates.filter(o=>o._at===candidates[0]._at);
    observedAt=new Date(candidates[0]._at).toISOString();
    if(new Set(top.map(o=>o.state)).size===1){
      const o=top[0];
      const identityMatches=x=>corroborated(x)&&(item.platform!=='tmall'||(x.observed.accountId===item.platformAccountId&&(!item.platformRoomId||x.observed.roomNumber===item.platformRoomId)));
      const sharedConflict=o.state==='LIVE'&&/^\d{5,24}$/.test(String(o.observedRoomId??''))&&(sharedRoomAccounts.get(String(o.platform)+':'+String(o.observedRoomId))?.size??0)>1;
      if(sharedConflict){state='UNKNOWN';reason='SHARED_PUBLIC_ROOM_ID_CONFLICT';}
      else if(o.state==='LIVE'&&top.every(identityMatches)){state='LIVE';reason='PUBLIC_PROBE_LIVE';}
      else if(o.state==='OFFLINE'&&top.every(x=>identityMatches(x)&&x.offlineEvidence===true&&(item.platform==='douyin'?publicReport.douyinOfflineRuleValidated===true:publicReport.tmallOfflineRuleValidated===true))){state='OFFLINE';reason='VALIDATED_PUBLIC_OFFLINE';}
      else{state='UNKNOWN';reason=o.state==='OFFLINE'?'OFFLINE_NOT_VALIDATED':o.state==='LIVE'?'PUBLIC_IDENTITY_EVIDENCE_MISSING':cleanReason(o.reason,'UNKNOWN');}
    }else reason='CONFLICTING_PUBLIC_OBSERVATIONS';
   }
  }
  rows.push({...item,formalScoringEnabled:false,currentStatus:state,currentReason:reason,observedAt});
 }
 const byPlatform={jd:{LIVE:0,OFFLINE:0,UNKNOWN:0},tmall:{LIVE:0,OFFLINE:0,UNKNOWN:0},douyin:{LIVE:0,OFFLINE:0,UNKNOWN:0}};
 for(const row of rows) if(row.source!=='ops-history-unmapped')byPlatform[row.platform][row.currentStatus]++;
 return {schemaVersion:1,generatedAt:new Date(now).toISOString(),scope:'separate-source-entries-not-unique-rooms',byPlatform,rows};
}
