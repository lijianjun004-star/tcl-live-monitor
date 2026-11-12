import test from 'node:test';
import assert from 'node:assert/strict';
import {REVIEW_HEADERS,parsePrivateCSV,auditPrivateBridgeCSV,publicBridgePreflightSummary}
 from '../probes/r313/private-bridge-review.mjs';

const SEC='MS4wLjABAAAAHLgxNf9c59NqJuH9tm5U2L3E1B6bNBehePdI5rKsZ2s';
const mkRoom=i=>({ordinal:i+1,opsRoomId:String(300+i),opsShopId:String(600+i),
 platform:'dy',category:i===2?'家电':'电视',captureBound:i===0,opsShopIdentityMatched:true});
const original={schemaVersion:311,rooms:Array.from({length:10},(_,i)=>mkRoom(i))};
const cfg={douyin:[{key:'ffalcon',profileUrl:'https://www.douyin.com/user/'+SEC,scopeApproved:true}]};
const enc=v=>{const s=String(v??'');return /[",\n\r]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s};
const line=arr=>arr.map(enc).join(',');
const mkRow=(i,overrides={})=>{
 const row={
 '序号':String(i+1),'内部房间ID':String(300+i),'内部店铺ID':String(600+i),
 '来源类目(11-11)':i===2?'未核实':'电视','来源类目(11-07原值)':i===2?'家电':'电视',
 '采集绑定':i===0?'是':'否','第1层 房间→店铺':'VERIFIED(来源接口 11-11)',
 '11-07是否已存在':'是','第2层 店铺→公开账号secUid':'UNVERIFIED',
 '第2层证据(原件位置/截图/导出)':'','第3层 账号→公开直播间ID':'UNVERIFIED',
 '第3层证据':'','第4层 跨系统桥接':'UNVERIFIED','审核人':'',
 '审核时间':'','当前状态':'UNKNOWN','说明':'模拟数据',
 ...overrides};
 return REVIEW_HEADERS.map(k=>row[k]);
};
const makeCSV=(rows=Array.from({length:10},(_,i)=>mkRow(i)), footer=true)=>
 '\uFEFF'+line(REVIEW_HEADERS)+'\r\n'+rows.map(line).join('\r\n')+
 (footer?'\r\n\r\n填写规则,"严格审查后才能填写第2/3/4层"':'');
const audit=(csvText=makeCSV(), opts={})=>auditPrivateBridgeCSV({csvText,sourceDetail:original,registry:cfg,...opts});

test('loads existing 17-column CSV shape with blank line and two-column instruction footer',()=>{
 const rows=parsePrivateCSV(makeCSV());assert.equal(rows.length,11);
 const v=audit();assert.equal(v.privateSheetRoomCount,10);
 assert.equal(v.ignoredInstructionRows,1);assert.equal(v.inputSourceRoomCount,10);
});
test('10 original pairs verified but zero real public links and zero verified bridges',()=>{
 const x=audit();
 assert.equal(x.internalSourcePairsVerified,10);
 assert.equal(x.categoryDifferenceRows,1);
 assert.equal(x.declaredPublicAccounts,0);
 assert.equal(x.rowsReadyForIndependentHumanReview,0);
 assert.equal(x.verifiedCrossSystemBridges,0);assert.equal(x.readyForProduction,false);
 assert.equal(x.conflictedOrIncompleteRows,10);
});
test('an imported CSV LIVE marker cannot promote a private record to LIVE',()=>{
 const r=mkRow(0,{'当前状态':'LIVE','第4层 跨系统桥接':'VERIFIED'});
 const x=audit(makeCSV([r],false));
 assert.equal(x.verifiedCrossSystemBridges,0);
 assert.equal(x.review[0].status,'UNVERIFIED');
 assert.ok(x.review[0].issues.includes('UNSUPPORTED_BRIDGE_VERIFIED_MARKER'));
});
test('already approved public account and proof filenames still require a reviewer',()=>{
 const r=mkRow(0,{
  '第2层 店铺→公开账号secUid':SEC,
  '第2层证据(原件位置/截图/导出)':'private/ops_binding.png',
  '第3层 账号→公开直播间ID':'9999999',
  '第3层证据':'private/room.jpg',
 });
 const x=audit(makeCSV([r],false));
 assert.equal(x.declaredPublicAccounts,1);assert.equal(x.review[0].reviewReady,false);
 assert.equal(x.verifiedCrossSystemBridges,0);
});
test('all fields complete may be ready for independent review, NEVER automatically verified',()=>{
 const r=mkRow(0,{
  '第2层 店铺→公开账号secUid':SEC,
  '第2层证据(原件位置/截图/导出)':'private/ops_binding.png',
  '第3层 账号→公开直播间ID':'9999999',
  '第3层证据':'private/room.jpg','审核人':'审查人','审核时间':'2026-11-12T07:00:00Z',
  '第4层 跨系统桥接':'VERIFIED'
 });
 const x=audit(makeCSV([r],false));
 assert.equal(x.rowsReadyForIndependentHumanReview,1);
 assert.equal(x.review[0].verifiedBridge,false);
 assert.equal(x.verifiedCrossSystemBridges,0);
});
test('fake public secUid fails allowlist, even with matched business name',()=>{
 const r=mkRow(0,{'第2层 店铺→公开账号secUid':'MS4wLjABAAAASomeWrongUidABCDEFGHIJKLMNOPQRST'});
 const x=audit(makeCSV([r],false));
 assert.ok(x.review[0].issues.includes('PUBLIC_ACCOUNT_NOT_APPROVED_OR_INVALID'));
});
test('same public secUid asserted for two internal rooms is collision requiring review',()=>{
 const r0=mkRow(0,{'第2层 店铺→公开账号secUid':SEC});
 const r1=mkRow(1,{'第2层 店铺→公开账号secUid':SEC});
 const x=audit(makeCSV([r0,r1],false));
 assert.ok(x.review[1].issues.includes('PUBLIC_SECUID_LINK_COLLISION'));
});
test('duplicate internal room or shop does not silently pass',()=>{
 const r=mkRow(0),second=mkRow(1,{'内部房间ID':'300','内部店铺ID':'600'});
 const x=audit(makeCSV([r,second],false));
 assert.ok(x.review[1].issues.includes('DUPLICATE_INTERNAL_ROOM'));
 assert.ok(x.review[1].issues.includes('DUPLICATE_INTERNAL_SHOP_REQUIRES_REVIEW'));
});
test('tampered internal shop cannot be accepted as verified L1',()=>{
 const x=audit(makeCSV([mkRow(0,{'内部店铺ID':'999'})],false));
 assert.equal(x.internalSourcePairsVerified,0);
 assert.ok(x.review[0].issues.includes('INTERNAL_SHOP_MISMATCH'));
});
test('JD / invalid source IDs fail validation, never cross-platform join',()=>{
 const rooms=original.rooms.map((r,i)=>i===0?{...r,platform:'jd'}:r);
 assert.throws(()=>audit(makeCSV(),{sourceDetail:{schemaVersion:311,rooms}}),/PRIVATE_SOURCE_IDENTITY_INVALID/);
});
test('invalid numeric livestream ID remains unverified even with explicit text marker',()=>{
 const x=audit(makeCSV([mkRow(0,{'第3层 账号→公开直播间ID':'http://evil.example', '第4层 跨系统桥接':'VERIFIED'})],false));
 assert.ok(x.review[0].issues.includes('PUBLIC_LIVE_ROOM_ID_INVALID'));
 assert.equal(x.verifiedCrossSystemBridges,0);
});
test('malformed CSV, bad header and quote injection fail closed',()=>{
 assert.throws(()=>parsePrivateCSV('a,b\n1,2'),/CSV_SCHEMA_MISMATCH/);
 assert.throws(()=>parsePrivateCSV(makeCSV([mkRow(0)],false)+'"'),/CSV_QUOTE_INVALID|CSV_TRAILING_QUOTE_TEXT/);
 assert.throws(()=>audit(makeCSV([['1','2']],false)),/CSV_ROW_WIDTH_INVALID/);
});
test('embedded comma/linebreak and quotation in note survives CSV parsing',()=>{
 const row=mkRow(0,{'说明':'hello,"quoted"\nnew line'});
 const x=parsePrivateCSV(makeCSV([row],false));
 assert.equal(x.length,1);assert.equal(x[0][16],'hello,"quoted"\nnew line');
});
test('public preflight summary contains aggregate counts ONLY, never private identifiers',()=>{
 const x=audit();const p=publicBridgePreflightSummary(x),s=JSON.stringify(p);
 assert.equal(p.internalSourcePairsVerified,10);
 assert.equal(p.verifiedCrossSystemBridges,0);
 assert.equal(p.readyForProduction,false);
 for(const prop of ['review','privateOpsRoomId','privateOpsShopId','publicSecUid','roomId','roomReceipts'])
  assert.equal(Object.hasOwn(p,prop),false);
 assert.doesNotMatch(s,/some_Private|ffalcon|MS4wLjABAAAA/);
});
test('zero input rows cannot fake prior 10 source rows as present in sheet',()=>{
 const x=audit(makeCSV([],false));
 assert.equal(x.privateSheetRoomCount,0);assert.equal(x.missingSourceRowsInSheet,10);
 assert.equal(x.verifiedCrossSystemBridges,0);
});
