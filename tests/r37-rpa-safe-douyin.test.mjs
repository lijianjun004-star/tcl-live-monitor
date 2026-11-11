import test from 'node:test';
import assert from 'node:assert/strict';
import {
  approvedDouyinRpaTargets,safeDouyinPageURL,isRpaAccessBlocked,
  inspectPublicPage,runDouyinRpaReadOnly
} from '../probes/r37/rpa-safe-douyin.mjs';

const SEC='MS4wLjABAAAAHLgxNf9c59NqJuH9tm5U2L3E1B6bNBehePdI5rKsZ2s';
const PROFILE='https://www.douyin.com/user/'+SEC;
const ROOM='https://live.douyin.com/988541363148';
const ACCT={key:'ffalcon-douyin-tv-flagship',accountName:'FFALCON雷鸟电视旗舰店',
  displayDouyinId:'83165143028',profileUrl:PROFILE,scopeApproved:true,scoringEligible:false,roomId:'988541363148'};
const config={douyin:[ACCT]};
const profile=()=>({
  title:ACCT.accountName+'的抖音 - 抖音',
  bodyExcerpt:'欢迎 抖音号：'+ACCT.displayDouyinId+' 直播中',
  douyinIdsInPage:[ACCT.displayDouyinId],
  liveRoomAnchors:[{href:ROOM,text:'直播中'}],
  metaDescription:'',
});
const room=()=>({
  title:ACCT.accountName+'的抖音直播间 - 抖音直播',
  bodyExcerpt:'欢迎来到直播间',
  douyinIdsInPage:[],liveRoomAnchors:[],
  metaDescription:'欢迎来到'+ACCT.accountName+'的抖音直播间',
});
const at='2026-11-11T13:00:00.000Z';
function fakeBrowser(pages){
  const stats={navigations:[],pageCloses:0,browserClosed:false,contextClosed:false,route:null,contextOptions:null};
  const ctx={
    async route(pattern,handler){assert.equal(pattern,'**/*');stats.route=handler},
    async newPage(){
      const page={
        currentUrl:'about:blank',
        async goto(url){
          stats.navigations.push(url);page.currentUrl=pages[url]?.finalUrl||url;
          if(pages[url]?.throws)throw Error('SENSITIVE_UNSAFE_MESSAGE');
          return {status:()=>pages[url]?.status??200};
        },
        url(){return page.currentUrl},
        async waitForTimeout(ms){assert.ok(ms>=0&&ms<=1800)},
        async evaluate(fn){assert.equal(typeof fn,'function');return pages[page.currentUrl]?.dom||{}},
        async close(){stats.pageCloses++}
      };
      return page;
    },
    async close(){stats.contextClosed=true}
  };
  return {stats,async newContext(opts){stats.contextOptions=opts;return ctx},async close(){stats.browserClosed=true}};
}
function factory(pages){const b=fakeBrowser(pages);return [async()=>b,b.stats]}
const run=async (pages,override={})=>{
  const [browserFactory,stats]=factory(pages);
  const result=await runDouyinRpaReadOnly({config,keys:[ACCT.key],browserFactory,clock:()=>at,holdMs:0,...override});
  return {result,stats};
};

