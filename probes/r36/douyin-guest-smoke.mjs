/**
 * R3.6 read-only public-guest Douyin verification (independent experiment).
 * Zero login, cookies, captcha handling, proxy tricks, request replay, private
 * APIs or background schedule. No private reference-site IP is visited here.
 * The main monitor is never modified. All output is minimized.
 */
import fs from 'node:fs/promises';
import {chromium} from 'playwright';
import {CHALLENGE_RE, LOGIN_GATE_RE, profileIdentity,liveAnchorRoomIds} from '../lib/douyin.mjs';
import {buildApprovedDouyinRegistry,projectDouyinGuestObservation} from './douyin-reference-contract.mjs';

const WALL=/(验证码|安全验证|滑块|captcha|请先登录|登录后观看|扫码登录|登录抖音)/i;
const DEFAULT_KEYS=['tcl-douyin-flagship','tcl-douyin-tv-official-live'];

export function chosenKeys(str){
 const keys=String(str||DEFAULT_KEYS.join(',')).split(',').map(x=>x.trim()).filter(Boolean);
 if(!keys.length||keys.length>2||new Set(keys).size!==keys.length)throw Error('ONLY_TWO_UNIQUE_APPROVED_TARGETS');
 if(!keys.every(k=>/^[a-z0-9-]{3,72}$/.test(k)))throw Error('INVALID_TARGET_KEY');
 return keys;
}
export function isAccessWall(page){
 return page.httpStatus===401||page.httpStatus===403||page.httpStatus===429||
   page.finalHost==='passport.douyin.com' ||
   WALL.test(String(page.title||'')+' '+String(page.bodyExcerpt||'').slice(0,300)) ||
   CHALLENGE_RE.test(String(page.title||'')+' '+String(page.bodyExcerpt||'')) ||
   LOGIN_GATE_RE.test(String(page.bodyExcerpt||''));
}
async function guestSnapshot(page,url,expectedHost){
 const out={httpStatus:null,title:'',bodyExcerpt:'',metaDescription:'',douyinIdsInPage:[],liveRoomAnchors:[],finalHost:null};
 try{
   const response=await page.goto(url,{waitUntil:'domcontentloaded',timeout:20000});
   out.httpStatus=response?.status()??null;
   const final=new URL(page.url());
   out.finalHost=final.hostname;
   if(final.hostname!==expectedHost)return {...out,accessBlocked:true};
   if(out.httpStatus!==200)return {...out,accessBlocked:true};
   await page.waitForTimeout(1800);
   const snap=await page.evaluate(()=>({
     title:String(document.title||'').slice(0,160),
     bodyExcerpt:String(document.body?.innerText||'').replace(/\s+/g,' ').slice(0,700),
     metaDescription:String(document.querySelector('meta[name="description"]')?.content||'').slice(0,170),
     douyinIdsInPage:[...String(document.body?.innerText||'').matchAll(/抖音号[:：]\s*([A-Za-z0-9._-]{3,32})/g)].slice(0,5).map(x=>x[1]),
     liveRoomAnchors:[...document.querySelectorAll('a[href]')]
       .map(x=>({href:String(x.href||''),text:String(x.textContent||'').replace(/\s+/g,' ').slice(0,35)}))
       .filter(x=>/^https:\/\/live\.douyin\.com\/\d{5,24}(?:[/?#]|$)/.test(x.href))
       .slice(0,10)
   }));
   return {...out,...snap};
 }catch(e){
   return {...out,accessBlocked:true,error:'PUBLIC_GUEST_NAVIGATION_FAILED'};
 }
}

export async function runGuestProbe({keys=DEFAULT_KEYS,roster,browserFactory=()=>chromium.launch({headless:true,args:['--no-sandbox']})}={}){
 const selected=new Map(roster.map(a=>[a.key,a]));
 if(!Array.isArray(keys)||!keys.length||keys.length>2||keys.some(k=>!selected.has(k)))throw Error('TARGET_NOT_APPROVED');
 const report={schemaVersion:36,mode:'MANUAL_PUBLIC_GUEST_ONLY',at:new Date().toISOString(),
  referenceSiteAccess:'BLOCKED_403_NOT_INSPECTED',offlineRuleValidated:false,
  readiness:'NOT_VERIFIED',observations:[],stoppedForChallenge:false,
  formalOpeningRate:null,formalDurationRate:null};
 const browser=await browserFactory();
 try{
   const ctx=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,locale:'zh-CN'});
   for(const key of keys){
     const account=selected.get(key);
     const page=await ctx.newPage();
     const profile=await guestSnapshot(page,account.profileUrl,'www.douyin.com');
     await page.close();
     if(isAccessWall(profile)||profile.accessBlocked){
       report.observations.push({accountKey:key,platform:'douyin',state:'UNKNOWN',reason:'GUEST_ACCESS_BLOCKED_OR_NETWORK',
         profileHttp:profile.httpStatus,checkedAt:new Date().toISOString(),scoringEligible:account.scoringEligible,
         exactStartAt:null,exactEndAt:null});
       report.stoppedForChallenge=true;break;
     }
     const ids=profileIdentity(profile,{accountName:account.accountName,displayDouyinId:account.displayDouyinId})
       ?liveAnchorRoomIds(profile):[];
     const id=ids[0]||account.configuredRoomId||null;
     let room=null;
     if(id){
       const rp=await ctx.newPage();
       room=await guestSnapshot(rp,'https://live.douyin.com/'+id,'live.douyin.com');
       await rp.close();
       if(isAccessWall(room)||room.accessBlocked){
         report.observations.push({accountKey:key,platform:'douyin',state:'UNKNOWN',reason:'ROOM_ACCESS_BLOCKED_OR_NETWORK',
           roomHttp:room.httpStatus,checkedAt:new Date().toISOString(),scoringEligible:account.scoringEligible,
           exactStartAt:null,exactEndAt:null});
         report.stoppedForChallenge=true;break;
       }
     }
     const result=projectDouyinGuestObservation({account,profile,room,checkedAt:new Date().toISOString()});
     report.observations.push({accountKey:key,platform:'douyin',state:result.state,reason:result.reason,
       checkedAt:result.checkedAt,profileHttp:profile.httpStatus,roomHttp:room?.httpStatus??null,
       verifiedProfile:result.profileIdentityVerified,verifiedRoom:result.roomIdentityVerified,
       observedRoomId:result.observedRoomId,roomIdChanged:result.roomIdChanged,
       scoringEligible:result.scoringEligible,exactStartAt:null,exactEndAt:null});
     await new Promise(resolve=>setTimeout(resolve,1800));
   }
   await ctx.close();
 }finally{await browser.close().catch(()=>{});}
 const usable=report.observations.filter(o=>o.state==='LIVE'||(o.state==='UNKNOWN'&&o.reason!=='GUEST_ACCESS_BLOCKED_OR_NETWORK'&&o.reason!=='ROOM_ACCESS_BLOCKED_OR_NETWORK'));
 report.readiness=usable.length?'PARTIAL_PUBLIC_GUEST_EVIDENCE':'BLOCKED_GUEST_ACCESS';
 return report;
}

if(process.argv[1]?.endsWith('/douyin-guest-smoke.mjs')){
 const config=JSON.parse(await fs.readFile('config/probe-targets.json','utf8'));
 const roster=buildApprovedDouyinRegistry(config);
 const keys=chosenKeys(process.env.DOUYIN_KEYS);
 const report=await runGuestProbe({keys,roster});
 await fs.mkdir('out/r36',{recursive:true});
 await fs.writeFile('out/r36/douyin-guest-evidence.json',JSON.stringify(report,null,2)+'\n');
 console.log('R36_DOUYIN_GUEST_READINESS='+report.readiness);
 for(const o of report.observations)console.log(JSON.stringify(o));
 console.log('UNKNOWN is not OFFLINE. Manual guest snapshots do not prove exact broadcast start/end or formal performance.');
}
