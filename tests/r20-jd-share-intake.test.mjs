import test from 'node:test';
import assert from 'node:assert/strict';
import {parseJdConsumerLink,reviewJdLinkIdentity} from '../probes/r20/jd-share-intake.mjs';

const item='https://zhibo.jd.com/liveroom?liveId=39953002';
test('JD desktop stream room resolves per-session liveId only, not stable account',()=>{
 const o=parseJdConsumerLink(item);
 assert.equal(o.kind,'DYNAMIC_JD_LIVE_SESSION_ONLY');
 assert.equal(o.dynamic_live_id,'39953002');
 assert.equal(o.public_jd_account_id,null);
 assert.equal(o.internal_ops_room_id,null);
 assert.equal(o.can_promote_crosswalk,false);
 assert.equal(o.can_update_opening_rate,false);
 assert.equal(o.state,'UNKNOWN');
});
test('JD app 3.cn share shortlink is unresolved, not stream ID',()=>{
 const o=parseJdConsumerLink('京东主播主页分享 https://3.cn/2ufAsT-f');
 assert.equal(o.kind,'JD_APP_SHARE_SHORTLINK_UNRESOLVED');
 assert.equal(o.dynamic_live_id,null);
 assert.equal(o.stable_anchor_id,null);
 assert.equal(o.identity_verified,false);
});
test('JD 3.cn live room link has no explicit liveId until normal browser redirect',()=>{
 const o=parseJdConsumerLink('https://3.cn/-2ufA9mx');
 assert.equal(o.kind,'JD_APP_SHARE_SHORTLINK_UNRESOLVED');
 assert.equal(o.clean_url,'https://3.cn/-2ufA9mx');
});
test('recognizes lives.jd.com hash route as session only, not current LIVE',()=>{
 const o=parseJdConsumerLink('https://lives.jd.com/#/39842812/live');
 assert.equal(o.kind,'DYNAMIC_JD_LIVE_SESSION_ONLY');
 assert.equal(o.dynamic_live_id,'39842812');
 assert.equal(o.state,'UNKNOWN');
});
test('JD store page path and vendor ID cannot be assumed live room or anchor',()=>{
 const o=parseJdConsumerLink('https://mall.jd.com/index-619517.html?from=pc&venderId=624085');
 assert.equal(o.kind,'JD_STORE_PAGE_NOT_LIVE');
 assert.equal(o.dynamic_live_id,null);
 assert.equal(o.public_jd_account_id,null);
 assert.equal(o.clean_url,'https://mall.jd.com/index-619517.html');
});
test('JD generic mobile product/landing pages need visible independent inspection',()=>{
 const o=parseJdConsumerLink('https://m.jd.com/product/123456.html?utm_source=other');
 assert.equal(o.kind,'JD_MOBILE_OR_SITE_LINK_NEEDS_INSPECTION');
 assert.equal(o.dynamic_live_id,null);
 assert.equal(o.clean_url,'https://m.jd.com/product/123456.html');
});
test('marketing text can contain one, and only one, JD HTTPS URL',()=>{
 const o=parseJdConsumerLink('京东直播间链接：'+item+' 记得看看');
 assert.equal(o.dynamic_live_id,'39953002');
 assert.throws(()=>parseJdConsumerLink(item+' '+item),/EXPECTED_EXACTLY_ONE_HTTPS_LINK/);
});
test('malicious redirect URL is rejected before any link request',()=>{
 const invalid=[
 'http://zhibo.jd.com/liveroom?liveId=39953002',
 'https://evil.zhibo.jd.com/liveroom?liveId=39953002',
 'https://zhibo.jd.com.evil.org/liveroom?liveId=39953002',
 'https://127.0.0.1/liveroom?liveId=39953002',
 'https://user:pass@zhibo.jd.com/liveroom?liveId=39953002',
 'https://zhibo.jd.com:444/liveroom?liveId=39953002'
 ];
 for(const u of invalid)assert.throws(()=>parseJdConsumerLink(u),/NOT_HTTPS_ALLOWED_JD_HOST/);
});
test('invalid or missing liveId cannot create a session',()=>{
 for(const u of [
 'https://zhibo.jd.com/liveroom?liveId=',
 'https://zhibo.jd.com/liveroom?liveId=abc',
 'https://zhibo.jd.com/liveroom?liveId=123',
 'https://zhibo.jd.com/liveroom?liveId=39953002&liveId=39953003'
 ])assert.throws(()=>parseJdConsumerLink(u),/INVALID_JD_LIVE_ID/);
});
test('invalid 3.cn shortlink path does not get followed',()=>{
 assert.throws(()=>parseJdConsumerLink('https://3.cn/'),/INVALID_JD_SHORTLINK/);
 assert.throws(()=>parseJdConsumerLink('https://3.cn/short?to=http://evil.example'),/NOT_HTTPS_ALLOWED_JD_HOST/);
});
test('post-review candidate always requires actual independent source inspection',()=>{
 const c=parseJdConsumerLink(item);
 const result=reviewJdLinkIdentity(c,{
  anchor_profile_url:'https://m.jd.com/anchor/example',
  ops_crosswalk_evidence_url:'https://example.org/tcl-internal-room-review',
  account_name:'TCL品牌主播',
  public_account_id:'88822222',
  ops_room_id:'17',
  independently_reviewed:true
 });
 assert.equal(result.status,'EVIDENCE_SUBMITTED_REQUIRES_REAL_SOURCE_CHECK');
 assert.equal(result.ready_for_opening_rate,false);
});
test('submission with only one side or no source remains pending',()=>{
 const c=parseJdConsumerLink(item);
 assert.equal(reviewJdLinkIdentity(c,null).status,'PENDING');
 assert.equal(reviewJdLinkIdentity(c,{account_name:'TCL'}).reason,'INCOMPLETE_TWO_SIDED_IDENTITY');
});
test('unreviewed or store-only source cannot become verified',()=>{
 const c=parseJdConsumerLink(item);
 const e={anchor_profile_url:'https://mall.jd.com/index-619517.html',
  ops_crosswalk_evidence_url:'https://example.org/ops',
  account_name:'TCL',public_account_id:'624085',ops_room_id:'14',independently_reviewed:true};
 assert.equal(reviewJdLinkIdentity(c,e).reason,'UNTRUSTED_IDENTITY_PROVENANCE');
 e.anchor_profile_url='https://m.jd.com/anchor/example';
 e.independently_reviewed=false;
 assert.equal(reviewJdLinkIdentity(c,e).status,'PENDING');
});
test('same URL with tracking params strips them from the offline intake',()=>{
 const o=parseJdConsumerLink('https://zhibo.jd.com/liveroom?liveId=39953002&shareToken=SensitiveValue&x=1');
 assert.equal(o.clean_url,item);
 assert.ok(!JSON.stringify(o).includes('SensitiveValue'));
});
