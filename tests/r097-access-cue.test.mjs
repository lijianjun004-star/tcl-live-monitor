import test from 'node:test';
import assert from 'node:assert/strict';
import {accessCue} from '../probes/lib/access-cue.mjs';
test('ordinary storefront login navigation does not prove an access wall',()=>{
 assert.equal(accessCue({title:'TCL官方旗舰店 - 京东',text:'请先登录 免费注册 扫码登录 热销商品',finalHost:'mall.jd.com',finalPath:'/shopLevel-721631.html'}),null);
});
test('login redirect stops discovery even if the body has no login text',()=>{
 assert.equal(accessCue({finalHost:'login.taobao.com',text:''}).kind,'LOGIN_REDIRECT');
});
test('captcha pages and explicit login-to-watch cues stop discovery with evidence',()=>{
 assert.equal(accessCue({title:'安全验证 - 抖音'}).kind,'CHALLENGE_TITLE');
 assert.equal(accessCue({title:'直播间',text:'请先登录后观看'}).matched,'请先登录后观看');
});
