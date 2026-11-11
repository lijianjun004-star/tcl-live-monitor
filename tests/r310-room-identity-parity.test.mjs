import test from 'node:test';
import assert from 'node:assert/strict';
import {roomIdentityParity,classifyRoomIdentityGap} from '../probes/r310/room-identity-parity.mjs';
import {runDouyinRpaReadOnly,inspectPublicPage} from '../probes/r37/rpa-safe-douyin.mjs';
const SEC='MS4wLjABAAAAHLgxNf9c59NqJuH9tm5U2L3E1B6bNBehePdI5rKsZ2s';
const P='https://www.douyin.com/user/'+SEC;
const R='https://live.douyin.com/988541363148';
const account={key:'ffalcon-douyin-tv-flagship',accountName:'FFALCON雷鸟电视旗舰店',
 displayDouyinId:'83165143028',profileUrl:P,scopeApproved:true,roomId:'988541363148'};
const ok={httpStatus:200,finalHost:'live.douyin.com',
 title:account.accountName+'的抖音直播间 - 抖音直播',
 metaDescription:'欢迎来到'+account.accountName+'的抖音直播间更多精彩',bodyExcerpt:'直播中'};
test('strict title and description parity means expected original classifier can pass',()=>{
 const r=roomIdentityParity(ok,account);
 assert.equal(r.expectedExactTitle,true);
 assert.equal(r.descExpectedPrefix,true);
 assert.equal(classifyRoomIdentityGap(r),'STRICT_ROOM_IDENTITY_MATCHED');
});
test('title format changed but account description still present is only a diagnostic',()=>{
 const r=roomIdentityParity({...ok,title:'雷鸟电视品牌直播官方'},account);
 assert.equal(r.expectedExactTitle,false);
 assert.equal(r.descExpectedPrefix,true);
 assert.equal(classifyRoomIdentityGap(r),'ROOM_TITLE_FORMAT_CHANGED');
});
test('metadata description absent is identified, no identity promotion',()=>{
 const r=roomIdentityParity({...ok,metaDescription:''},account);
 assert.equal(r.titleContainsExpectedName,true);
 assert.equal(r.descExpectedPrefix,false);
 assert.equal(classifyRoomIdentityGap(r),'ROOM_DESCRIPTION_MISSING');
});
test('metadata text changed is differentiated from absent',()=>{
 const r=roomIdentityParity({...ok,metaDescription:account.accountName+'官方账号'},account);
 assert.equal(classifyRoomIdentityGap(r),'ROOM_DESCRIPTION_PREFIX_CHANGED');
});
test('wrong account name cannot be accepted by accidental room URL',()=>{
 const r=roomIdentityParity({...ok,title:'Other Account的直播间',metaDescription:'其他账号官方直播间'},account);
 assert.equal(r.titleContainsExpectedName,false);
 assert.equal(r.descContainsExpectedName,false);
 assert.equal(classifyRoomIdentityGap(r),'ROOM_ACCOUNT_NAME_MISMATCH_OR_MISSING');
});
test('host mismatch or non-200 cannot create verified room evidence',()=>{
 assert.equal(classifyRoomIdentityGap(roomIdentityParity({...ok,httpStatus:403},account)),'ROOM_ACCESS_NOT_200');
 assert.equal(classifyRoomIdentityGap(roomIdentityParity({...ok,finalHost:'example.com'},account)),'ROOM_HOST_NOT_VERIFIED');
});
test('diagnostic output is limited to known Boolean and lengths, not raw page content',()=>{
 const r=roomIdentityParity({...ok,title:ok.title+' PERSONAL_SECRET',bodyExcerpt:'PRIVATE_COOKIE '+account.displayDouyinId},account);
 const serialized=JSON.stringify(r);
 assert.doesNotMatch(serialized,/PERSONAL_SECRET|PRIVATE_COOKIE|FFALCON雷鸟电视旗舰店/);
 assert.ok(Object.values(r).every(x=>typeof x==='boolean'||typeof x==='number'));
});
test('synthetic realistic browser emits room mismatch but remains UNKNOWN',async()=>{
 const profile={title:account.accountName+'的抖音 - 抖音',
 bodyExcerpt:'抖音号：'+account.displayDouyinId,metaDescription:'',
 douyinIdsInPage:[account.displayDouyinId],
 liveRoomCandidates:[{href:R+'?from=profile',ariaLabel:'正在直播'}],
 rawDomSignal:{totalAnchors:30,liveHostAnchorCount:1,liveLabeledAnchorCount:1,visibleLiveTextMentions:1,domTextLength:550}};
 const room={title:account.accountName+'的抖音直播间 - 抖音直播',
 metaDescription:'',bodyExcerpt:'欢迎来到直播间',
 rawDomSignal:{totalAnchors:40,liveHostAnchorCount:0,visibleLiveTextMentions:1,domTextLength:500}};
 const pages={[P]:profile,[R]:room};
 const browser={async newContext(){return {
  async route(){},
  async newPage(){return {
   current:'',async goto(url){this.current=url;return{status:()=>200}},
   url(){return this.current},async waitForTimeout(){},
   async evaluate(){return pages[this.current]||{}},async close(){},
  }},
  async close(){},
 }},async close(){}};
 const result=await runDouyinRpaReadOnly({config:{douyin:[account]},keys:[account.key],browserFactory:async()=>browser,holdMs:0});
 const o=result.observations[0];
 assert.equal(o.profileIdentityVerified,true);
 assert.equal(o.state,'UNKNOWN');
 assert.equal(o.roomIdentityVerified,false);
 assert.equal(o.roomDiagnosticGap,'ROOM_DESCRIPTION_MISSING');
 assert.equal(o.roomDiagnostics.expectedExactTitle,true);
 assert.equal(o.opsBridgeVerified,false);
 assert.equal(result.formalFullDurationRatePercent,null);
});
test('no guessed LIVE for room title containing expected account but missing description',()=>{
 const m=roomIdentityParity({...ok,metaDescription:''},account);
 assert.equal(m.expectedExactTitle,true);
 assert.equal(m.descExpectedPrefix,false);
 assert.notEqual(classifyRoomIdentityGap(m),'STRICT_ROOM_IDENTITY_MATCHED');
});

