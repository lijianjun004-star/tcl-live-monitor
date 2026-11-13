// R3.18 offline verification. Synthetic fixtures only, absolutely no live account access.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { profileIdentity, profileIdentityEvidence, decideDouyin, roomIdentity } from '../../probes/lib/douyin.mjs';
import { classifyDouyinResource, CORE_STATIC_CANDIDATES, UNKNOWN_STATIC_CANDIDATES } from '../../probes/r318/douyin-static-policy.mjs';

const NAME='SYNTHETIC_TEST_ACCOUNT', ID='test_1234', SEC='MS4wLjABAAAA'+'a'.repeat(36);
const PROFILE='https://www.douyin.com/user/'+SEC;
const account={accountName:NAME,displayDouyinId:ID,profileUrl:PROFILE,roomId:'1234567'};
const profile=(v={})=>({
  httpStatus:200,finalHost:'www.douyin.com',finalPath:'/user/'+SEC,
  title:'新版个人主页 - 抖音',douyinIdsInPage:[ID],bodyExcerpt:'抖音号：'+ID,
  liveRoomAnchors:[{href:'https://live.douyin.com/1234567',text:'直播中'}],...v
});
const room=(v={})=>({
  httpStatus:200,finalHost:'live.douyin.com',finalPath:'/1234567',
  title:NAME+'的抖音直播间 - 抖音直播',
  metaDescription:'欢迎来到'+NAME+'的抖音直播间，更多内容',
  bodyExcerpt:'',...v
});
const req=(url,resourceType='script',method='GET')=>({url,resourceType,method});

test('approved account: exact final URL + unique visible ID withstands changed title',()=>{
  const p=profile();
  const e=profileIdentityEvidence(p,account);
  assert.equal(e.titleExact,false);
  assert.equal(e.finalUrlExact,true);
  assert.equal(e.idExact,true);
  assert.equal(profileIdentity(p,account),true);
});
test('different resolved account URL must remain UNKNOWN even with matching visible ID and exact old title',()=>{
  const p=profile({finalPath:'/user/'+SEC+'changed',title:NAME+'的抖音 - 抖音'});
  assert.equal(profileIdentity(p,account),false);
});
test('ambiguous or incorrect visible ID cannot verify a profile',()=>{
  assert.equal(profileIdentity(profile({douyinIdsInPage:[ID,'other_5678']}),account),false);
  assert.equal(profileIdentity(profile({douyinIdsInPage:['test_12345'],bodyExcerpt:'抖音号：test_12345'}),account),false);
  assert.equal(profileIdentity(profile({douyinIdsInPage:[],bodyExcerpt:'账号 test_12345'}),account),false);
  assert.equal(profileIdentity(profile({title:'滑块验证'}),account),false);
});
test('two corroborating pages plus matching live room URL can mark LIVE (synthetic only)',()=>{
  const d=decideDouyin(profile(),room(),account);
  assert.equal(d.state,'LIVE');
  assert.equal(d.profileIdentityVerified,true);
  assert.equal(d.roomPageIdentityVerified,true);
});
test('redirected room page or missing account identity yields UNKNOWN, never OFFLINE',()=>{
  for(const r of [room({finalPath:'/9999999'}),room({metaDescription:'一个无关直播间'}),null]){
    const d=decideDouyin(profile(),r,account);
    assert.equal(d.state,'UNKNOWN');
  }
  assert.equal(decideDouyin(profile({douyinIdsInPage:['someone_else']}),room(),account).state,'UNKNOWN');
});
test('no live anchor is not proof of OFFLINE',()=>{
  const d=decideDouyin(profile({liveRoomAnchors:[]}),null,account);
  assert.equal(d.state,'UNKNOWN');
  assert.equal(d.offlineCandidate,false);
});
test('third-party resource hosts remain denied by default, including the top blocked CDN trio',()=>{
  for(const h of [...CORE_STATIC_CANDIDATES,...UNKNOWN_STATIC_CANDIDATES]) {
    const d=classifyDouyinResource(req('https://'+h+'/app.js'));
    assert.equal(d.allow,false,h);
  }
});
test('only explicitly approved core CDN JS and CSS may pass in hypothetical offline policy',()=>{
  for(const host of CORE_STATIC_CANDIDATES) {
    assert.equal(classifyDouyinResource(req('https://'+host+'/a.js'),{approvedCoreStatic:true}).allow,true);
    assert.equal(classifyDouyinResource(req('https://'+host+'/a.css','stylesheet'),{approvedCoreStatic:true}).allow,true);
    assert.equal(classifyDouyinResource(req('https://'+host+'/a.jpg','image'),{approvedCoreStatic:true}).allow,false);
    assert.equal(classifyDouyinResource(req('https://'+host+'/x','xhr'),{approvedCoreStatic:true}).allow,false);
    assert.equal(classifyDouyinResource(req('https://'+host+'/a.js','script','POST'),{approvedCoreStatic:true}).allow,false);
  }
});
test('unknown CDN, trackers, lookalike hosts, media, WebSocket and http remain blocked',()=>{
  const allow={approvedCoreStatic:true};
  assert.equal(classifyDouyinResource(req('https://lf3-cdn-tos.bytegoofy.com/a.js'),allow).allow,false);
  assert.equal(classifyDouyinResource(req('https://mon.zijieapi.com/a.js'),allow).allow,false);
  assert.equal(classifyDouyinResource(req('https://douyin.com.evil.example/a.js'),allow).allow,false);
  assert.equal(classifyDouyinResource(req('http://www.douyin.com/a.js'),allow).allow,false);
  assert.equal(classifyDouyinResource(req('https://www.douyin.com/a','media'),allow).allow,false);
  assert.equal(classifyDouyinResource(req('https://www.douyin.com/a','websocket'),allow).allow,false);
  assert.equal(classifyDouyinResource(req('https://www.douyin.com/a','script','PUT'),allow).allow,false);
  assert.equal(classifyDouyinResource(req('https://u:p@www.douyin.com/a'),allow).allow,false);
});
test('RPA never visits an unverified profile live-room link, and cannot use opt-in CDN mode',()=>{
  const s=fs.readFileSync('probes/r316/douyin-rpa-two-once.mjs','utf8');
  assert.match(s,/profileEvidence\.verified\)/);
  assert.match(s,/serviceWorkers: 'block'/);
  assert.match(s,/guardedRoute\(/);
  assert.doesNotMatch(s,/approvedCoreStatic:\s*true/);
  assert.match(s,/ctx\.routeWebSocket/);
});
test('the RPA workflow can only run on the prior approved experiment branch; no scheduled probes',()=>{
  const s=fs.readFileSync('.github/workflows/r316-douyin-rpa-once.yml','utf8');
  assert.match(s,/branches: \[experiment\/r317-douyin-approved-rpa-once-20261112\]/);
  assert.doesNotMatch(s,/\bschedule:/);
  assert.match(s,/contains\(github\.event\.head_commit\.message, '\[r316-rpa-once\]'\)/);
});
