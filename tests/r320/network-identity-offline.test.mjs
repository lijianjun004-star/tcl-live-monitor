// Gemini R3.19 independent review -> R3.20 offline regression suite.
// No actual Douyin URLs are fetched in these tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { isAccessGate, denyGateResource, inspectHttpResponse, guardedRoute } from '../../probes/r320/network-guard.mjs';
import { liveAnchorScope, decideDouyin } from '../../probes/lib/douyin.mjs';

test('P1-1: access gate subdomains, query, path and case are explicitly rejected',()=>{
  for(const u of [
    'https://sso.douyin.com/',
    'https://login.douyin.com/',
    'https://verify.douyin.com/',
    'https://www.douyin.com/?login=1&captcha=1',
    'https://www.douyin.com/passport/web/login',
    'https://www.douyin.com/a?next=%2Fverify%2Fcaptcha'
  ])assert.equal(isAccessGate(u),true,u);
  assert.equal(isAccessGate('https://www.douyin.com/user/APPROVED_PUBLIC_PATH'),false);
  assert.equal(denyGateResource({url:'https://sso.douyin.com/',method:'GET',resourceType:'document'}).allow,false);
});
test('P1-1: missing Location, opaque 3xx and 401/403/429 always stop',()=>{
  assert.equal(inspectHttpResponse(302,{location:''}),'REDIRECT_LOCATION_INVALID');
  assert.equal(inspectHttpResponse(302,{}),'REDIRECT_LOCATION_INVALID');
  assert.equal(inspectHttpResponse(302,{location:'https://sso.douyin.com/'}),'HTTP_REDIRECT_BLOCKED');
  assert.equal(inspectHttpResponse(301,{location:'https://www.douyin.com/'}),'HTTP_REDIRECT_BLOCKED');
  assert.equal(inspectHttpResponse(304,{}),'HTTP_NOT_MODIFIED_UNEXPECTED');
  for(const code of [401,403,429])assert.equal(inspectHttpResponse(code,{}),'HTTP_'+code);
  assert.equal(inspectHttpResponse(200,{}),null);
});
function fakeRoute({status=200,location=null,fail=false}={}){
 const marks={fetch:0,fulfill:0,abort:0};
 const route={
   request:()=>({url:()=> 'https://lf-douyin-pc-web.douyinstatic.com/test.js',
     method:()=> 'GET',resourceType:()=> 'script'}),
   fetch:async options=>{
     marks.fetch++;
     assert.equal(options.maxRedirects,0);
     assert.equal(options.maxRetries,0);
     if(fail)throw Error('SIMULATED_ROUTED_FETCH_FAILURE');
     return {status:()=>status,headers:()=>location?{location}:{}};
   },
   fulfill:async ({response})=>{marks.fulfill++;assert.equal(response.status(),200)},
   abort:async ()=>{marks.abort++},
   continue:async()=>{throw Error('NEVER_CALL_ROUTE_CONTINUE')},
 };
 return {route,marks};
}
test('P1-2: the permitted first-hop 200 is fulfilled without calling browser route.continue',async()=>{
  const {route,marks}=fakeRoute();
  const result=await guardedRoute(route,{approvedCoreStatic:true});
  assert.equal(result.decision,'FULFILLED');
  assert.deepEqual(marks,{fetch:1,fulfill:1,abort:0});
});
test('P1-2: first-hop 302 is never exposed to Chromium and it never starts a second hop',async()=>{
  const {route,marks}=fakeRoute({status:302,location:'https://tracker.example/pixel.gif'});
  let reason=null;
  const result=await guardedRoute(route,{approvedCoreStatic:true,stop:s=>{reason=s}});
  assert.equal(result.decision,'STOP');
  assert.equal(reason,'HTTP_REDIRECT_BLOCKED');
  assert.deepEqual(marks,{fetch:1,fulfill:0,abort:1});
});
test('P1-2: a missing Location and HTTP 403 stop immediately; no retry',async()=>{
  for(const status of [302,403]){
    const {route,marks}=fakeRoute({status});
    const result=await guardedRoute(route,{approvedCoreStatic:true});
    assert.equal(result.decision,'STOP');
    assert.deepEqual(marks,{fetch:1,fulfill:0,abort:1});
  }
});
test('P1-2: route.fetch network exception fails closed; no fallback or retries',async()=>{
  const {route,marks}=fakeRoute({fail:true});
  let stopped=null;
  assert.equal((await guardedRoute(route,{approvedCoreStatic:true,stop:s=>stopped=s})).decision,'STOP');
  assert.equal(stopped,'ROUTED_FETCH_FAILED');
  assert.deepEqual(marks,{fetch:1,fulfill:0,abort:1});
});
test('P1: unauthorized host and login gate are never fetched',async()=>{
  const marks={fetch:0,abort:0};
  const route={
    request:()=>({url:()=> 'https://login.douyin.com/',method:()=> 'GET',resourceType:()=> 'document'}),
    fetch:async()=>{marks.fetch++},
    abort:async()=>{marks.abort++},
  };
  const result=await guardedRoute(route,{approvedCoreStatic:true});
  assert.equal(result.decision,'DENIED');
  assert.deepEqual(marks,{fetch:0,abort:1});
});
const anchor=id=>({href:'https://live.douyin.com/'+id,text:'直播中',ownerScoped:true});
const NAME='SYNTHETIC',ID='test_1234',SEC='SYNTHETIC_SECUID';
const t={accountName:NAME,displayDouyinId:ID,profileUrl:'https://www.douyin.com/user/'+SEC,roomId:'10000000001'};
const p={httpStatus:200,finalHost:'www.douyin.com',finalPath:'/user/'+SEC,title:NAME+'的抖音 - 抖音',douyinIdsInPage:[ID],bodyExcerpt:'抖音号：'+ID,liveRoomAnchors:[anchor('99988877766')]};
const room={httpStatus:200,finalHost:'live.douyin.com',finalPath:'/99988877766',
 title:NAME+'的抖音直播间 - 抖音直播',metaDescription:'欢迎来到'+NAME+'的抖音直播间',
 ownerProfileLinks:['https://www.douyin.com/user/'+SEC],bodyExcerpt:'侧栏：其他主播已下播'};
