import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {validateRegistry,firstPartyTargets,planHourlyDouyinChecks,planManualDouyinCheck,classifyFreshProfileCapture} from '../probes/r19/douyin-first.mjs';

const registry=JSON.parse(fs.readFileSync(new URL('../config/r19-douyin-tcl-ffalcon-registry.json',import.meta.url),'utf8'));
const first=registry.targets.find(t=>t.key==='tcl-douyin-flagship');
const ff=registry.targets.filter(t=>t.key.startsWith('ffalcon-'));
const now='2026-11-09T06:30:00.000Z';
const sample=(overrides={})=>({
 profile_url:first.profile_url,
 title:first.account_name+'的抖音 - 抖音',
 body_excerpt:'抖音号：'+first.display_douyin_id+' 旗舰店账号',
 observed_at:now,
 live_anchors:[{text:'直播中',href:'https://live.douyin.com/31878890513?room_id=7705907855488043785'}],
 ...overrides
});
test('registry has 14 distinct secUid, 8 observed badges and zero scoring',()=>{
 const s=validateRegistry(registry);
 assert.equal(s.total,14);assert.equal(s.distinct_sec_uid,14);assert.equal(s.live_badges,8);
 assert.ok(registry.targets.every(t=>t.score_eligible===false));
});
test('two new FFALCON accounts are separate from old TV flagship and each other',()=>{
 assert.equal(ff.length,3);
 assert.equal(new Set(ff.map(t=>t.sec_uid)).size,3);
 assert.ok(ff.find(t=>t.business_segment==='FFALCON_MONITORS'));
});
test('R19 first-party scope excludes dealer and AR subsidiary by default',()=>{
 const t=firstPartyTargets(registry);
 assert.equal(t.length,12);
 assert.ok(!t.some(x=>x.business_segment==='THIRD_PARTY_DEALER'));
 assert.ok(!t.some(x=>x.business_segment==='RAYNEO_AR_SEPARATE'));
});
test('can retain adjacent AR/dealer in non-scoring read-only audit if explicitly requested',()=>{
 assert.equal(firstPartyTargets(registry,{includeAdjacentBusinesses:true}).length,14);
});
test('hourly planned slot produces exactly one stable key per account',()=>{
 const a=planHourlyDouyinChecks(registry,'2026-11-09T06:04:00.000Z');
 const b=planHourlyDouyinChecks(registry,'2026-11-09T06:59:00.000Z');
 assert.equal(a.length,12);assert.equal(b.length,12);
 assert.deepEqual(a.map(x=>x.check_id),b.map(x=>x.check_id));
 assert.ok(a.every(x=>x.planned_check_at==='2026-11-09T06:00:00.000Z'));
});
test('manual checks in same hour use separate idempotent request IDs',()=>{
 const a=planManualDouyinCheck(first,now,'one');
 const b=planManualDouyinCheck(first,now,'two');
 assert.notEqual(a.check_id,b.check_id);
 assert.equal(a.check_id,planManualDouyinCheck(first,now,'one').check_id);
});
test('identity-verified live badge surfaces candidate dynamic room but not a claimed verified LIVE',()=>{
 const o=classifyFreshProfileCapture(sample(),first,{now});
 assert.equal(o.live_badge_observed,true);
 assert.equal(o.live_route_id,'31878890513');
 assert.equal(o.webcast_room_id,'7705907855488043785');
 assert.equal(o.normalized_state,'UNKNOWN');
 assert.equal(o.source_attested,false);
 assert.equal(o.room_page_second_verification,false);
});
test('absence of a badge is UNKNOWN, never OFFLINE',()=>{
 const o=classifyFreshProfileCapture(sample({live_anchors:[]}),first,{now});
 assert.equal(o.reason,'NO_VERIFIED_PROFILE_LIVE_BADGE');
 assert.equal(o.normalized_state,'UNKNOWN');
 assert.equal(o.live_badge_observed,false);
});
test('recommended room link with no target live badge is ignored',()=>{
 const o=classifyFreshProfileCapture(sample({live_anchors:[{text:'其他推荐',href:'https://live.douyin.com/31878890513?room_id=7705907855488043785'}]}),first,{now});
 assert.equal(o.live_badge_observed,false);
});
test('account mismatch cannot be accepted as LIVE even with a badge',()=>{
 const o=classifyFreshProfileCapture(sample({body_excerpt:'抖音号：2222222222'}),first,{now});
 assert.equal(o.reason,'ACCOUNT_IDENTITY_MISMATCH');
 assert.equal(o.live_badge_observed,false);
});
test('profile URL mismatch cannot be accepted as LIVE',()=>{
 const o=classifyFreshProfileCapture(sample({profile_url:'https://www.douyin.com/user/OTHER'}),first,{now});
 assert.equal(o.reason,'ACCOUNT_IDENTITY_MISMATCH');
});
test('stale or future observations are rejected before live parsing',()=>{
 const old=classifyFreshProfileCapture(sample(),first,{now:'2026-11-09T07:00:00Z'});
 assert.equal(old.reason,'STALE_OR_FUTURE_PROFILE_CAPTURE');
 const future=classifyFreshProfileCapture(sample({observed_at:'2026-11-09T07:00:00Z'}),first,{now});
 assert.equal(future.reason,'STALE_OR_FUTURE_PROFILE_CAPTURE');
});
test('captcha, security block and authentication must never be accepted',()=>{
 for(const failure of ['安全验证','验证码','扫码登录后观看','unusual traffic']){
  const s=sample({body_excerpt:sample().body_excerpt+' '+failure});
  const o=classifyFreshProfileCapture(s,first,{now});
  assert.equal(o.reason,'ACCESS_OR_AUTH_BLOCKED');
  assert.equal(o.normalized_state,'UNKNOWN');
 }
});
test('conflicting simultaneous live links are UNKNOWN',()=>{
 const s=sample({live_anchors:[
  {text:'直播中',href:'https://live.douyin.com/31878890513?room_id=7705907855488043785'},
  {text:'直播中',href:'https://live.douyin.com/31878890513?room_id=7705907855488043786'}
 ]});
 assert.equal(classifyFreshProfileCapture(s,first,{now}).reason,'CONFLICTING_LIVE_BADGE_LINKS');
});
test('wrong host and invalid room id are ignored',()=>{
 const s=sample({live_anchors:[
  {text:'直播中',href:'https://fake-live.douyin.com/31878890513?room_id=7705907855488043785'},
  {text:'直播中',href:'https://live.douyin.com/31878890513?room_id=123'}
 ]});
 assert.equal(classifyFreshProfileCapture(s,first,{now}).reason,'NO_VERIFIED_PROFILE_LIVE_BADGE');
});
test('archived first observation cannot become realtime without fresh capture',()=>{
 assert.equal(registry.targets.find(t=>t.key===first.key).evidence.time_precision,'DATE_ONLY_NO_PRECISE_BROWSER_TIMESTAMP');
 const old=sample({observed_at:'2026-11-08T06:30:00Z'});
 assert.equal(classifyFreshProfileCapture(old,first,{now}).reason,'STALE_OR_FUTURE_PROFILE_CAPTURE');
});
test('tampered roster duplicate secUid is rejected',()=>{
 const copy=structuredClone(registry);
 copy.targets[1].sec_uid=copy.targets[0].sec_uid;
 assert.throws(()=>validateRegistry(copy),/DUPLICATE_OR_INVALID_SEC_UID/);
});