test('HTTP200 with zero title+description is incomplete metadata, not account conflict',()=>{
 const d=roomIdentityParity({...ok,title:'',metaDescription:'',bodyExcerpt:'loading...'},account);
 assert.equal(d.pageTitleLength,0);
 assert.equal(d.descriptionPresent,false);
 assert.equal(classifyRoomIdentityGap(d),'ROOM_PUBLIC_METADATA_EMPTY');
});
test('one same-page delayed DOM read can recover room title and description',async()=>{
 const initial={title:'',metaDescription:'',bodyExcerpt:'loading...',rawDomSignal:{domTextLength:10}};
 const recovered={...ok,rawDomSignal:{domTextLength:200,totalAnchors:10}};
 let calls=0;const waits=[];
 const page={
  async goto(){return{status:()=>200}},
  url:()=>R,
  async waitForTimeout(t){waits.push(t)},
  async evaluate(){return (calls++===0)?initial:recovered},
 };
 const r=await inspectPublicPage(page,R,'room',{holdMs:0});
 const d=roomIdentityParity(r,account);
 assert.equal(calls,2);
 assert.deepEqual(waits,[1200]);
 assert.equal(d.roomDomResampled,true);
 assert.equal(classifyRoomIdentityGap(d),'STRICT_ROOM_IDENTITY_MATCHED');
});
test('blank room metadata remains UNKNOWN after resample, not false LIVE',async()=>{
 const page={
  async goto(){return{status:()=>200}},
  url:()=>R,async waitForTimeout(){},
  async evaluate(){return {title:'',metaDescription:'',bodyExcerpt:'loading',rawDomSignal:{domTextLength:7}}}
 };
 const r=await inspectPublicPage(page,R,'room',{holdMs:0});
 const d=roomIdentityParity(r,account);
 assert.equal(d.roomDomResampled,true);
 assert.equal(classifyRoomIdentityGap(d),'ROOM_PUBLIC_METADATA_EMPTY');
 assert.equal(d.expectedExactTitle,false);
});
