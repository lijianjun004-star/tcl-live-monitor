import test from 'node:test';
import assert from 'node:assert/strict';
import {reconcileDouyinCatalog,publicDouyinCatalogReceipt} from '../probes/r311/douyin-catalog-reconcile.mjs';

const AT='2026-11-12T07:00:00Z';
const fakeRooms=Array.from({length:10},(_,i)=>({
 roomId:String(900+i),shopId:String(500+i),platform:'dy',
 category:i%2===0?'电视':'家电',captureBound:i===0,
 opsShopIdentityMatched:true,status:'UNKNOWN',reason:'CAPTURE_UNBOUND'
}));
const input={
 sourceReport:{platform:'douyin',sourceAccess:'ROOM_CATALOG_RECEIVED',
  checkedAt:AT,catalogComplete:false,rooms:fakeRooms},
 approvedAccounts:[],
 rpaObservations:[],
};
function receipt(x=input){return publicDouyinCatalogReceipt(reconcileDouyinCatalog(x))}
test('public receipt never contains ID-order-derived room ordinal arrays',()=>{
 const r=receipt();
 assert.equal(r.inventoryRows,10);
 assert.equal(r.roomRowsSuppressedForPrivacy,true);
 assert.equal(r.aggregateOnly,true);
 assert.ok(!('roomReceipts' in r));
 assert.equal(Object.values(r).some(v=>Array.isArray(v)&&v.some(y=>typeof y==='object')),false);
});
test('public receipt cannot expose raw business, room, source name or session values',()=>{
 const r=receipt({...input,sourceReport:{...input.sourceReport,rooms:fakeRooms.map(x=>({
   ...x,rawPrivateSecret:'RAW_ACCOUNT_PRIVATE_999',shopName:'PRIVATE_SHOP',
   bound_session_key:'PRIVATE_SESSION_KEY',operatorName:'PRIVATE_OPERATOR_NAME'
 }))}});
 const s=JSON.stringify(r);
 for(const t of ['RAW_ACCOUNT_PRIVATE_999','PRIVATE_SHOP','PRIVATE_SESSION_KEY','PRIVATE_OPERATOR_NAME',
  'roomId','shopId','publicAccountKey','runLocalOrdinal','900','901','909'])assert.ok(!s.includes('"'+t+'"'),t);
});
test('public aggregate count independent of internal source room id ordering',()=>{
 const x=receipt();
 const y=receipt({...input,sourceReport:{...input.sourceReport,rooms:[...fakeRooms].reverse()}});
 assert.deepEqual(x,y);
});
test('a reduced eight-room source is reported with warning and no private IDs',()=>{
 const r=receipt({...input,sourceReport:{...input.sourceReport,rooms:fakeRooms.slice(0,8)}});
 assert.equal(r.inventoryRows,8);
 assert.ok(r.warnings.includes('BELOW_PRIOR_OBSERVED_10_BASELINE_NOT_PROOF_OF_DELETION'));
 assert.ok(!('roomReceipts' in r));
 assert.equal(r.formalOpeningRatePercent,null);
});
test('source outage still carries UNKNOWN semantics, not LIVE or zero evidence',()=>{
 const r=receipt({...input,sourceReport:{platform:'douyin',sourceAccess:'UNAVAILABLE'},
  previousInventory:{platform:'douyin',rooms:fakeRooms}});
 assert.equal(r.inventoryRows,10);assert.equal(r.observedSourceRoomsThisRun,0);
 assert.ok(r.warnings.includes('SOURCE_UNAVAILABLE_PREVIOUS_ROOMS_RETAINED_UNKNOWN'));
 assert.equal(r.verifiedPublicLiveOpsRooms,0);
});
test('source category is not automatically corrected using an unverified historical category',()=>{
 const normalized=receipt();
 assert.equal(normalized.inventoryRows,10);
 assert.ok(!('categories' in normalized)); // private category breakdown not exposed
});