test('only approved exact public profile URL accepted',()=>{
 const x=approvedDouyinRpaTargets(config,[ACCT.key]);assert.equal(x.length,1);
 assert.equal(x[0].configuredRoomId,'988541363148');
 assert.throws(()=>approvedDouyinRpaTargets(config,['x']),/NOT_APPROVED/);
 assert.throws(()=>approvedDouyinRpaTargets(config,[ACCT.key,ACCT.key]),/UNIQUE/);
 assert.throws(()=>approvedDouyinRpaTargets(config,[]),/TARGETS_REQUIRED/);
});
test('reject URL host, credentials, query string and HTTP downgrade',()=>{
 for(const url of [
   PROFILE.replace('https:','http:'),PROFILE+'?token=bad',PROFILE+'#section',
   PROFILE.replace('www.douyin.com','www.douyin.com.example.org'),
   PROFILE.replace('https://','https://u:p@'),
 ])assert.equal(safeDouyinPageURL(url,'profile'),false,url);
 assert.equal(safeDouyinPageURL(PROFILE,'profile'),true);
 assert.equal(safeDouyinPageURL(ROOM,'room'),true);
 assert.equal(safeDouyinPageURL(PROFILE,'room'),false);
});
test('RPA only accepts precisely registered profiles',()=>{
 for(const profileUrl of ['https://private.local/x',PROFILE+'?state=1','http://www.douyin.com/user/'+SEC]){
   assert.throws(()=>approvedDouyinRpaTargets({douyin:[{...ACCT,profileUrl}]},[ACCT.key]),/INVALID_TARGET_URL/);
 }
});
test('isRpaAccessBlocked recognizes access walls and incomplete host',()=>{
 for(const x of [{httpStatus:403,finalHost:'www.douyin.com'},{httpStatus:429,finalHost:'www.douyin.com'},
   {httpStatus:200,finalHost:'passport.douyin.com'},{httpStatus:200,finalHost:'www.douyin.com',bodyExcerpt:'安全验证'}]){
  assert.equal(isRpaAccessBlocked(x),true);
 }
 assert.equal(isRpaAccessBlocked({httpStatus:200,finalHost:'live.douyin.com'}),false);
});
test('valid double-identity RPA profile+room produces bounded LIVE observation only',async()=>{
 const {result,stats}=await run({[PROFILE]:{dom:profile()},[ROOM]:{dom:room()}});
 assert.equal(result.sourceAccess,'PUBLIC_READ_COMPLETE');
 assert.equal(result.observations[0].state,'LIVE');
 assert.equal(result.observations[0].profileIdentityVerified,true);
 assert.equal(result.observations[0].roomIdentityVerified,true);
 assert.equal(result.observations[0].opsBridgeVerified,false);
 assert.equal(result.observations[0].exactStartAt,null);
 assert.equal(result.formalFullDurationRatePercent,null);
 assert.deepEqual(stats.navigations,[PROFILE,ROOM]);
 assert.equal(stats.contextOptions.serviceWorkers,'block');
 assert.equal(stats.contextOptions.acceptDownloads,false);
 assert.equal(stats.browserClosed,true);
});
test('profile not exactly matched => UNKNOWN and never visits room',async()=>{
 const bad={...profile(),title:'DifferentAccount的抖音 - 抖音'};
 const {result,stats}=await run({[PROFILE]:{dom:bad},[ROOM]:{dom:room()}});
 assert.equal(result.observations[0].state,'UNKNOWN');
 assert.deepEqual(stats.navigations,[PROFILE]);
});
test('profile badge without room identity => UNKNOWN, not LIVE',async()=>{
 const bad={...room(),title:'OTHER的抖音直播间 - 抖音直播'};
 const {result}=await run({[PROFILE]:{dom:profile()},[ROOM]:{dom:bad}});
 assert.equal(result.observations[0].state,'UNKNOWN');
 assert.equal(result.observations[0].roomIdentityVerified,false);
});
test('no live badge on verified profile stays UNKNOWN rather than OFFLINE',async()=>{
 const p={...profile(),liveRoomAnchors:[],bodyExcerpt:'抖音号：'+ACCT.displayDouyinId};
 const {result}=await run({[PROFILE]:{dom:p}});
 assert.equal(result.observations[0].state,'UNKNOWN');
 assert.equal(result.observations[0].reason,'PROFILE_NO_VERIFIED_LIVE_ANCHOR');
});
test('profile 403 stops immediately and does not visit another page',async()=>{
 const {result,stats}=await run({[PROFILE]:{status:403}});
 assert.equal(result.stoppedForChallenge,true);
 assert.equal(result.observations[0].state,'UNKNOWN');
 assert.equal(stats.navigations.length,1);
});
test('CAPTCHA profile must STOP; no attempts to pass verification',async()=>{
 const {result,stats}=await run({[PROFILE]:{dom:{...profile(),bodyExcerpt:'安全验证'}},[ROOM]:{dom:room()}});
 assert.equal(result.stoppedForChallenge,true);
 assert.equal(stats.navigations.length,1);
});
test('CAPTCHA room must STOP; cannot be accepted as OFFLINE',async()=>{
 const {result}=await run({[PROFILE]:{dom:profile()},[ROOM]:{dom:{...room(),bodyExcerpt:'验证码'}}});
 assert.equal(result.stoppedForChallenge,true);
 assert.equal(result.observations[0].state,'UNKNOWN');
});
test('unexpected profile redirect cannot be promoted to live',async()=>{
 const {result}=await run({[PROFILE]:{status:200,finalUrl:'https://passport.douyin.com/signin'}});
 assert.equal(result.observations[0].state,'UNKNOWN');
 assert.equal(result.stoppedForChallenge,true);
});
test('a thrown navigation with private details stays sanitized in JSON',async()=>{
 const {result,stats}=await run({[PROFILE]:{throws:true}});
 const serialized=JSON.stringify(result);
 assert.equal(result.observations[0].state,'UNKNOWN');
 assert.doesNotMatch(serialized,/SENSITIVE_UNSAFE_MESSAGE|bodyExcerpt|Cookie|token|session_key/);
 assert.equal(stats.browserClosed,true);
});
test('room id change may be observed but does not prove next session',async()=>{
 const changed='https://live.douyin.com/4444455555';
 const newP={...profile(),liveRoomAnchors:[{href:changed,text:'直播中'}]};
 const {result}=await run({[PROFILE]:{dom:newP},[changed]:{dom:room()}});
 assert.equal(result.observations[0].state,'LIVE');
 assert.equal(result.observations[0].roomIdChanged,true);
 assert.equal(result.observations[0].observedRoomId,'4444455555');
 assert.equal(result.verifiedOpsBridgeCount,0);
 assert.equal(result.exactStartTimesKnown,0);
});
test('context route rejects unsafe write requests and foreign-document navigations',async()=>{
 const {stats}=await run({[PROFILE]:{dom:profile()},[ROOM]:{dom:room()}});
 let decision='';
 const route=(method,url,nav=false)=>({
  request:()=>({method:()=>method,url:()=>url,isNavigationRequest:()=>nav}),
  abort:async()=>{decision='ABORT'},
  continue:async()=>{decision='CONTINUE'},
 });
 await stats.route(route('POST','https://www.douyin.com/path',false));
 assert.equal(decision,'ABORT');
 await stats.route(route('GET','https://malicious.example.org/',true));
 assert.equal(decision,'ABORT');
 await stats.route(route('GET',PROFILE,true));
 assert.equal(decision,'CONTINUE');
});
test('browserFactory failure yields no claims, no thrown secrets',async()=>{
 const result=await runDouyinRpaReadOnly({config,keys:[ACCT.key],
  browserFactory:async()=>{throw Error('PASSWORD_SHOULD_NOT_LEAK')}});
 assert.equal(result.sourceAccess,'BROWSER_UNAVAILABLE');
 assert.equal(result.observations.length,0);
 assert.doesNotMatch(JSON.stringify(result),/PASSWORD_SHOULD_NOT_LEAK/);
});
test('public sample does not output raw title, body or auth state',async()=>{
 const {result}=await run({[PROFILE]:{dom:{...profile(),bodyExcerpt:'抖音号：83165143028 cookie SUPERSECRET LIVE'}},[ROOM]:{dom:room()}});
 assert.doesNotMatch(JSON.stringify(result),/SUPERSECRET|bodyExcerpt|metaDescription|authState|cookies/);
});
test('hard cap to 2 unique public accounts prevents broad unsolicited crawling',()=>{
 const many=[ACCT,{...ACCT,key:'second',profileUrl:PROFILE.replace(SEC,SEC+'z')},
   {...ACCT,key:'third',profileUrl:PROFILE.replace(SEC,SEC+'y')}];
 assert.throws(()=>approvedDouyinRpaTargets({douyin:many},many.map(a=>a.key)),/ONE_OR_TWO/);
});
test('unknown status may not claim official uptime or full-duration performance',async()=>{
 const {result}=await run({[PROFILE]:{dom:{...profile(),liveRoomAnchors:[]}}});
 assert.equal(result.formalOpeningRatePercent,null);
 assert.equal(result.formalFullDurationRatePercent,null);
 assert.equal(result.exactEndTimesKnown,0);
 assert.ok(result.observations.every(x=>x.state!=='OFFLINE'));
});
