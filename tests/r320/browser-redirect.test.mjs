// Actual Chromium -> guarded first-hop -> loopback server. No external URLs.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {guardedRoute} from '../../probes/r320/network-guard.mjs';
const run=process.env.R320_BROWSER_SMOKE==='1';
test('Chromium refuses a redirected second hop and blocks later navigation after stop',{skip:!run},async t=>{
 const {chromium}=await import('playwright');
 const hits=[];
 const server=http.createServer((req,res)=>{hits.push(req.url);res.writeHead(302,{Location:'/must-not-be-requested'});res.end();});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-background-networking']});
 t.after(()=>browser.close());
 const context=await browser.newContext({serviceWorkers:'block'}),page=await context.newPage();
 const origin=`http://127.0.0.1:${server.address().port}`;
 let stopped=false,reason;
 await context.route('**/*',route=>guardedRoute(route,{policy:info=>({allow:info.url.startsWith(origin+'/')&&info.method==='GET',reason:'SYNTHETIC_LOOPBACK'}),isStopped:()=>stopped,stop:r=>{stopped=true;reason=r;}}));
 await page.goto(origin+'/first',{timeout:5000}).catch(()=>{});
 await page.goto(origin+'/later',{timeout:5000}).catch(()=>{});
 assert.equal(stopped,true);assert.equal(reason,'HTTP_REDIRECT_BLOCKED');assert.deepEqual(hits,['/first']);
});
