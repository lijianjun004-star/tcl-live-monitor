#!/usr/bin/env node
/**
 * R1.7 single-account manual guest-page reader.
 * Invoked ONLY with --manual-public-page. Never scheduled, no login, cookies,
 * request signing, captcha bypass, direct calls to hidden API or replay.
 * Receives the live-detail response PASSIVELY while the normal page loads.
 * Separate ledger, no writes to GitHub/other sites. No official start/stop time.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {FIRST_TARGET} from './lib/r12-tmall-first.mjs';
import {LIVE_PAGE,LIVE_DETAIL_HOST,LIVE_DETAIL_PATH,parseJSONOrJSONP} from './lib/tmall.mjs';
import {candidateFromLiveDetail,reduceAccountSessions} from './lib/r17-session-follow.mjs';

const argv=process.argv.slice(2),has=x=>argv.includes(x);
const arg=(x,fallback)=>{const i=argv.indexOf(x);return i<0?fallback:argv[i+1];};
const dir=arg('--out-dir','r17-account-manual-preview');
const input=arg('--ledger',null);
if(!dir||has('--schedule'))throw Error('INVALID_ARGS_OR_SCHEDULE_NOT_SUPPORTED');
const manual=has('--manual-public-page');
const now=new Date().toISOString();
const EMPTY=()=>({at:new Date().toISOString(),state:'UNKNOWN',reason:'NO_APPROVED_PUBLIC_SOURCE',
 accountId:FIRST_TARGET.accountId,sourceAttested:false});
function guardJournal(v){
 if(!v||typeof v!=='object'||v.schemaVersion!==17||
   v.accountId!==FIRST_TARGET.accountId||v.storeKey!==FIRST_TARGET.accountStableId||
   !Array.isArray(v.observations)||v.observations.length>3000)
  throw Error('INVALID_LEDGER_IDENTITY_OR_SCHEMA');
 for(const s of v.observations){
  if(!s||s.accountId!==FIRST_TARGET.accountId||
    typeof s.at!=='string'||!Number.isFinite(Date.parse(s.at))||
    !['LIVE','OFFLINE','UNKNOWN'].includes(s.state))throw Error('INVALID_PREVIOUS_OBSERVATION');
 }
 return v;
}
let previous={schemaVersion:17,accountId:FIRST_TARGET.accountId,storeKey:FIRST_TARGET.accountStableId,
 observations:[],attempts:[]};
if(input)previous=guardJournal(JSON.parse(await fs.readFile(input,'utf8')));
if(previous.attempts?.length>3000)throw Error('ATTEMPT_LIMIT');
if(previous.observations.length&&Date.parse(previous.observations.at(-1).at)>=Date.parse(now))
 throw Error('NON_MONOTONIC_OBSERVATION');
let newest=EMPTY(),access={mode:manual?'MANUAL_PUBLIC_BROWSER':'OFFLINE_NO_PAGE',
 pageHttp:null,passiveResponses:0,eligibleResponses:0,
 visitAttempted:false,sourceConnected:false,challengeDetected:false};
if(manual){
 const {chromium}=await import('playwright');
 const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
 try {
  const context=await browser.newContext({locale:'zh-CN',viewport:{width:390,height:844}});
  const page=await context.newPage(),pending=[];
  page.on('response',r=>{
   let u;try{u=new URL(r.url());}catch{return;}
   if(u.hostname!==LIVE_DETAIL_HOST||u.pathname!==LIVE_DETAIL_PATH)return;
   access.passiveResponses++;
   pending.push((async()=>{
    try{
     if(r.status()!==200)return null;
     const type=String(r.headers()['content-type']||'');
     if(!/json|javascript|text\/plain/i.test(type))return null;
     const body=await r.text();
     if(body.length>500000)return null;
     const c=candidateFromLiveDetail(parseJSONOrJSONP(body),{checkedAt:new Date().toISOString()});
     if(['LIVE','OFFLINE'].includes(c.state))access.eligibleResponses++;
     return c;
    }catch{return null;}
   })());
  });
  access.visitAttempted=true;
  try{
   const nav=await page.goto(LIVE_PAGE+encodeURIComponent(FIRST_TARGET.accountId),
     {waitUntil:'domcontentloaded',timeout:25000});
   access.pageHttp=nav?.status()??null;
   await page.waitForTimeout(6000);
   const result=await page.evaluate(()=>({
    title:String(document.title||'').slice(0,150),
    text:String(document.body?.innerText||'').slice(0,4000)
   }));
   access.challengeDetected=/unusual traffic|人机验证|验证码|异常流量|verify.*human|security verification/i
     .test(result.title+'\n'+result.text);
   const all=(await Promise.allSettled(pending))
     .filter(x=>x.status==='fulfilled'&&x.value).map(x=>x.value);
   if(access.challengeDetected)newest={...EMPTY(),reason:'CAPTCHA_OR_SECURITY_BLOCK'};
   else if(access.pageHttp!==200)newest={...EMPTY(),reason:'PAGE_HTTP_NOT_OK'};
   else if(!all.length)newest={...EMPTY(),reason:'NO_PASSIVE_LIVE_DETAIL_EVIDENCE'};
   else{
    const valid=all.filter(x=>['LIVE','OFFLINE'].includes(x.state));
    const signatures=new Set(valid.map(x=>[x.state,x.roomNumber,x.liveId||''].join('/')));
    if(signatures.size>1)newest={...EMPTY(),reason:'CONFLICTING_RESPONSES_IN_SAME_PAGE_LOAD'};
    else if(valid.length){
     const latest=valid.at(-1);
     newest={...latest,sourceAttested:true,sourceKind:'NORMAL_PAGE_PASSIVE_RESPONSE'};
     access.sourceConnected=true;
    }else newest={...EMPTY(),reason:all.at(-1).reason||'UNKNOWN_PLATFORM_RESPONSE'};
   }
  }catch{newest={...EMPTY(),reason:'PUBLIC_PAGE_NAVIGATION_FAILED'};}
  finally{await context.close();}
 } finally{await browser.close();}
}
const observations=[...previous.observations,newest];
const report=reduceAccountSessions(observations,{asOf:new Date().toISOString()});
const out=path.resolve(dir);
await fs.mkdir(out,{recursive:true});
const attempt={plannedBeijingHour:new Date(Math.floor(Date.parse(now)/3600000)*3600000).toISOString(),
 actualCheckAt:newest.at,sourceConnected:access.sourceConnected,reason:newest.reason||null,
 state:newest.sourceAttested===true?newest.state:'UNKNOWN',mode:access.mode};
const ledger={schemaVersion:17,accountId:FIRST_TARGET.accountId,storeKey:FIRST_TARGET.accountStableId,
 observations,attempts:[...(previous.attempts||[]),attempt]};
const temp=path.join(out,'.r17-state.tmp');
await fs.writeFile(temp,JSON.stringify(ledger,null,2)+'\n');
await fs.rename(temp,path.join(out,'state.json'));
await fs.writeFile(path.join(out,'report.json'),JSON.stringify({
  ...report,access,realDataObtained:access.sourceConnected,
  exactBroadcastTimesKnown:false,manuallyTriggered:manual
},null,2)+'\n');
console.log(JSON.stringify({
  accountId:FIRST_TARGET.accountId,plannedBeijingHour:attempt.plannedBeijingHour,
  actualCheckAt:newest.at,actualState:attempt.state,sourceConnected:access.sourceConnected,
  reason:attempt.reason,liveId:attempt.state==='LIVE'?newest.liveId:null,
  roomsInLedger:report.sessions.map(s=>s.roomNumbers),
  sessionCount:report.sessions.length,outputDir:out,
  note:'No source was queried unless --manual-public-page. No exact start/end claims.'
},null,2));
