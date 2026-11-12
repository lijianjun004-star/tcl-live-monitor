import test from 'node:test';
import assert from 'node:assert/strict';
import {reconcileDouyinCatalog,publicDouyinCatalogReceipt} from '../probes/r311/douyin-catalog-reconcile.mjs';
const date='2026-11-11T14:30:00.000Z';
const rooms=Array.from({length:10},(_,i)=>({roomId:String(100+i),shopId:String(300+i),platform:'dy',category:'电视',
 opsShopIdentityMatched:true,captureBound:i===0,status:i===0?'LIVE':'UNKNOWN',reason:'SOURCE_UNVERIFIED'}));
const source=(rs=rooms)=>({platform:'douyin',sourceAccess:'ROOM_CATALOG_RECEIVED',catalogComplete:false,checkedAt:date,rooms:rs});
const SID='MS4wLjABAAAAHLgxNf9c59NqJuH9tm5U2L3E1B6bNBehePdI5rKsZ2s';
const account=i=>({key:'a'+i,profileUrl:'https://www.douyin.com/user/'+SID+(i===0?'':'-'+i),scopeApproved:true,scoringEligible:i<4});
const approved=Array.from({length:12},(_,i)=>account(i));
const sample=(key,at=date,room='9999999')=>({accountKey:key,checkedAt:at,state:'LIVE',
 profileIdentityVerified:true,roomIdentityVerified:true,observedRoomId:room});
const build=(options={})=>reconcileDouyinCatalog({sourceReport:source(),approvedAccounts:approved,
 rpaObservations:[sample('a0'),sample('a1')],...options});
const threeProofs=(at=date)=>[
 {kind:'OPS_ROOM_SHOP',observedAt:at,ref:'SOURCEOPS123456'},
 {kind:'PUBLIC_ACCOUNT_ROOM',observedAt:at,ref:'PUBLICROOM12345'},
 {kind:'CROSS_SYSTEM_BRIDGE',observedAt:at,ref:'MANUALREVIEW12345'},
];
const bridge=(roomId='100',room='9999999')=>({opsRoomId:roomId,opsShopId:'300',publicSecUid:SID,publicLiveRoomId:room,
 accountKey:'a0',observedAt:date,reviewApproved:true,proofs:threeProofs()});

