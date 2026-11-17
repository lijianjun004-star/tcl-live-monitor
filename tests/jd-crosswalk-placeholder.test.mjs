import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
const d=JSON.parse(fs.readFileSync('config/jd-ops-crosswalk-template.json','utf8'));
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
test('seven unique internal rooms, all identity mappings explicitly unverified',()=>{
 assert.deepEqual(d.jdKnownOpsRooms.map(x=>x.opsInternalRoomId),['1','14','15','16','17','18','19']);
 assert.equal(new Set(d.jdKnownOpsRooms.map(x=>x.opsInternalRoomId)).size,7);
 assert.ok(d.jdKnownOpsRooms.every(x=>x.identityCrosswalkVerified===false));
});
test('jd-19 is only an internal placeholder, not an inferred public account or live session',()=>{
 const r=d.jdKnownOpsRooms.find(x=>x.opsInternalRoomId==='19');
 assert.equal(r.placeholderOnly,true);assert.equal(r.publicJdStoreCandidate,null);
 assert.equal(r.opsInternalShopId,'UNKNOWN_PENDING_API_SHOPS');assert.equal(r.jdPlatformLiveSessionId,'UNKNOWN_DYNAMIC_PER_STREAM');
 assert.equal(r.expectedCategoryInOps,'UNKNOWN_PENDING_VERIFICATION');
 assert.doesNotMatch(JSON.stringify(r),/https?:|mallId|venderId|accountId|scoringEligible/);
});
test('original six candidate rows and Douyin unmapped section retain exact values',()=>{
 assert.equal(digest(d.jdKnownOpsRooms.slice(0,6)),'e43822f120ebc8111e2483530be01b2bbc10041a05affb415ecffa60111f5aae');
 assert.equal(digest(d.douyinUnmappedOpsRows),'9ccacc068433e160cae527b91614d8bb4945309a1f066412d15eb534a4a194c7');
});
