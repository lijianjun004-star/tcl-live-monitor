// Public page links only. No shopId -> roomId inference; stop a platform on a wall.
import fs from 'node:fs/promises';
import {chromium} from 'playwright';
const seeds=JSON.parse(await fs.readFile('config/r097-store-seeds.json','utf8'));
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});const ctx=await browser.newContext({locale:'zh-CN'});
const blocked=new Set(),results=[];
try{for(const t of seeds){
 if(blocked.has(t.platform)){results.push({...t,result:'SKIPPED_PLATFORM_WALLED'});continue;}
 const page=await ctx.newPage();let row={...t,state:'UNKNOWN',scoringEligible:false};
 try{const resp=await page.goto(t.url,{waitUntil:'domcontentloaded',timeout:25000});await page.waitForTimeout(5000);
 const p=await page.evaluate(()=>({title:document.title,text:(document.body?.innerText||'').replace(/\s+/g,' ').slice(0,1200),links:[...document.querySelectorAll('a[href]')].map(a=>({text:(a.innerText||'').trim().slice(0,80),href:a.href})).filter(a=>/直播|旗舰店|京东|天猫|淘宝|抖音/.test(a.text)||/lives\.jd\.com|live\.douyin\.com|taolive/.test(a.href)).slice(0,40)}));
 const final=new URL(page.url());const wall=/passport|login|captcha|verify/i.test(final.hostname+final.pathname)||/验证码|安全验证|滑块验证|扫码登录|请先登录|访问过于频繁/.test(p.title+' '+p.text);
 if(wall)blocked.add(t.platform);
 row={...row,http:resp?.status(),title:p.title,finalHost:final.hostname,result:wall?'WALLED':resp?.status()===200?'PAGE_READ':'HTTP_ERROR',links:wall?[]:p.links};
 }catch(e){row.result='NAV_ERROR';row.error=String(e.message).slice(0,120);}finally{await page.close();}
 results.push(row);console.log(JSON.stringify(row));await new Promise(r=>setTimeout(r,5000));
}}finally{await browser.close();await fs.writeFile('r097-store-discovery.json',JSON.stringify({blocked:[...blocked],results},null,2));}