test('10 OPS + 12 approved public accounts + 2 RPA samples remain separate metrics',()=>{
 const v=build();assert.equal(v.observedSourceRoomsThisRun,10);assert.equal(v.inventoryRows,10);
 assert.equal(v.approvedPublicAccounts,12);assert.equal(v.rpaSampledPublicAccounts,2);
 assert.equal(v.verifiedFourLayerBridges,0);assert.equal(v.verifiedPublicLiveOpsRooms,0);
 assert.equal(v.opsSourceLiveCandidates,1);assert.equal(v.sourceShopJoined,10);
 assert.equal(v.sourceCaptureBound,1);assert.equal(v.rooms.length,10);
 assert.equal(v.formalOpeningRatePercent,null);assert.equal(v.formalFullDurationRatePercent,null);
});
test('RPA sampling 0 or 2 does not shrink 10 source rows',()=>{
 assert.equal(build({rpaObservations:[]}).rooms.length,10);
 assert.equal(build({rpaObservations:[sample('a0')]}).rooms.length,10);
 assert.equal(build({rpaObservations:[]}).rpaSampledPublicAccounts,0);
});
test('source response with 8 rooms warns but never invents other 2 IDs',()=>{
 const v=build({sourceReport:source(rooms.slice(0,8))});
 assert.equal(v.inventoryRows,8);assert.equal(v.observedSourceRoomsThisRun,8);
 assert.ok(v.warnings.includes('BELOW_PRIOR_OBSERVED_10_BASELINE_NOT_PROOF_OF_DELETION'));
 assert.ok(v.warnings.includes('MISSING_PREVIOUS_ROOM_IDENTIFIERS_CANNOT_RECONSTRUCT_FROM_COUNT'));
});
test('prior real 10 are retained as UNKNOWN when latest source lists 8',()=>{
 const v=build({previousInventory:build(),sourceReport:source(rooms.slice(0,8))});
 assert.equal(v.inventoryRows,10);assert.equal(v.retainedPriorRooms,2);assert.equal(v.missingPriorRoomCount,2);
 assert.ok(v.rooms.filter(x=>!x.seenInCurrentResponse).every(x=>x.opsSourceState==='UNKNOWN'));
});
test('unavailable source retains prior 10 with UNKNOWN and warning',()=>{
 const v=build({previousInventory:build(),sourceReport:{sourceAccess:'UNVERIFIED',rooms:[]}});
 assert.equal(v.inventoryRows,10);assert.equal(v.observedSourceRoomsThisRun,0);
 assert.ok(v.rooms.every(x=>x.opsSourceState==='UNKNOWN'));
 assert.ok(v.warnings.includes('SOURCE_UNAVAILABLE_PREVIOUS_ROOMS_RETAINED_UNKNOWN'));
});
test('unavailable source without prior list cannot invent 10 room IDs',()=>{
 const v=build({sourceReport:null});assert.equal(v.inventoryRows,0);
 assert.ok(v.warnings.includes('MISSING_PREVIOUS_ROOM_IDENTIFIERS_CANNOT_RECONSTRUCT_FROM_COUNT'));
});
test('cross-platform JD room fails closed rather than joining same numeric ID',()=>{
 assert.throws(()=>build({sourceReport:source([...rooms,{roomId:'110',shopId:'2',platform:'jd'}])}),/NEW_CATALOG_INVALID_OR_DUPLICATE/);
});
test('duplicate OPS room ID rejects catalog',()=>{
 assert.throws(()=>build({sourceReport:source([...rooms,rooms[0]])}),/DUPLICATE/);
});
test('conflicted shop mapping does not silently update or match',()=>{
 const changed=rooms.map((r,i)=>i===0?{...r,shopId:'987'}:r);
 const v=build({sourceReport:source(changed),previousInventory:build()});
 assert.equal(v.conflicts.length,1);assert.equal(v.rooms[0].shopId,'300');
 assert.equal(v.rooms[0].opsSourceState,'UNKNOWN');assert.equal(v.rooms[0].identityVerified,false);
});
test('public double-LIVE without reviewed identity bridge never promotes OPS',()=>{
 const v=build();assert.equal(v.publiclyDoubleVerifiedLiveSamples,2);
 assert.equal(v.verifiedPublicLiveOpsRooms,0);assert.ok(v.rooms.every(r=>!r.identityVerified));
});
test('approved bridge, fresh matching public room may join ONE internal room only',()=>{
 const v=build({bridgeEvidence:[bridge()]});
 assert.equal(v.verifiedFourLayerBridges,1);assert.equal(v.verifiedPublicLiveOpsRooms,1);
 assert.equal(v.rooms[0].publicAccountKey,'a0');assert.equal(v.rooms[0].verifiedPublicLive,true);
 assert.ok(v.rooms.slice(1).every(r=>!r.identityVerified));assert.equal(v.formalOpeningRatePercent,null);
});
test('wrong public room ID cannot become confirmed LIVE',()=>{
 const v=build({bridgeEvidence:[bridge('100','8888888')]});
 assert.equal(v.verifiedFourLayerBridges,1);assert.equal(v.verifiedPublicLiveOpsRooms,0);
});
test('without prior human review no cross-source bridge exists',()=>{
 const v=build({bridgeEvidence:[{...bridge(),reviewApproved:false}]});assert.equal(v.verifiedFourLayerBridges,0);
});
test('outdated public sample does not validate OPS room today',()=>{
 const v=build({bridgeEvidence:[bridge()],rpaObservations:[sample('a0','2026-11-20T10:00:00Z')]});
 assert.equal(v.verifiedFourLayerBridges,1);assert.equal(v.verifiedPublicLiveOpsRooms,0);
});
test('prior LIVE room absent this run must revert to UNKNOWN, not OFFLINE',()=>{
 const v=build({sourceReport:source(rooms.slice(1)),previousInventory:build()});
 assert.equal(v.rooms.find(x=>x.roomId==='100').opsSourceState,'UNKNOWN');
});
test('public receipt excludes all private IDs, credentials and account joins',()=>{
 const v=build();v.rooms[0].secret='PRIVATE_COOKIE_DO_NOT_PRINT';
 const receipt=publicDouyinCatalogReceipt(v),s=JSON.stringify(receipt);
 assert.equal(receipt.roomRowsSuppressedForPrivacy,true);assert.equal(receipt.aggregateOnly,true);
 assert.doesNotMatch(s,/PRIVATE_COOKIE_DO_NOT_PRINT|"roomId"|"shopId"|"publicLiveRoomId"|"publicAccountKey"/);
 assert.ok(!('roomReceipts' in receipt));assert.equal(receipt.inventoryRows,10);
});
test('invalid source rows rejected and unapproved account cannot bridge',()=>{
 assert.throws(()=>build({sourceReport:source([{...rooms[0],roomId:'javascript:'}])}),/INVALID/);
 const v=build({approvedAccounts:[{...approved[0],scopeApproved:false}],bridgeEvidence:[bridge()]});
 assert.equal(v.approvedPublicAccounts,0);assert.equal(v.verifiedFourLayerBridges,0);
});
test('10 source records do not prove exhaustive catalog',()=>{
 const v=build();assert.equal(v.sourceCatalogComplete,false);
 assert.ok(v.warnings.includes('CATALOG_CENSUS_NOT_PROVEN_EXHAUSTIVE'));
});
test('partial response does not prove OFFLINE or precise start and end times',()=>{
 const v=build({sourceReport:source(rooms.slice(0,3))});
 assert.equal(v.confirmedOfflineOpsRooms,0);assert.equal(v.exactStartTimesKnown,0);
 assert.equal(v.exactEndTimesKnown,0);assert.equal(v.formalOpeningRatePercent,null);
});
test('invalid baseline and input fail instead of silently changing totals',()=>{
 assert.throws(()=>build({historicalConfirmedMinimum:-1}),/BASELINE_INVALID/);
 assert.throws(()=>build({approvedAccounts:null}),/INVALID_RECONCILE_INPUT/);
});
