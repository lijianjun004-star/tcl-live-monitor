import test from 'node:test';
import assert from 'node:assert/strict';
import {candidateSignals,buildPrivateShopAccountCandidates,safePublicCandidateCounts} from '../probes/r314/shop-account-candidates.mjs';

const S='MS4wLjABAAAAHLgxNf9c59NqJuH9tm5U2L3E1B6bNBehePdI5rKsZ2s';
const account=(key,name,uid=S)=>({key,accountName:name,profileUrl:'https://www.douyin.com/user/'+uid,scopeApproved:true});
const source=(names=['TCL官方旗舰店电视直播间','TCL电视总部授权直播间','TCL大家电官方旗舰店'])=>names.map((shopNameHint,i)=>({
  opsRoomId:String(200+i),opsShopId:String(500+i),platform:'dy',
  shopNameHint,normalizedCategory:i===2?'家电':'电视',
  latestRawCategory:i===2?'家电':'电视',shopRecordPresent:true,captureBound:i===0
}));
const registry=[
 account('flagship','TCL官方旗舰店'),
 account('tv','TCL旗舰店电视直播间',S+'-1'),
 account('ac','TCL空调官方旗舰店',S+'-2'),
 account('other','雷鸟电视旗舰店',S+'-3')
];
const run=(rows=source(),approvedAccounts=registry)=>buildPrivateShopAccountCandidates({sourceRows:rows,approvedAccounts});

test('exact shop/account name produces a NAME candidate, not identity verification',()=>{
 const x=candidateSignals('TCL电视官方旗舰店','TCL电视官方旗舰店','电视');
 assert.equal(x.nameExact,true);
 assert.equal(x.score,100);
 assert.equal(x.reason,'EXACT_SHOP_ACCOUNT_NAME');
});
test('brand-only overlap cannot establish a candidate',()=>{
 const x=candidateSignals('TCL','TCL电视官方旗舰店','电视');
 assert.equal(x.suggested,false);
});
test('stronger name leads are bounded, and all remain UNVERIFIED',()=>{
 const r=run();
 assert.equal(r.sourceOpsRooms,3);
 assert.equal(r.approvedPublicAccounts,4);
 assert.equal(r.verifiedFourLayerBridges,0);
 assert.equal(r.formalOpeningRatePercent,null);
 assert.ok(r.suggestedPairs<=9);
 for(const row of r.rows)for(const c of row.candidates){
  assert.equal(c.identityStatus,'UNVERIFIED');
  assert.equal(c.reviewApproved,false);
  assert.equal(c.liveStatus,'UNKNOWN');
  assert.equal(c.externalBridgeProof,null);
 }
});
test('similar names cannot promote LIVE and do not create a cross-system join',()=>{
 const r=run();
 assert.ok(r.rows.every(x=>x.verifiedCrossSystemLinks===0));
 assert.ok(r.rows.every(x=>x.candidates.every(y=>y.observedRoomId===null)));
});
test('a household appliance source shop cannot be silently made a TV room',()=>{
 const x=candidateSignals('TCL大家电官方旗舰店','TCL电视官方旗舰店','家电');
 assert.equal(x.categoryConflict,true);
 assert.equal(x.nameExact,false);
});
test('source room/shop IDs are distinct from Douyin public room IDs',()=>{
 const r=run();
 assert.equal(r.rows[0].opsRoomId,'200');
 assert.equal(r.rows[0].opsShopId,'500');
 assert.ok(r.rows[0].candidates.every(x=>x.publicSecUid!==r.rows[0].opsRoomId));
});
test('duplicate source room ID rejects input, never dedupes and loses a record',()=>{
 const s=source();assert.throws(()=>run([...s,s[0]]),/SOURCE_DUPLICATE_IDENTITY/);
});
test('cross-platform JD row must not enter Douyin candidate report',()=>{
 assert.throws(()=>run([{...source()[0],platform:'jd'}]),/SOURCE_INTERNAL_IDENTITY_INVALID/);
});
test('duplicate shop ID blocks silent reassignment to second room',()=>{
 const s=source();assert.throws(()=>run([s[0],{...s[1],opsShopId:s[0].opsShopId}]),/SOURCE_DUPLICATE_IDENTITY/);
});
test('unapproved and malformed public profiles cannot enter any suggestion',()=>{
 const u={...registry[0],scopeApproved:false};
 const p=run(source(),[u]);
 assert.equal(p.approvedPublicAccounts,0);
 assert.equal(p.suggestedPairs,0);
 assert.throws(()=>run(source(),[{...registry[0],profileUrl:'https://www.douyin.com.evil.test/user/'+S}]),/APPROVED_PROFILE_NOT_VERIFIED/);
});
test('public audit receipt includes counts only, never ID, names, secUid, or ordered rows',()=>{
 const p=run();
 const o=safePublicCandidateCounts(p);
 assert.equal(o.sourceOpsRooms,3);
 assert.equal(o.recordsOmittedBecausePrivate,true);
 for(const field of ['rows','roomId','opsRoomId','opsShopId','shopNameHint','accountName','publicSecUid']) assert.ok(!(field in o));
 const s=JSON.stringify(o);
 assert.doesNotMatch(s,/TCL|MS4wLjABAAAA|"200"|"500"|shopName|accountKey/);
});
test('two completely different names with shared TCL brand alone provide no positive evidence',()=>{
 const a=candidateSignals('TCL冰箱家电专场','TCL电视官方旗舰店','冰箱');
 assert.notEqual(a.reason,'EXACT_SHOP_ACCOUNT_NAME');
 assert.equal(a.nameExact,false);
});
test('candidate scoring is deterministic across repeated source reads',()=>{
 assert.deepEqual(run(),run());
});
test('bounded top candidates and registry sizes reject abusive inputs',()=>{
 assert.throws(()=>buildPrivateShopAccountCandidates({sourceRows:source(),approvedAccounts:registry,maxCandidatesPerShop:0}),/CANDIDATE_LIMIT_INVALID/);
 assert.throws(()=>buildPrivateShopAccountCandidates({sourceRows:source(),approvedAccounts:registry,maxCandidatesPerShop:99}),/CANDIDATE_LIMIT_INVALID/);
});

test('TCL official source must never be paired to FFALCON RayNeo by generic TV words',()=>{
 for(const candidate of ['FFALCON雷鸟电视旗舰店','RayNeo雷鸟创新']){
  const r=candidateSignals('TCL电视机官方旗舰店',candidate,'电视');
  assert.equal(r.suggested,false);assert.equal(r.reason,'BRAND_FAMILY_MISMATCH_NAME_ONLY');
 }
});
test('source official flagship never suggests unrelated TCL dealer by generic brand or shop name',()=>{
 const r=candidateSignals('TCL家电官方旗舰店','TCL富世新家电智选店','家电');
 assert.equal(r.suggested,false);
 assert.equal(r.reason,'SOURCE_OFFICIAL_VS_PUBLIC_DEALER');
});
test('brand family exclusion preserves genuine same-brand name-only leads',()=>{
 const r=candidateSignals('TCL官方旗舰店电视直播间','TCL旗舰店电视直播间','电视');
 assert.equal(r.suggested,true);
 assert.notEqual(r.reason,'BRAND_FAMILY_MISMATCH_NAME_ONLY');
});
