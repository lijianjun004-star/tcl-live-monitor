/**
 * R3.11 - Source-first Douyin inventory reconciliation, zero network / zero writes.
 * INTERNAL room IDs never belong in PUBLIC GitHub logs or artifacts.
 * RPA sampling is independent and must not shrink the original OPS catalog.
 */
import {reconcileDouyinFourLayers} from '../r36/douyin-evidence-gate.mjs';

const safeId = value => /^(?:[1-9]\d{0,15})$/.test(String(value??'')) ? String(value) : null;
const isOps = platform => ['dy','douyin','抖音'].includes(String(platform??'').trim().toLowerCase());
const safeISO = x => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(x) && Number.isFinite(Date.parse(x)) ? new Date(x).toISOString() : null;
const RPA_GOOD = o => o?.state==='LIVE' && o?.profileIdentityVerified===true && o?.roomIdentityVerified===true;

function safeOps(r, lastSeenAt, observedNow){
 const id=safeId(r?.roomId),shopId=safeId(r?.shopId);
 if(!id||!isOps(r?.platform)) throw Error('OPS_ROOM_INVALID_OR_CROSS_PLATFORM');
 return {roomId:id,shopId,platform:String(r.platform).toLowerCase(),
  category:typeof r.category==='string'?r.category.slice(0,48):'未核实',
  captureBound:r.captureBound===true,opsShopIdentityMatched:r.opsShopIdentityMatched===true,
  opsSourceState:observedNow && r.status==='LIVE'?'LIVE':'UNKNOWN',
  opsSourceReason:observedNow && typeof r.reason==='string'?r.reason.slice(0,72):'NOT_OBSERVED_IN_CURRENT_SOURCE',
  seenInCurrentResponse:observedNow,lastSeenAt,
  publicAccountKey:null,publicLiveRoomId:null,identityVerified:false,
  verifiedPublicLive:false, publicEvidenceState:'UNVERIFIED',
  formalOpeningRatePercent:null,formalFullDurationRatePercent:null,exactStartAt:null,exactEndAt:null};
}

/**
 * Keep previously observed real rows if the latest source is unavailable or incomplete;
 * mark missing rows UNKNOWN, never OFFLINE or deleted. An aggregate baseline 10 is a
 * warning threshold only, and cannot recreate missing room identifiers.
 */
