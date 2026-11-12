/** R1.1 identity gates: read-only, independent per record, never auto-promotes scoring. */
export const strictBoolean = v => v === true || v === 'true' ? true : v === false || v === 'false' ? false : null;
const s = v => String(v ?? '').trim();
export function stableKey(r) {
 const id=s(r.accountStableId);
 if(r.platform==='douyin' && /^douyin:secUid:MS4wLjABAAAA[A-Za-z0-9_-]{20,}$/.test(id)) return id;
 if(r.platform==='tmall' && /^tmall:accountId:\d{5,16}$/.test(id)) return id;
 if(r.platform==='jd(内部采集)' && /^jd:opsRoom:\d+$/.test(id)) return id;
 return null; // Neither store IDs nor SKU numbers prove a live-account identity.
}
export function historicalRoomCheck(row, room) {
 if(!room || s(row.sourceKey)!==s(room.sourceKey)) return {verified:false,reason:'NO_MATCHED_ROOM_EVIDENCE'};
 if(row.platform==='jd(内部采集)') return {verified:false,reason:'OPS_INTERNAL_NOT_PUBLIC_LIVE_ID'};
 if(!['douyin','tmall'].includes(row.platform)) return {verified:false,reason:'UNSUPPORTED_PLATFORM'};
 if(strictBoolean(row.platformIdentityVerified)!==true) return {verified:false,reason:'ACCOUNT_IDENTITY_NOT_VERIFIED'};
 const id=s(room.verifiedLiveRoomOrStreamId);
 if(!/^\d+$/.test(id)) return {verified:false,reason:'INVALID_PUBLIC_LIVE_ID'};
 if(!['VERIFIED','ROOM_ID_ROTATED_VERIFIED'].includes(s(room.crossCheckStatus)))
   return {verified:false,reason:'ROOM_PAGE_NOT_CROSS_VERIFIED'};
 return {verified:true,reason:'HISTORICAL_CROSS_VERIFIED',publicRoomId:id};
}
export function auditIdentity(rows, rooms=[], storeEvidence=[]) {
 const roomByKey=new Map(rooms.map(r=>[s(r.sourceKey),r]));
 const storeByKey=new Map(storeEvidence.map(r=>[s(r.sourceKey),r]));
 const seen=new Map(), output=[];
 for(const row of rows) {
  const key=stableKey(row), room=historicalRoomCheck(row,roomByKey.get(s(row.sourceKey))), store=storeByKey.get(s(row.sourceKey));
  const internal=row.platform==='jd(内部采集)' && s(row.identityVerified)==='internal-only';
  let gate=s(row.identityVerified)==='REFUTED'||s(row.platformIdentityVerified)==='REFUTED' ? 'REFUTED' :
   room.verified ? 'HISTORICAL_PUBLIC_ROOM_VERIFIED' : internal ? 'OPS_INTERNAL_ONLY' :
   (strictBoolean(row.platformIdentityVerified)===true && key) ? 'ACCOUNT_ONLY' :
   store?.storeVerified===true ? 'STORE_ONLY' : 'UNVERIFIED_LEAD';
  if(key){if(seen.has(key))gate='DUPLICATE_ACCOUNT_KEY';else seen.set(key,s(row.sourceKey));}
  output.push({sourceKey:s(row.sourceKey),platform:s(row.platform),name:s(row.platformShownName)||s(row.sourceName),
   stableAccountKey:key||'',storePage:store?.url||'',storeIdentityVerified:store?.storeVerified===true,
   historicalPublicRoomId:room.verified?room.publicRoomId:'',roomCrossVerified:room.verified,
   gate,roomReason:room.reason,priorState:['LIVE','OFFLINE','UNKNOWN'].includes(s(row.state))?s(row.state):'UNKNOWN',
   priorCheckedAt:s(row.lastCheckedAt),stateScope:'HISTORICAL_ONLY',
   brandOwnershipVerified:strictBoolean(row.brandOwnershipVerified)===true,
   reliableMonitorPassed:strictBoolean(row.reliableMonitorPassed)===true,
   scoringEligible:false,legacyScoringFlag:s(row.legacyScoringFlag),
   originalScoringField:s(row.scoringEligible),evidenceRunIDs:s(row.runID)});
 }
 return output;
}
export function gateSummary(rows){
 const gates={};for(const r of rows)gates[r.gate]=(gates[r.gate]||0)+1;
 return {total:rows.length,gates,publicHistoricalRooms:rows.filter(r=>r.roomCrossVerified).length,
  uniqueStableKeys:new Set(rows.map(r=>r.stableAccountKey).filter(Boolean)).size,
  newScoringEligible:rows.filter(r=>r.scoringEligible).length};
}
