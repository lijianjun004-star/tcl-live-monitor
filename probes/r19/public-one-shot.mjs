#!/usr/bin/env node
/** Strict ONE-SHOT PUBLIC Douyin pilot. Never scheduled, no login or retries. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright';
import {createCheck} from '../r18/core/scheduler.mjs';
import {DurableStore} from '../r18/store/index.mjs';
import {corroborateDouyin} from './douyin-bridge.mjs';
import {validateRegistry} from './douyin-first.mjs';

const roster=JSON.parse(await fs.readFile('config/r19-douyin-tcl-ffalcon-registry.json','utf8'));
validateRegistry(roster);
const ids=['tcl-douyin-flagship','ffalcon-douyin-tv-flagship']; // 2 strictly preselected targets, once each
const output=path.resolve('r19-public-pilot-output');
await fs.mkdir(output,{recursive:true});
const store=new DurableStore(path.join(output,'store'));
const summary={started_at:new Date().toISOString(),scope:'TCL + FFALCON read-only one-shot',
 mode:'manual',automatic_schedule:false,source:'public_profile_and_room_page',results:[],
 no_cookies_or_screenshots_stored:true,platform_blocked:false};

const challenge=/验证码|安全验证|滑块|captcha|unusual traffic|异常流量|访问过于频繁|请先登录|登录后观看|扫码登录/i;
const brief=s=>String(s||'').replace(/\s+/g,' ').slice(0,1600);
const errorCode=e=>/TimeoutError|timeout/i.test(String(e))?'TIMEOUT':'NETWORK_ERROR';

const browser=await chromium.launch({headless:true});
const ctx=await browser.newContext({viewport:{width:1280,height:840},locale:'zh-CN'});
const page=await ctx.newPage();

async function captureProfile(target){
 let response;
 try {response=await page.goto(target.profile_url,{waitUntil:'domcontentloaded',timeout:28000});}
 catch(e){return {error_code:errorCode(e),observed_at:new Date().toISOString()};}
 await page.waitForTimeout(5000);
 const p=await page.evaluate(()=>({
  title:document.title,
  body_excerpt:(document.body?.innerText||'').slice(0,1600),
  live_anchors:[...document.querySelectorAll('a[href]')]
    .filter(a=>a.href.startsWith('https://live.douyin.com/'))
    .slice(0,25).map(a=>({href:a.href,text:((a.innerText||'')+' '+(a.parentElement?.innerText||'')).replace(/\s+/g,' ').slice(0,120)}))
 }));
 return {...p,profile_url:page.url().split('?')[0],httpStatus:response?.status()??null,
  observed_at:new Date().toISOString()};
}

async function captureRoom(route,webcast){
 let response;
 const intended='https://live.douyin.com/'+route+'?room_id='+webcast;
 try {response=await page.goto(intended,{waitUntil:'domcontentloaded',timeout:28000});}
 catch(e){return {error_code:errorCode(e),url:page.url(),observed_at:new Date().toISOString()};}
 await page.waitForTimeout(4500);
 const s=await page.evaluate(()=>({
  title:document.title,
  bodyExcerpt:(document.body?.innerText||'').slice(0,1400),
  metaDescription:document.querySelector('meta[name="description"]')?.content||''
 }));
 return {...s,url:page.url(),httpStatus:response?.status()??null,observed_at:new Date().toISOString()};
}

try{
 for(const key of ids){
  const t=roster.targets.find(x=>x.key===key);
  if(!t)throw Error('MISSING_PILOT_TARGET');
  const issued=new Date().toISOString();
  const check=createCheck({platform:'douyin',account_id:t.display_douyin_id,mode:'manual',
   request_id:'r19-public-pilot-'+key+'-'+issued,actual_check_at:issued});
  let proof,stop=false;
  const adapter=async()=>{
   const profile=await captureProfile(t);
   const profileBlocked=!!profile.error_code||profile.httpStatus!==200||
     challenge.test(String(profile.title||'')+' '+String(profile.body_excerpt||''));
   const preview=profileBlocked?null:corroborateDouyin(profile,null,t,{now:new Date().toISOString()});
   let room=null;
   if(!profileBlocked&&preview?.profile_badge&&preview.live_route_id&&preview.dynamic_room_id){
    room=await captureRoom(preview.live_route_id,preview.dynamic_room_id);
   }
   proof=profileBlocked?
     {state:'UNKNOWN',source_attested:false,reason:profile.error_code||'ACCESS_OR_AUTH_BLOCKED',
      profile_badge:false,room_id:null,dynamic_room_id:null,live_id:null,room_page_second_verification:false,
      observed_at:new Date().toISOString()}:
     corroborateDouyin(profile,room,t,{now:new Date().toISOString()});
   if(profileBlocked||proof.reason==='ROOM_ACCESS_OR_ENDED'||
     proof.reason==='ACCESS_OR_AUTH_BLOCKED'){
    stop=true;
   }
   const actual=new Date().toISOString();
   return {platform:'douyin',account_id:t.display_douyin_id,expected_account_id:t.display_douyin_id,
    state:proof.state,live_id:proof.live_id,room_id:proof.room_id,
    source_attested:proof.source_attested,source_type:'public_profile_room_pair',
    failure_code:proof.state==='LIVE'?null:proof.reason,
    actual_check_at:actual,planned_check_at:check.planned_check_at,
    observed_at:proof.observed_at||actual};
  };
  const result=await (await import('../r18/core/monitor.mjs')).runCheck({
   store,adapter,check,cooldown_ms:3600000
  });
  summary.results.push({key,account_id:t.display_douyin_id,state:result.observation.state,
   failure_code:result.observation.failure_code,
   profile_live_badge_observed:!!proof?.profile_badge,
   live_route_id:proof?.room_id||null,
   dynamic_room_id:proof?.dynamic_room_id||null,
   room_page_second_verification:!!proof?.room_page_second_verification,
   captured_at:result.observation.actual_check_at});
  console.log(JSON.stringify(summary.results.at(-1)));
  if(stop){summary.platform_blocked=true;break;}
 }
}finally{
 await browser.close();
 summary.completed_at=new Date().toISOString();
 await fs.writeFile(path.join(output,'results.json'),JSON.stringify(summary,null,2)+'\n');
 await fs.writeFile(path.join(output,'store-state.json'),
  JSON.stringify(store.snapshot(),null,2)+'\n');
}
