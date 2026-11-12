import test from 'node:test';
import assert from 'node:assert/strict';
import {parseJdConsumerLink} from '../probes/r20/jd-share-intake.mjs';
import {classifyJdLoginRedirect} from '../probes/r20/jd-login-redirect-evidence.mjs';

const login=returnurl=>'https://plogin.m.jd.com/login/login?appid=2193&czLogin=1&returnurl='+
  encodeURIComponent(returnurl)+'&czyl=1';
const jd='https://lives.jd.com/#/45583477?origin=3&appid=jdzb&id=45583477&abGroup=experiment';
test('JD visible auth returnurl yields historical liveId candidate but NEVER LIVE',()=>{
 const r=classifyJdLoginRedirect({source_url:'https://t.cn/AX6U24yU',final_url:login(jd)});
 assert.equal(r.classification,'JD_HISTORICAL_SESSION_FROM_AUTH_REDIRECT');
 assert.equal(r.historical_live_id_candidate,'45583477');
 assert.equal(r.sanitized_jd_live_url,'https://lives.jd.com/#/45583477');
 assert.equal(r.login_required,true);
 assert.equal(r.current_live_state,'UNKNOWN');
 assert.equal(r.identity_verified,false);
 assert.equal(r.ops_room_binding_verified,false);
 assert.equal(r.opening_rate_eligible,false);
 assert.equal(r.source_url,'https://t.cn/AX6U24yU');
 assert.ok(!JSON.stringify(r).includes('abGroup'));
});
test('direct official lives.jd.com hash with tracking remains a session-only candidate',()=>{
 const r=parseJdConsumerLink(jd);
 assert.equal(r.kind,'DYNAMIC_JD_LIVE_SESSION_ONLY');
 assert.equal(r.dynamic_live_id,'45583477');
 assert.equal(r.clean_url,'https://lives.jd.com/#/45583477');
 assert.equal(r.public_jd_account_id,null);
});
test('fake login host with real-looking JD returnurl rejected',()=>{
 const r=classifyJdLoginRedirect({final_url:login(jd).replace('plogin.m.jd.com','evil.com')});
 assert.equal(r.classification,'UNKNOWN_LOGIN_OR_NON_JD_DESTINATION');
 assert.equal(r.historical_live_id_candidate,null);
});
test('non-JD returnurl blocked without redirects or origin persistence',()=>{
 const r=classifyJdLoginRedirect({final_url:login('https://evil.com/#/45583477')});
 assert.equal(r.reason,'RETURNURL_NOT_APPROVED_JD_LIVE_URL');
 assert.equal(r.current_live_state,'UNKNOWN');
 assert.equal(r.historical_live_id_candidate,null);
});
test('missing returnurl, duplicate returnurl, and a store URL cannot create live session',()=>{
 const miss=classifyJdLoginRedirect({final_url:'https://plogin.m.jd.com/login/login?appid=2193'});
 assert.equal(miss.reason,'MISSING_OR_MULTIPLE_RETURNURL');
 const many=classifyJdLoginRedirect({final_url:login(jd)+'&returnurl='+encodeURIComponent(jd)});
 assert.equal(many.historical_live_id_candidate,null);
 const store=classifyJdLoginRedirect({final_url:login('https://mall.jd.com/index-619517.html')});
 assert.equal(store.reason,'RETURNURL_NOT_JD_LIVE_SESSION');
});
test('login redirects never authenticate ops shop id or historical store ownership',()=>{
 const r=classifyJdLoginRedirect({
  source_url:'https://t.cn/AX6U24yU',
  final_url:login('https://lives.jd.com/#/45583477')
 });
 assert.equal(r.verified_public_anchor_id,null);
 assert.equal(r.original_source_provenance_verified,false);
 assert.equal(r.ops_room_binding_verified,false);
});