export function reconcileDouyinCatalog({sourceReport,previousInventory=null,approvedAccounts=[],rpaObservations=[],bridgeEvidence=[],
  historicalConfirmedMinimum=10}={}){
 if(!Array.isArray(approvedAccounts)||!Array.isArray(rpaObservations)||!Array.isArray(bridgeEvidence))throw Error('INVALID_RECONCILE_INPUT');
 if(!Number.isSafeInteger(historicalConfirmedMinimum)||historicalConfirmedMinimum<0||historicalConfirmedMinimum>1000)throw Error('BASELINE_INVALID');
 if(approvedAccounts.length>1000||rpaObservations.length>10000||bridgeEvidence.length>1000)throw Error('RECONCILE_LIMIT_EXCEEDED');
 const latest=sourceReport?.platform==='douyin'&&sourceReport?.sourceAccess==='ROOM_CATALOG_RECEIVED'&&Array.isArray(sourceReport?.rooms)
   ?sourceReport.rooms:null;
 const old=previousInventory?.platform==='douyin'&&Array.isArray(previousInventory.rooms)?previousInventory.rooms:[];
 if(latest?.length>1000||old.length>1000)throw Error('ROOM_LIMIT_EXCEEDED');
 const checkedAt=safeISO(sourceReport?.checkedAt)||null;
 const observed=new Map(),history=new Map(),conflicts=[];
 for(const x of old){
  const rid=safeId(x?.roomId);
  if(!rid||!isOps(x?.platform)||history.has(rid))throw Error('PREVIOUS_INVENTORY_INVALID');
  history.set(rid,safeOps(x,safeISO(x?.lastSeenAt),false));
 }
 if(latest)for(const x of latest){
  const rid=safeId(x?.roomId);
  if(!rid||!isOps(x?.platform)||observed.has(rid))throw Error('NEW_CATALOG_INVALID_OR_DUPLICATE');
  observed.set(rid,safeOps(x,checkedAt,true));
 }
 const currentIds=new Set(observed.keys());
 const merged=new Map(history);
 for(const [rid,cur] of observed){
  const prior=history.get(rid);
  if(prior?.shopId && cur.shopId && prior.shopId!==cur.shopId){
   conflicts.push({roomId:rid,type:'OPS_SHOP_RELATION_CHANGED_REQUIRES_REVIEW'});
   merged.set(rid,{...cur,shopId:prior.shopId,opsShopIdentityMatched:false,
     opsSourceState:'UNKNOWN',opsSourceReason:'OPS_SHOP_IDENTITY_CONFLICT'});
  }else merged.set(rid,cur);
 }
 const rooms=[...merged.values()].sort((a,b)=>a.roomId.localeCompare(b.roomId,'en',{numeric:true}));
 const approved=new Map();
 for(const x of approvedAccounts){if(x?.scopeApproved===true&&typeof x.key==='string'&&x.key){if(approved.has(x.key))throw Error('APPROVED_ACCOUNT_DUPLICATE');approved.set(x.key,x)}}
 const rpaLatest=new Map();
 for(const o of rpaObservations){
  if(!approved.has(o?.accountKey))continue;
  const at=safeISO(o.checkedAt);if(!at)continue;
  const prev=rpaLatest.get(o.accountKey);
  if(!prev||Date.parse(at)>Date.parse(prev.checkedAt))rpaLatest.set(o.accountKey,{...o,checkedAt:at});
 }
 const bridge=reconcileDouyinFourLayers({
  opsRooms:rooms.filter(x=>x.shopId&&x.seenInCurrentResponse&&!conflicts.some(c=>c.roomId===x.roomId)),
  accounts:[...approved.values()],evidenceRows:bridgeEvidence,
 });
 const links=new Map(bridge.links.filter(x=>x.status==='VERIFIED').map(x=>[x.opsRoomId,x]));
 for(const r of rooms){
  const link=links.get(r.roomId);if(!link)continue;
  r.publicAccountKey=link.accountKey;r.publicLiveRoomId=link.publicLiveRoomId;
  r.identityVerified=true;r.publicEvidenceState='UNKNOWN';
  const sample=rpaLatest.get(link.accountKey);
  if(!RPA_GOOD(sample))continue;
  if(safeId(sample.observedRoomId)!==link.publicLiveRoomId)continue;
  if(Date.parse(sample.checkedAt)<Date.parse(link.verifiedAt)||Date.parse(sample.checkedAt)-Date.parse(link.verifiedAt)>7*86400000)continue;
  r.publicEvidenceState='LIVE';r.verifiedPublicLive=true;
 }
 const warnings=[];
 const freshRoomCount=currentIds.size;
 if(!latest)warnings.push('SOURCE_UNAVAILABLE_PREVIOUS_ROOMS_RETAINED_UNKNOWN');
 if(sourceReport?.catalogComplete!==true)warnings.push('CATALOG_CENSUS_NOT_PROVEN_EXHAUSTIVE');
 if(freshRoomCount<historicalConfirmedMinimum)warnings.push('BELOW_PRIOR_OBSERVED_10_BASELINE_NOT_PROOF_OF_DELETION');
 if(rooms.length<historicalConfirmedMinimum)warnings.push('MISSING_PREVIOUS_ROOM_IDENTIFIERS_CANNOT_RECONSTRUCT_FROM_COUNT');
 if(rooms.length>freshRoomCount)warnings.push('PRIOR_ROOM_ROWS_RETAINED_AS_UNKNOWN');
 if(conflicts.length)warnings.push('SOURCE_SHOP_IDENTITY_CONFLICT');
 const publicRpaSamples=[...rpaLatest.values()];
 return {schemaVersion:311,platform:'douyin',mode:'SOURCE_FIRST_TWO_DISTINCT_CATALOGS',
  sourceCheckedAt:checkedAt,sourceAccess:latest?'ROOM_CATALOG_RECEIVED':'UNAVAILABLE',
  historicalConfirmedMinimum,observedSourceRoomsThisRun:freshRoomCount,
  retainedPriorRooms:rooms.length-freshRoomCount,inventoryRows:rooms.length,
  approvedPublicAccounts:approved.size,rpaSampledPublicAccounts:rpaLatest.size,
  publiclyDoubleVerifiedLiveSamples:publicRpaSamples.filter(RPA_GOOD).length,
  verifiedFourLayerBridges:bridge.verifiedLinks,verifiedPublicLiveOpsRooms:rooms.filter(r=>r.verifiedPublicLive).length,
  opsSourceLiveCandidates:rooms.filter(r=>r.opsSourceState==='LIVE').length,
  sourceShopJoined:rooms.filter(r=>r.seenInCurrentResponse&&r.opsShopIdentityMatched).length,
  sourceCaptureBound:rooms.filter(r=>r.seenInCurrentResponse&&r.captureBound).length,
  sourceCatalogComplete:sourceReport?.catalogComplete===true,
  missingPriorRoomCount:rooms.filter(r=>!r.seenInCurrentResponse).length,
  conflicts,warnings,
  rooms,formalOpeningRatePercent:null,formalFullDurationRatePercent:null,
  confirmedOfflineOpsRooms:0,exactStartTimesKnown:0,exactEndTimesKnown:0};
}

