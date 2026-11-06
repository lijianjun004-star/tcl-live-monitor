// Manual candidate-only verification. Never promotes ownership or scoring.
import fs from 'node:fs/promises';
import {chromium} from 'playwright';
import {decideDouyin, profileIdentity, liveAnchorRoomIds} from './lib/douyin.mjs';
import {accessCue} from './lib/access-cue.mjs';
const {candidates}=JSON.parse(await fs.readFile('config/r097-candidate-probe.json','utf8'));
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
const ctx=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,locale:'zh-CN'});
const rows=[];let stopped=false;
const wall=p=>accessCue({...p,text:p.bodyExcerpt});
async function snapshot(url){
 const page=await ctx.newPage();
 try{
  const resp=await page.goto(url,{waitUntil:'domcontentloaded',timeout:25000});await page.waitForTimeout(5000);
  const data=await page.evaluate(()=>({title:document.title,bodyExcerpt:(document.body?.innerText||'').slice(0,3000),metaDescription:document.querySelector('meta[name="description"]')?.content||'',douyinIdsInPage:[...(document.body?.innerText||'').matchAll(/抖音号[:：]\s*([A-Za-z0-9._-]{3,32})/g)].map(m=>m[1]),liveRoomAnchors:[...document.querySelectorAll('a[href]')].filter(a=>/^https:\/\/live\.douyin\.com\/\d/.test(a.href)).map(a=>({href:a.href,text:a.innerText||a.textContent||''})).slice(0,15)}));
  const final=new URL(page.url());return {httpStatus:resp?.status(),finalHost:final.hostname,finalPath:final.pathname,...data};
 }catch(e){return {httpStatus:null,navigationError:String(e.message).slice(0,100)};}finally{await page.close();}
}
try{
 for(const t of candidates){
  if(stopped){rows.push({key:t.key,state:'UNKNOWN',reason:'SKIPPED_AFTER_ACCESS_WALL',scoringEligible:false});continue;}
  const profile=await snapshot(t.profileUrl);let room=null,stopEvidence=wall(profile);
  if(stopEvidence)stopped=true;
  else if(profileIdentity(profile,t)){
   const id=liveAnchorRoomIds(profile)[0];
   if(id){await new Promise(r=>setTimeout(r,5000));room=await snapshot(`https://live.douyin.com/${id}`);stopEvidence=wall(room);if(stopEvidence)stopped=true;}
  }
  const d=stopped?{state:'UNKNOWN',reason:'ACCESS_WALL_STOPPED'}:decideDouyin(profile,room,t);
  const row={key:t.key,name:t.accountName,douyinId:t.displayDouyinId,profileUrl:t.profileUrl,at:new Date().toISOString(),...d,stopEvidence,ownershipVerified:false,scoringEligible:false,completionRate:null,completionReason:'NO_VERIFIED_SCHEDULE_OR_CONTINUOUS_OBSERVATIONS'};
  rows.push(row);console.log(JSON.stringify(row));
  if(!stopped)await new Promise(r=>setTimeout(r,5000));
 }
}finally{await browser.close();await fs.writeFile('r097-candidate-status.json',JSON.stringify({stopped,results:rows},null,2));}
