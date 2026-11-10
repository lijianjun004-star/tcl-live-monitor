import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyJdShareLink,intakeJdAppShareText} from '../probes/r20/jd-mobile-share-intake.mjs';

test('JD App ordinary share link becomes identity candidate ONLY, not a verified room',()=>{
 const r=intakeJdAppShareText('分享主播主页：https://m.jd.com/anchor/share?id=123456&room_id=999888777');
 assert.equal(r.network_requests,0);
 assert.equal(r.redirects_followed,0);
 assert.equal(r.account_to_ops_mapping_proven,false);
 assert.equal(r.observed_current_live,false);
 assert.equal(r.opening_rate_contribution,null);
 assert.equal(r.candidates[0].result,'JD_DOMAIN_PAGE_TYPE_UNVERIFIED');
 assert.equal(r.candidates[0].current_live_state,'UNKNOWN');
 assert.equal(r.candidates[0].live_session_id,null);
 assert.equal(r.candidates[0].public_jd_account_id,null);
});
test('JD PC storefront is known non-live candidate and cannot be promoted',()=>{
 const p=classifyJdShareLink('https://mall.jd.com/index-619517.html?from=pc');
 assert.equal(p.result,'JD_NON_LIVE_PAGE_UNVERIFIED');
 assert.equal(p.page_identity_verified,false);
 assert.equal(p.room_identity_verified,false);
});
test('JD official domain suffix check rejects lookalike hostnames',()=>{
 for(const host of ['jd.com.evil.example','eviljd.com','jd.co','jd.hk.evil.org']){
  const p=classifyJdShareLink('https://'+host+'/live');
  assert.equal(p.result,'NON_JD_DOMAIN',host);
  assert.equal(p.can_open_in_authorized_browser,false);
 }
});
test('HTTP share cannot be auto opened and still has UNKNOWN state',()=>{
 const p=classifyJdShareLink('http://m.jd.com/live/123');
 assert.equal(p.result,'JD_DOMAIN_PAGE_TYPE_UNVERIFIED');
 assert.equal(p.can_open_in_authorized_browser,false);
 assert.equal(p.current_live_state,'UNKNOWN');
});
test('official short domain 3.cn is allowed only as unresolved JD page candidate',()=>{
 const p=classifyJdShareLink('https://u.3.cn/long-private-tracking-code');
 assert.equal(p.result,'JD_DOMAIN_PAGE_TYPE_UNVERIFIED');
 assert.equal(p.path_omitted,true);
 assert.equal('safe_pathname' in p,false);
});
test('non-JD t.cn campaign short link cannot establish streamer identity',()=>{
 const p=classifyJdShareLink('https://t.cn/AX6U24yU');
 assert.equal(p.result,'EXTERNAL_SHORTLINK_UNRESOLVED');
 assert.equal(p.safe_follow_up,'RESOLVE_ONLY_WITH_NORMAL_USER_BROWSER_NO_AUTO_FOLLOW');
 assert.equal(p.current_live_state,'UNKNOWN');
});
test('explicit bearer token query rejected with zero exposure',()=>{
 const raw='https://m.jd.com/stream/room?token=private-value-DO-NOT-SHARE';
 const p=classifyJdShareLink(raw);
 assert.equal(p.result,'SECRET_BEARING_URL_REJECTED');
 assert.equal(JSON.stringify(p).includes('private-value'),false);
});
test('URL userinfo credentials are rejected with zero exposure',()=>{
 const p=classifyJdShareLink('https://username:private-password@m.jd.com/live');
 assert.equal(p.result,'URL_WITH_CREDENTIALS_REJECTED');
 assert.equal(JSON.stringify(p).includes('private-password'),false);
});
test('query values, URL fragments, shared tokens and raw text are never retained',()=>{
 const raw='TCL 直播分享 https://m.jd.com/long-random-path-token/live?foo=TOPSECRET#frag';
 const o=intakeJdAppShareText(raw),s=JSON.stringify(o);
 for(const secret of ['TOPSECRET','long-random-path-token','#frag','TCL 直播分享']){
  assert.equal(s.includes(secret),false,secret);
 }
 assert.equal(o.raw_text_retained,false);
 assert.equal(o.raw_link_retained,false);
});
test('two distinct JD links remain separate; exact repeated URL is deduplicated',()=>{
 const p=intakeJdAppShareText('https://m.jd.com/anchor/1 https://m.jd.com/anchor/2 https://m.jd.com/anchor/1');
 assert.equal(p.urls_detected,3);
 assert.equal(p.candidates.length,2);
});
test('no link is not an OFFLINE or empty-identity report',()=>{
 const p=intakeJdAppShareText('复制链接失败，暂时找不到直播入口');
 assert.equal(p.candidates.length,0);
 assert.equal(p.account_to_ops_mapping_proven,false);
 assert.equal(p.opening_rate_contribution,null);
});
test('Chinese trailing punctuation is not part of official URL',()=>{
 const p=intakeJdAppShareText('请打开 https://live.jd.com/123456。谢谢！');
 assert.equal(p.candidates.length,1);
 assert.equal(p.candidates[0].hostname,'live.jd.com');
 assert.equal(p.candidates[0].result,'JD_DOMAIN_PAGE_TYPE_UNVERIFIED');
});
test('malformed and oversized inputs are rejected; no network action',()=>{
 assert.throws(()=>classifyJdShareLink(''),/INVALID_SHARE_URL_INPUT/);
 assert.throws(()=>intakeJdAppShareText(''),/INVALID_SHARE_TEXT/);
 assert.throws(()=>intakeJdAppShareText('a'.repeat(12001)),/INVALID_SHARE_TEXT/);
});
test('JS file never guesses that path numeric part is public account id or room id',()=>{
 const p=classifyJdShareLink('https://live.jd.com/42021726185?roomId=7705907855488043785');
 assert.equal(p.public_jd_account_id,null);
 assert.equal(p.live_session_id,null);
 assert.equal(p.ops_room_id,null);
 assert.equal(p.ops_shop_id,null);
});