/** PUBLIC report safe for a PUBLIC repository. Do NOT add room IDs, shops or raw source. */
export function publicDouyinCatalogReceipt(report){
 if(!report||report.schemaVersion!==311||!Array.isArray(report.rooms))throw Error('INVALID_REPORT');
 return {schemaVersion:311,platform:'douyin',mode:'PUBLIC_AGGREGATE_NO_ROOM_IDENTIFIERS',
  sourceCheckedAt:report.sourceCheckedAt,sourceAccess:report.sourceAccess,
  previousObservedMinimum:report.historicalConfirmedMinimum,
  observedSourceRoomsThisRun:report.observedSourceRoomsThisRun,
  retainedPriorRooms:report.retainedPriorRooms,inventoryRows:report.inventoryRows,
  approvedPublicAccounts:report.approvedPublicAccounts,rpaSampledPublicAccounts:report.rpaSampledPublicAccounts,
  publiclyDoubleVerifiedLiveSamples:report.publiclyDoubleVerifiedLiveSamples,
  verifiedFourLayerBridges:report.verifiedFourLayerBridges,
  verifiedPublicLiveOpsRooms:report.verifiedPublicLiveOpsRooms,
  opsSourceLiveCandidates:report.opsSourceLiveCandidates,
  sourceShopJoined:report.sourceShopJoined,sourceCaptureBound:report.sourceCaptureBound,
  sourceCatalogComplete:report.sourceCatalogComplete,
  missingPriorRoomCount:report.missingPriorRoomCount,
  conflictCount:report.conflicts.length,warnings:report.warnings,
  // Ordinals deliberately run-local, not stable identity keys.
  roomReceipts:report.rooms.map((r,i)=>({runLocalOrdinal:i+1,observedThisRun:r.seenInCurrentResponse,
   shopJoin:r.seenInCurrentResponse&&r.opsShopIdentityMatched,captureBound:r.seenInCurrentResponse&&r.captureBound,
   sourceState:r.opsSourceState,publicIdentityVerified:r.identityVerified,
   publicState:r.publicEvidenceState})),
  formalOpeningRatePercent:null,formalFullDurationRatePercent:null,
  exactStartTimesKnown:0,exactEndTimesKnown:0};
}
