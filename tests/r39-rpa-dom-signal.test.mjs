import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalPublicLiveAnchor,normalizedPublicLiveAnchors,safePublicDomDiagnostics,identifyDomGap}
  from '../probes/r39/rpa-dom-signal-utils.mjs';
import {inspectPublicPage,runDouyinRpaReadOnly} from '../probes/r37/rpa-safe-douyin.mjs';

const SEC='MS4wLjABAAAAHLgxNf9c59NqJuH9tm5U2L3E1B6bNBehePdI5rKsZ2s';
const P='https://www.douyin.com/user/'+SEC;
const R='https://live.douyin.com/988541363148';
const ACC={key:'ffalcon-douyin-tv-flagship',accountName:'FFALCON雷鸟电视旗舰店',displayDouyinId:'83165143028',profileUrl:P,roomId:'988541363148',scopeApproved:true};
const profile={title:ACC.accountName+'的抖音 - 抖音',
  bodyExcerpt:'抖音号：83165143028',douyinIdsInPage:['83165143028'],
  rawDomSignal:{totalAnchors:10,liveHostAnchorCount:1,liveLabeledAnchorCount:1,visibleLiveTextMentions:1,liveRelatedButtons:0,domTextLength:900}};
const room={title:ACC.accountName+'的抖音直播间 - 抖音直播',metaDescription:'欢迎来到'+ACC.accountName+'的抖音直播间'};
function mockPage(doms,url=P){
 let idx=0,waits=[];
 const page={
   async goto(){return{status:()=>200}},
   url(){return url},
   async waitForTimeout(ms){waits.push(ms)},
   async evaluate(){return doms[Math.min(idx++,doms.length-1)]},
 };
 return {page,waits,evaluations:()=>idx};
}
const signal=(href,text='',other={})=>({href,text,...other});

