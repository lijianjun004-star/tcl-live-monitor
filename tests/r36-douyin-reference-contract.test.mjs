import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
 parseProvidedReferenceUrl,buildApprovedDouyinRegistry,reconcileReferenceShopRows,
 projectDouyinGuestObservation,observedSessionWindows
} from '../probes/r36/douyin-reference-contract.mjs';

const conf=JSON.parse(fs.readFileSync(new URL('../config/probe-targets.json',import.meta.url),'utf8'));
const approved=buildApprovedDouyinRegistry(conf);
const target=approved.find(a=>a.key==='tcl-douyin-flagship');
const profile=(anchor=true)=>({
 httpStatus:200,title:target.accountName+'的抖音 - 抖音',
 bodyExcerpt:'抖音号：'+target.displayDouyinId,
 douyinIdsInPage:[target.displayDouyinId],
 liveRoomAnchors:anchor?[{href:'https://live.douyin.com/'+target.configuredRoomId,text:'直播中'}]:[]
});
const room=(changes={})=>({
 httpStatus:200,title:target.accountName+'的抖音直播间 - 抖音直播',
 metaDescription:'欢迎来到'+target.accountName+'的抖音直播间',
 bodyExcerpt:'',statusFields:[],...changes
});
const sample=(when,status='LIVE',rid=target.configuredRoomId)=>({
 platform:'douyin',accountKey:target.key,checkedAt:when,
 state:status,observedRoomId:rid
});

