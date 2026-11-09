import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {corroborateDouyin} from '../probes/r19/douyin-bridge.mjs';
const registry=JSON.parse(fs.readFileSync(new URL('../config/r19-douyin-tcl-ffalcon-registry.json',import.meta.url),'utf8'));
const t=registry.targets.find(x=>x.key==='tcl-douyin-flagship');
const now='2026-11-09T06:30:00.000Z';
const profile=(overrides={})=>({
 profile_url:t.profile_url,title:t.account_name+'的抖音 - 抖音',
 body_excerpt:'抖音号：'+t.display_douyin_id,
 live_anchors:[{text:'直播中',href:'https://live.douyin.com/31878890513?room_id=7705907855488043785'}],
 observed_at:now,...overrides
});
const room=(overrides={})=>({
 title:t.account_name+'的抖音直播间 - 抖音直播',
 metaDescription:'欢迎来到'+t.account_name+'的抖音直播间，查看直播内容',
 bodyExcerpt:'正在直播 电视型号',
 url:'https://live.douyin.com/31878890513?room_id=7705907855488043785',
 httpStatus:200,observed_at:now,...overrides
});
test('dual page and dynamic room corroboration allows live observation',()=>{
 const x=corroborateDouyin(profile(),room(),t,{now});
 assert.equal(x.state,'LIVE');assert.equal(x.source_attested,true);
 assert.equal(x.live_id,'7705907855488043785');
 assert.equal(x.room_id,'31878890513');assert.equal(x.room_page_second_verification,true);
});
test('profile alone does not allow LIVE',()=>{
 const x=corroborateDouyin(profile(),null,t,{now});
 assert.equal(x.state,'UNKNOWN');assert.equal(x.reason,'ROOM_PAGE_NOT_VISITED');
 assert.equal(x.profile_badge,true);
});
test('room title mismatch stays UNKNOWN',()=>{
 const x=corroborateDouyin(profile(),room({title:'其他直播间的抖音直播间 - 抖音直播'}),t,{now});
 assert.equal(x.reason,'ROOM_TITLE_IDENTITY_MISMATCH');assert.equal(x.source_attested,false);
});
test('room description mismatch stays UNKNOWN',()=>{
 const x=corroborateDouyin(profile(),room({metaDescription:'欢迎来到其他直播间'}),t,{now});
 assert.equal(x.reason,'ROOM_META_IDENTITY_MISMATCH');
});
test('room URL cannot divert to another host or room ID',()=>{
 for(const url of ['https://evil.douyin.com/31878890513?room_id=7705907855488043785',
  'https://live.douyin.com/31878890513?room_id=7705907855488043786',
  'https://live.douyin.com/31878890514?room_id=7705907855488043785']){
  const x=corroborateDouyin(profile(),room({url}),t,{now});
  assert.equal(x.reason,'ROOM_LINK_MISMATCH');
 }
});
test('room page auth gate, captcha, and explicit ended state stay UNKNOWN',()=>{
 for(const message of ['直播已结束','请先登录后观看','安全验证','验证码','扫码登录']){
  const x=corroborateDouyin(profile(),room({bodyExcerpt:message}),t,{now});
  assert.equal(x.reason,'ROOM_ACCESS_OR_ENDED');
 }
});
test('room HTTP failure and capture error stay UNKNOWN',()=>{
 assert.equal(corroborateDouyin(profile(),room({httpStatus:403}),t,{now}).state,'UNKNOWN');
 assert.equal(corroborateDouyin(profile(),room({error_code:'TIMEOUT'}),t,{now}).reason,'TIMEOUT');
});
test('no badge prevents live even if old room page shows former live',()=>{
 const x=corroborateDouyin(profile({live_anchors:[]}),room(),t,{now});
 assert.equal(x.state,'UNKNOWN');assert.equal(x.source_attested,false);
});
test('old profile evidence is not rescued by fresh room page',()=>{
 const x=corroborateDouyin(profile({observed_at:'2026-11-09T06:00:00Z'}),room(),t,{now});
 assert.equal(x.state,'UNKNOWN');assert.equal(x.reason,'STALE_OR_FUTURE_PROFILE_CAPTURE');
});
test('stale or future room evidence is rejected',()=>{
 for(const obs of ['2026-11-09T06:00:00Z','2026-11-09T07:00:00Z']){
  const x=corroborateDouyin(profile(),room({observed_at:obs}),t,{now});
  assert.equal(x.reason,'ROOM_EVIDENCE_STALE');
 }
});