test('canonicalizes known public room link with query/trailing slash, never stores tracking',()=>{
 const value=canonicalPublicLiveAnchor(signal(R+'/?from=profile&utm=tracking','直播中'));
 assert.deepEqual(value,{href:R,text:'直播中'});
 assert.doesNotMatch(JSON.stringify(value),/utm|from=profile/);
});
test('uses explicit aria-label when link text is only an icon',()=>{
 assert.deepEqual(canonicalPublicLiveAnchor(signal(R+'?from=home','',{ariaLabel:'正在直播'})),{href:R,text:'直播中'});
});
test('accepts explicit nested accessibility label and title without inferring from unrelated text',()=>{
 assert.ok(canonicalPublicLiveAnchor(signal(R,'',{childLabel:'开播中'})));
 assert.ok(canonicalPublicLiveAnchor(signal(R,'',{title:'直播中'})));
 assert.equal(canonicalPublicLiveAnchor(signal(R,'进入直播间')),null);
});
test('never follows candidate numeric link without explicit live indicator',()=>{
 assert.deepEqual(normalizedPublicLiveAnchors([signal(R,'进入直播间')]),[]);
});
test('rejects non-Douyin links, credentials and non-numeric paths',()=>{
 for(const href of [R.replace('https:','http:'),R.replace('live.douyin.com','live.douyin.com.evil.com'),
  R.replace('https://','https://foo:secret@'),R.replace('988541363148','rooms'),
  'https://www.douyin.com/live/988541363148']){
   assert.equal(canonicalPublicLiveAnchor(signal(href,'直播中')),null);
 }
});
test('deduplicates room candidate references and returns bounded canonical list',()=>{
 assert.deepEqual(normalizedPublicLiveAnchors([signal(R,'直播中'),signal(R+'?x=2','直播中')]),[{href:R,text:'直播中'}]);
});
test('malformed or huge candidate list cannot promote other hosts',()=>{
 const payload=Array.from({length:300},(_,i)=>({href:'https://external.example/'+i,text:'直播中'}));
 assert.deepEqual(normalizedPublicLiveAnchors(payload),[]);
});
test('DOM diagnostics only keep numeric count allowlist and boolean',()=>{
 const m=safePublicDomDiagnostics({totalAnchors:31,liveHostAnchorCount:1,liveLabeledAnchorCount:0,
  visibleLiveTextMentions:2,domTextLength:2200,token:'PRIVATE_COOKIE_123',userEmail:'foo@private',liveRelatedButtons:2},0,true);
 assert.equal(m.delayedDomResample,true);
 assert.deepEqual(Object.keys(m).sort(),[
   'totalAnchors','liveHostAnchorCount','liveLabeledAnchorCount','visibleLiveTextMentions',
   'liveRelatedButtons','domTextLength','validNormalizedAnchors','delayedDomResample'].sort());
 assert.doesNotMatch(JSON.stringify(m),/PRIVATE_COOKIE_123|foo@private/);
});
test('gap reason distinguishes unlabeled room link vs visible live marker without link',()=>{
 assert.equal(identifyDomGap({validNormalizedAnchors:0,liveHostAnchorCount:2,liveLabeledAnchorCount:0}),'ROOM_LINK_WITHOUT_EXPLICIT_LIVE_LABEL');
 assert.equal(identifyDomGap({validNormalizedAnchors:0,liveHostAnchorCount:0,visibleLiveTextMentions:1}),'VISIBLE_LIVE_LABEL_WITHOUT_ROOM_HREF');
 assert.equal(identifyDomGap({validNormalizedAnchors:0,liveHostAnchorCount:0,visibleLiveTextMentions:0,totalAnchors:0,domTextLength:0}),'PUBLIC_DOM_NOT_READY_OR_EMPTY');
});
test('one delayed DOM read finds accessible live candidate missed by initial render',async()=>{
 const {page,waits,evaluations}=mockPage([
  {...profile,liveRoomCandidates:[],rawDomSignal:{...profile.rawDomSignal,liveHostAnchorCount:0,liveLabeledAnchorCount:0}},
  {...profile,liveRoomCandidates:[signal(R+'?from=tab','',{ariaLabel:'直播中'})]},
 ]);
 const r=await inspectPublicPage(page,P,'profile',{holdMs:0});
 assert.deepEqual(r.liveRoomAnchors,[{href:R,text:'直播中'}]);
 assert.equal(r.domDiagnostics.delayedDomResample,true);
 assert.equal(r.domDiagnostics.validNormalizedAnchors,1);
 assert.equal(evaluations(),2);
 assert.deepEqual(waits,[1200]);
});
test('a bare dynamic live text without room href remains diagnostic UNKNOWN',async()=>{
 const {page}=mockPage([{...profile,liveRoomCandidates:[],rawDomSignal:{...profile.rawDomSignal,liveHostAnchorCount:0,liveLabeledAnchorCount:0}}]);
 const r=await inspectPublicPage(page,P,'profile',{holdMs:0});
 assert.equal(r.domGap,'VISIBLE_LIVE_LABEL_WITHOUT_ROOM_HREF');
 assert.equal(r.liveRoomAnchors.length,0);
});
test('profile source blocked with HTTP 403 does not read DOM or retry',async()=>{
 let evals=0;const page={async goto(){return{status:()=>403}},url:()=>P,async evaluate(){evals++;throw Error('SHOULD_NOT_EVALUATE')}};
 const r=await inspectPublicPage(page,P,'profile',{holdMs:0});
 assert.equal(r.accessBlocked,true);assert.equal(evals,0);
});
test('RPA observation preserves unknown despite visible badge without numeric room URL',async()=>{
 const dom={...profile,liveRoomCandidates:[],rawDomSignal:{...profile.rawDomSignal,liveHostAnchorCount:0,liveLabeledAnchorCount:0}};
 const context={async route(){},async newPage(){return{
    async goto(){return{status:()=>200}},url:()=>P,async waitForTimeout(){},async evaluate(){return dom},async close(){},
  }},async close(){}};
 const b={async newContext(){return context},async close(){}};
 const r=await runDouyinRpaReadOnly({config:{douyin:[ACC]},keys:[ACC.key],browserFactory:async()=>b,clock:()=>new Date().toISOString(),holdMs:0});
 assert.equal(r.observations[0].state,'UNKNOWN');
 assert.equal(r.observations[0].profileDomGap,'VISIBLE_LIVE_LABEL_WITHOUT_ROOM_HREF');
 assert.equal(r.formalFullDurationRatePercent,null);
});
test('RPA never promotes unverified room candidate based on profile text alone',()=>{
 const x=normalizedPublicLiveAnchors([signal('https://www.douyin.com/irrelevant','直播中')]);
 assert.equal(x.length,0);
});
