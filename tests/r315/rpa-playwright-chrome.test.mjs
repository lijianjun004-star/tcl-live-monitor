import test from 'node:test';
import assert from 'node:assert/strict';
import {installOfflineRpaContextBoundary} from '../../probes/r315/rpa-playwright-context.mjs';

const profile='https://www.douyin.com/user/MS4wLjABAAAA'+'a'.repeat(24);
test('real system Chrome Playwright main-frame allowlist, iframe rejection and WebRTC guard',
 {skip:process.env.R315_CHROME_SMOKE!=='1'},async()=>{
  const {chromium}=await import('playwright');
  const browser=await chromium.launch({channel:'chrome',headless:true});
  let ctx;
  try{
   ctx=await browser.newContext({viewport:{width:390,height:844},isMobile:true,
      serviceWorkers:'block',acceptDownloads:false});
   const html='<!doctype html><html><body><h1 id="rpa">LOCAL RPA SAFE</h1>'+
     '<iframe src="'+profile+'"></iframe>'+
     '<script>window.webrtcBlocked = typeof RTCPeerConnection==="undefined";'+
     'fetch("https://invalid.example/api/secret").catch(()=>{window.fetchDenied=true})'+
     '</script></body></html>';
   const {rejectedRequests,outboundAllowed,mode}=await installOfflineRpaContextBoundary(ctx,{
    fixtureDocuments:{[profile]:html}});
   const page=await ctx.newPage();
   const x=await page.goto(profile,{waitUntil:'domcontentloaded'});
   assert.equal(x.status(),200);
   assert.equal(await page.locator('#rpa').textContent(),'LOCAL RPA SAFE');
   assert.equal(await page.evaluate(()=>window.webrtcBlocked),true);
   await page.waitForFunction(()=>window.fetchDenied===true,{timeout:5000});
   assert.equal(mode,'OFFLINE_FIXTURE_ONLY');
   assert.equal(outboundAllowed,false);
   assert.ok(rejectedRequests.some(x=>x.type==='fetch'));
   assert.ok(rejectedRequests.some(x=>x.type==='document'));
   assert.ok(rejectedRequests.every(x=>['GET','HEAD'].includes(x.method)));
   await page.close();
  } finally {if(ctx)await ctx.close();await browser.close()}
});
test('cannot use offline browser harness without explicit approved fixture documents',async()=>{
 await assert.rejects(installOfflineRpaContextBoundary({route(){},addInitScript(){}},{}),
 /R315_BROWSER_CONTEXT_INVALID/);
});