test('provided IP URL really points to JD, not Douyin',()=>{
 const r=parseProvidedReferenceUrl('http://101.96.215.251/?start=2026-10-21&end=2026-10-21&platform=jd&category=%E5%85%A8%E5%93%81%E7%B1%BB&shop_id=17');
 assert.equal(r.platform,'jd');
 assert.equal(r.internalShopId,'17');
 assert.equal(r.category,'全品类');
 assert.equal(r.from,'2026-10-21');
 assert.equal(r.sourceVerified,true);
 assert.equal(r.internalApiSchemaVerified,false);
});
test('DOUYIN query variants are hypotheses, not verified source routes',()=>{
 for(const platform of ['dy','douyin']){
  const r=parseProvidedReferenceUrl('http://101.96.215.251/?start=2026-10-21&end=2026-10-21&platform='+platform);
  assert.equal(r.sourceVerified,false);
  assert.match(r.platformInterpretation,/hypothesis only/);
 }
});
test('reference parser rejects fabricated API keys, invalid dates and other hosts',()=>{
 const base='http://101.96.215.251/?start=2026-10-21&end=2026-10-21&platform=jd';
 for(const bad of [
   base+'&account=999',base.replace('2026-10-21','2026-02-30'),
   base.replace('platform=jd','platform=unknown'),
   base.replace('101.96.215.251','localhost'),
   base+'&shop_id=0',base+'&shop_id=%3Cscript%3E'
 ])assert.throws(()=>parseProvidedReferenceUrl(bad));
});
test('approved registry loaded directly from actual repository config; no invented accounts',()=>{
 assert.equal(approved.length,conf.douyin.length);
 assert.ok(approved.length>=4);
 assert.equal(approved.filter(a=>a.scoringEligible).length,4);
 assert.equal(new Set(approved.map(a=>a.secUid)).size,approved.length);
 assert.ok(approved.every(a=>a.scopeApproved&&a.profileUrl.includes(a.secUid)));
});
test('registry rejects duplicated account and unapproved target',()=>{
 assert.throws(()=>buildApprovedDouyinRegistry({douyin:[conf.douyin[0],conf.douyin[0]]}),/DUPLICATE/);
 assert.throws(()=>buildApprovedDouyinRegistry({douyin:[{...conf.douyin[0],scopeApproved:false}]}),/UNAPPROVED/);
});
test('source internal shop_id never becomes Douyin room ID',()=>{
 const matches=reconcileReferenceShopRows([{shop_id:17,secUid:target.secUid,displayDouyinId:target.displayDouyinId}],approved);
 assert.equal(matches[0].identity,'MATCHED_CANDIDATE');
 assert.equal(matches[0].internalShopId,'17');
 assert.equal(matches[0].accountKey,target.key);
 assert.match(matches[0].reason,/SHOP_OWNERSHIP_NOT_PROVEN/);
 assert.notEqual(target.configuredRoomId,'17');
});
test('only shop name or internal ID must not be treated as identity proof',()=>{
 const rows=reconcileReferenceShopRows([{shop_id:17,shopName:target.accountName}],approved);
 assert.equal(rows[0].identity,'UNVERIFIED');
 assert.equal(rows[0].reason,'NO_EXACT_PLATFORM_IDENTITY');
});
test('conflicting account ID and secUid cannot be silently joined',()=>{
 const second=approved.find(x=>x.key!==target.key);
 const rows=reconcileReferenceShopRows([{shop_id:17,secUid:target.secUid,displayDouyinId:second.displayDouyinId}],approved);
 assert.equal(rows[0].identity,'CONFLICT');
 assert.equal(rows[0].accountKey,null);
});
test('unapproved unmapped rows remain separate; never scored',()=>{
 const rows=reconcileReferenceShopRows([{shop_id:27,secUid:'MS4wLjABAAAAxxxxxxxxxxxxxxxxxxxx',displayDouyinId:'not-in-roster'}],approved);
 assert.equal(rows[0].scoringEligible,false);
 assert.equal(rows[0].accountKey,null);
});
test('verified public profile and matching live room yield LIVE but not precise duration',()=>{
 const r=projectDouyinGuestObservation({account:target,profile:profile(),room:room(),checkedAt:'2026-11-11T11:20:00.000Z'});
 assert.equal(r.state,'LIVE');
 assert.equal(r.profileIdentityVerified,true);
 assert.equal(r.roomIdentityVerified,true);
 assert.equal(r.formalDurationRate,null);
 assert.equal(r.exactStartAt,null);
});
test('no LIVE badge is UNKNOWN; never infer OFFLINE',()=>{
 const r=projectDouyinGuestObservation({account:target,profile:profile(false),room:room(),checkedAt:'2026-11-11T11:20:00.000Z'});
 assert.equal(r.state,'UNKNOWN');
 assert.equal(r.offlineCandidate,false);
});
test('ended text and passive status without verified rule remain UNKNOWN candidate',()=>{
 const r=projectDouyinGuestObservation({account:target,profile:profile(false),
 room:room({bodyExcerpt:'主播已下播',statusFields:[{field:'$.data.data.status',value:4}]}),
 checkedAt:'2026-11-11T11:20:00.000Z'});
 assert.equal(r.state,'UNKNOWN');
 assert.equal(r.offlineCandidate,true);
});
test('challenge or wrong account identity becomes UNKNOWN',()=>{
 const p={...profile(),title:'验证码中间页'};
 assert.equal(projectDouyinGuestObservation({account:target,profile:p,room:room(),checkedAt:'2026-11-11T11:20:00.000Z'}).state,'UNKNOWN');
 assert.throws(()=>projectDouyinGuestObservation({account:{...target,scopeApproved:false},profile:p,room:room(),checkedAt:'2026-11-11T11:20:00.000Z'}),/TARGET_NOT_APPROVED/);
});
test('changed room ID is observed without inventing a new broadcast start',()=>{
 const p=profile();p.liveRoomAnchors=[{href:'https://live.douyin.com/99999999999',text:'直播中'}];
 const r=projectDouyinGuestObservation({account:target,profile:p,room:room(),checkedAt:'2026-11-11T11:20:00.000Z'});
 assert.equal(r.state,'LIVE');
 assert.equal(r.roomIdChanged,true);
 assert.equal(r.exactStartAt,null);
});
test('UNKNOWN gaps never create OFFLINE or exact stop times',()=>{
 const records=[
 sample('2026-11-11T11:00:00.000Z'),
 sample('2026-11-11T11:05:00.000Z','UNKNOWN'),
 sample('2026-11-11T11:10:00.000Z')
 ];
 const r=observedSessionWindows(records);
 assert.equal(r.length,1);
 assert.equal(r[0].samples,2);
 assert.equal(r[0].hasUnknownGap,true);
 assert.equal(r[0].exactEndAt,null);
 assert.equal(r[0].firstLiveObservedAt,records[0].checkedAt);
});
test('room ID change does not by itself split continuous observation into two sessions',()=>{
 const r=observedSessionWindows([
 sample('2026-11-11T11:00:00.000Z','LIVE','123456789'),
 sample('2026-11-11T11:05:00.000Z','LIVE','999999999')
 ]);
 assert.equal(r.length,1);
 assert.equal(r[0].roomIdChangeObserved,true);
});
