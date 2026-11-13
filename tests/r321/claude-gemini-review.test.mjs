// R3.21 offline regression, derived from independent Claude and Gemini reviews.
// All URLs and account IDs are synthetic. No Douyin requests.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { guardedRoute, disableUnroutedChannels, hostClass } from '../../probes/r320/network-guard.mjs';
import { decideDouyin } from '../../probes/lib/douyin.mjs';

function fakeRoute(url, { type = 'script', method = 'GET', nav = false, sub = false, status = 200, headers = {} } = {}) {
  const calls=[];
  const frame={ parentFrame:()=>sub?{}:null };
  return { calls, route:{
    request:()=>({url:()=>url,method:()=>method,resourceType:()=>type,isNavigationRequest:()=>nav,frame:()=>frame}),
    fetch:async options=>{
      assert.equal(options.maxRedirects,0);
      calls.push('fetch');return {status:()=>status,headers:()=>headers};
    },
    fulfill:async()=>calls.push('fulfill'),
    abort:async()=>calls.push('abort'),
    continue:async()=>calls.push('UNSAFE_CONTINUE'),
    fallback:async()=>calls.push('UNSAFE_FALLBACK')
  }};
}
test('stop evidence: only fixed safe host labels and request enums, no user URL or path',async()=>{
  const {route,calls}=fakeRoute('https://www.douyin.com/aweme/v1/web/secret?token=abc',{type:'fetch',status:403});
  const stops=[];
  await guardedRoute(route,{stop:(reason,evidence)=>stops.push([reason,evidence])});
  assert.deepEqual(stops,[['HTTP_403',{status:403,hostClass:'DOUYIN_WWW',resourceType:'fetch',method:'GET',mainFrameNavigation:false}]]);
  assert.deepEqual(calls,['fetch','abort']);
  assert.doesNotMatch(JSON.stringify(stops),/aweme|secret|token|https?:/);
  for(const [u,c] of [
    ['https://live.douyin.com/1','DOUYIN_LIVE'],
    ['https://u-123.douyin.com/x','DOUYIN_OTHER_SUBDOMAIN'],
    ['https://lf-douyin-pc-web.douyinstatic.com/a.js','lf-douyin-pc-web.douyinstatic.com'],
    ['https://tracker.example/x','THIRD_PARTY'],
    ['::','INVALID_URL'],
  ])assert.equal(hostClass(u),c);
});
test('denied top-frame access-gate or third-party navigation stops before a fetch',async()=>{
  for(const [url,expected] of [
    ['https://sso.douyin.com/passport/login?next=x','ACCESS_GATE_NAVIGATION'],
    ['https://tracker.example/landing','MAIN_FRAME_NAVIGATION_DENIED'],
  ]) {
    const {route,calls}=fakeRoute(url,{type:'document',nav:true});
    const stops=[];
    const d=await guardedRoute(route,{stop:(r,e)=>stops.push([r,e.hostClass,e.mainFrameNavigation,e.policyReason])});
    assert.equal(d.decision,'DENIED');
    assert.deepEqual(calls,['abort']);
    assert.equal(stops.length,1);
    assert.equal(stops[0][0],expected);
    assert.equal(stops[0][2],true);
  }
});
test('denied subframe or subresource is blocked without falsely marking the whole run stopped',async()=>{
  for(const options of [{type:'document',nav:true,sub:true},{type:'script'}]){
    const {route,calls}=fakeRoute('https://tracker.example/x',options);
    const stops=[];
    await guardedRoute(route,{stop:s=>stops.push(s)});
    assert.deepEqual(stops,[]);
    assert.deepEqual(calls,['abort']);
  }
});
test('safe loopback simulation still returns the original approved 200 with no continue/fallback',async()=>{
  const {route,calls}=fakeRoute('https://www.douyin.com/user/SYNTHETIC',{type:'document',nav:true});
  await guardedRoute(route);
  assert.deepEqual(calls,['fetch','fulfill']);
});
test('window-side constructor denial resists replacement attempts including WebSocketStream/WebTransport',()=>{
  const v=vm.createContext({});
  vm.runInContext('globalThis.window=globalThis;globalThis.navigator={}; globalThis.Navigator=function(){};for(const k of ["WebSocket","WebSocketStream","WebTransport","Worker","RTCPeerConnection"]) window[k]=function(){return "LEAK"};',v);
  vm.runInContext('('+disableUnroutedChannels.toString()+')()',v);
  for(const key of ['WebSocket','WebSocketStream','WebTransport','Worker','RTCPeerConnection']){
    assert.throws(()=>vm.runInContext('window.'+key+'("x")',v),/R320_PUBLIC_GUEST_CHANNEL_DISABLED/);
    vm.runInContext('try{window.'+key+'=function(){return "LEAK"}}catch{}',v);
    assert.throws(()=>vm.runInContext('window.'+key+'("x")',v),/R320_PUBLIC_GUEST_CHANNEL_DISABLED/);
  }
});
test('main player explicitly ended contradicts a validated live badge',()=>{
  const t={accountName:'SYNTHETIC',displayDouyinId:'test_1234',roomId:'1234567',profileUrl:'https://www.douyin.com/user/SYNTHETIC_SEC'};
  const p={httpStatus:200,finalHost:'www.douyin.com',finalPath:'/user/SYNTHETIC_SEC',title:'SYNTHETIC的抖音 - 抖音',
    douyinIdsInPage:['test_1234'],bodyExcerpt:'抖音号：test_1234',
    liveRoomAnchors:[{href:'https://live.douyin.com/1234567',text:'直播中',ownerScoped:true}]};
  const r={httpStatus:200,finalHost:'live.douyin.com',finalPath:'/1234567',title:'SYNTHETIC的抖音直播间 - 抖音直播',
    metaDescription:'欢迎来到SYNTHETIC的抖音直播间',ownerProfileLinks:[t.profileUrl],mainPlayerEndedText:'直播已结束'};
  const d=decideDouyin(p,r,t,{strictRoomOwner:true});
  assert.equal(d.state,'UNKNOWN');assert.equal(d.reason,'LIVE_BADGE_BUT_MAIN_PLAYER_ENDED');
  assert.equal(decideDouyin(p,{...r,mainPlayerEndedText:''},t,{strictRoomOwner:true}).state,'LIVE');
});
test('probe wiring: no generic main header, and sanitized reason is in receipt',()=>{
  const s=fs.readFileSync('probes/r316/douyin-rpa-two-once.mjs','utf8');
  assert.doesNotMatch(s,/main header/);
  assert.match(s,/stop:\(reason,evidence=null\)=>\{/);
  assert.match(s,/checked:pub, stopped, stopEvidence,/);
  assert.doesNotMatch(s,/route\.continue\(|route\.fallback\(/);
  assert.match(s,/ctx\.routeWebSocket/);
});
