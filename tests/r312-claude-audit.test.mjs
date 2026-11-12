// R3.12 independent audit regressions (Claude). Offline only; synthetic IDs, no internal identifiers.
import test from 'node:test';
import assert from 'node:assert/strict';
import {reconcileDouyinCatalog,publicDouyinCatalogReceipt} from '../probes/r311/douyin-catalog-reconcile.mjs';
import {inspectDouyinCatalog,inspectDouyinHeartbeat} from '../probes/r36/douyin-ops-parity.mjs';

const T0='2026-11-12T05:00:00.000Z';
const rooms=Array.from({length:10},(_,i)=>({roomId:String(500+i),shopId:String(700+i),platform:'douyin',category:'电视',
 opsShopIdentityMatched:true,captureBound:i===0,status:'UNKNOWN',reason:'CAPTURE_UNBOUND'}));
const src=(checkedAt=T0,rs=rooms)=>({platform:'douyin',sourceAccess:'ROOM_CATALOG_RECEIVED',catalogComplete:false,checkedAt,rooms:rs});
const SID='MS4wLjABAAAAHLgxNf9c59NqJuH9tm5U2L3E1B6bNBehePdI5rKsZ2s';
const approved=Array.from({length:12},(_,i)=>({key:'k'+i,profileUrl:'https://www.douyin.com/user/'+SID+(i?'-'+i:''),scopeApproved:true}));
const bridge=[{opsRoomId:'500',opsShopId:'700',publicSecUid:SID,publicLiveRoomId:'9999999',accountKey:'k0',observedAt:T0,reviewApproved:true,
 proofs:['OPS_ROOM_SHOP','PUBLIC_ACCOUNT_ROOM','CROSS_SYSTEM_BRIDGE'].map((kind,i)=>({kind,observedAt:T0,ref:'AUDITREF00'+i}))}];
const live=at=>({accountKey:'k0',checkedAt:at,state:'LIVE',profileIdentityVerified:true,roomIdentityVerified:true,observedRoomId:'9999999'});
const run=(o)=>reconcileDouyinCatalog({approvedAccounts:approved,bridgeEvidence:bridge,...o});

test('a double-verified LIVE sample from 6 days ago is not reported as LIVE now',()=>{
 const v=run({sourceReport:src('2026-11-18T05:00:00.000Z'),rpaObservations:[live('2026-11-12T05:10:00.000Z')]});
 assert.equal(v.verifiedFourLayerBridges,1);assert.equal(v.verifiedPublicLiveOpsRooms,0);
 assert.equal(v.rooms[0].publicEvidenceState,'UNKNOWN');assert.equal(v.rooms[0].publicEvidenceReason,'RPA_LIVE_SAMPLE_STALE_OR_FUTURE');
 assert.equal(v.freshDoubleVerifiedLiveSamples,0);assert.equal(v.rooms.filter(r=>r.opsSourceState==='OFFLINE').length,0);
});
test('a sample 11 minutes old is stale, 9 minutes old is fresh; explicit now wins over source time',()=>{
 const s=[live('2026-11-12T05:01:00.000Z')];
 assert.equal(run({sourceReport:src('2026-11-12T05:12:00.000Z'),rpaObservations:s}).verifiedPublicLiveOpsRooms,0);
 assert.equal(run({sourceReport:src('2026-11-12T05:10:00.000Z'),rpaObservations:s}).verifiedPublicLiveOpsRooms,1);
 assert.equal(run({sourceReport:src('2026-11-12T05:10:00.000Z'),rpaObservations:s,now:'2026-11-12T06:00:00.000Z'}).verifiedPublicLiveOpsRooms,0);
});
test('a sample time-stamped in the future is rejected; source outage evaluates against caller clock',()=>{
 assert.equal(run({sourceReport:src(T0),rpaObservations:[live('2026-11-12T05:30:00.000Z')]}).verifiedPublicLiveOpsRooms,0);
 const prev={platform:'douyin',rooms};
 const v=run({sourceReport:{platform:'douyin',sourceAccess:'UNVERIFIED'},previousInventory:prev,rpaObservations:[live(T0)],now:Date.parse(T0)+60000});
 assert.equal(v.inventoryRows,10);assert.equal(v.verifiedPublicLiveOpsRooms,0); // not seen this run -> no bridge -> never LIVE
});
test('invalid clock or age limit fails closed',()=>{
 assert.throws(()=>run({sourceReport:src(),now:'yesterday'}),/EVALUATION_TIME_INVALID/);
 assert.throws(()=>run({sourceReport:src(),maxLiveSampleAgeMs:86400000}),/LIVE_SAMPLE_AGE_LIMIT_INVALID/);
});
test('public receipt carries the fresh count and still no identifiers',()=>{
 const r=JSON.stringify(publicDouyinCatalogReceipt(run({sourceReport:src('2026-11-18T05:00:00.000Z'),rpaObservations:[live(T0)]})));
 assert.match(r,/"freshDoubleVerifiedLiveSamples":0/);assert.ok(!/roomId|shopId|secUid|9999999|"500"/.test(r));
});
test('real source category 家电 is kept; an unknown category is still 未核实',()=>{
 const c=inspectDouyinCatalog({ok:true,rooms:[{id:501,platform:'douyin',shop_id:701,category:'家电'},{id:502,platform:'douyin',shop_id:702,category:'<script>'}]});
 assert.deepEqual(c.rooms.map(r=>r.category),['家电','未核实']);
});
test('same number on JD and Douyin never merges; JD heartbeat never feeds a Douyin room',()=>{
 const c=inspectDouyinCatalog({ok:true,rooms:[{id:21,platform:'jd',shop_id:21},{id:21,platform:'douyin',shop_id:21},{id:22,platform:'jd',shop_id:22}]});
 assert.equal(c.rooms.length,1);assert.equal(c.sourceReportedItems,3);assert.equal(c.catalogComplete,false);
 assert.equal(inspectDouyinHeartbeat({rooms:[{id:21,platform:'jd',last_heartbeat_at:T0},{id:21,last_heartbeat_at:T0}]}).size,0);
});
test('17 source rows with 10 Douyin + 2 RPA samples + 12 approved accounts stay three separate counts',()=>{
 const v=run({sourceReport:src(),bridgeEvidence:[],rpaObservations:[live(T0),{...live(T0),accountKey:'k1'}]});
 assert.deepEqual([v.inventoryRows,v.approvedPublicAccounts,v.rpaSampledPublicAccounts,v.verifiedFourLayerBridges],[10,12,2,0]);
 assert.equal(v.formalOpeningRatePercent,null);assert.equal(v.formalFullDurationRatePercent,null);
});