test('P2: supports dynamic new room ID when owner header and room owner corroborate',()=>{
  assert.deepEqual(liveAnchorScope(p),{scope:'OWNER_HEADER_LIVE_ANCHOR',roomId:'99988877766'});
  const d=decideDouyin(p,room,t,{strictRoomOwner:true});
  assert.equal(d.state,'LIVE');
  assert.equal(d.roomIdChanged,true);
});
test('P2: recommended room link must not be followed as account owner',()=>{
  assert.equal(liveAnchorScope({...p,liveRoomAnchors:[{...anchor('99988877766'),ownerScoped:false}]}).roomId,null);
  assert.equal(decideDouyin({...p,liveRoomAnchors:[{...anchor('99988877766'),ownerScoped:false}]},room,t,{strictRoomOwner:true}).state,'UNKNOWN');
});
test('P2: identity conflict or missing owner profile URL produces UNKNOWN, not LIVE',()=>{
  for(const links of [[],['https://www.douyin.com/user/OTHER']]){
    assert.equal(decideDouyin(p,{...room,ownerProfileLinks:links},t,{strictRoomOwner:true}).state,'UNKNOWN');
  }
});
test('P2: multiple owner-scoped anchors are ambiguous; no room visit',()=>{
  assert.equal(liveAnchorScope({...p,liveRoomAnchors:[anchor('99988877766'),anchor('88877766655')]}).roomId,null);
});
test('P3: unrelated sidebar ended text cannot create an offline candidate',()=>{
  const ended={...p,liveRoomAnchors:[]};
  const d=decideDouyin(ended,{...room,bodyExcerpt:'某推荐号 主播已下播',statusFields:[{field:'r.data.status',value:4}]},t,{strictRoomOwner:true});
  assert.equal(d.state,'UNKNOWN');
  assert.equal(d.offlineCandidate,false);
});
test('safety: original PR80 used RPA workflow remains disabled and contains no CDN approval secret',()=>{
  const wf=fs.readFileSync('.github/workflows/r319-douyin-approved-cdn-once.yml','utf8');
  assert.match(wf,/if: \$\{\{ false \}\}/);
  assert.doesNotMatch(wf,/R319_CORE_CDN_APPROVED_ONCE:/);
  const probe=fs.readFileSync('probes/r316/douyin-rpa-two-once.mjs','utf8');
  assert.match(probe,/guardedRoute\(/);
  assert.match(probe,/ctx\.addInitScript\(disableUnroutedChannels\)/);
  assert.match(probe,/strictRoomOwner: true/);
  assert.doesNotMatch(probe,/route\.continue\(/);
});
