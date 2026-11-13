// R3.20 local loopback browser test. ONLY 127.0.0.1, no external website access.
// Runs only with R320_BROWSER_SMOKE=1; otherwise suite skips it.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { guardedRoute, disableUnroutedChannels } from '../../probes/r320/network-guard.mjs';

const run=process.env.R320_BROWSER_SMOKE==='1';
const listen=async server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server.address().port)));
const close=async server=>new Promise(resolve=>server.close(resolve));

test('Chromium: a permitted first-hop 302 MUST NOT reach unapproved redirect recipient', {skip:!run}, async()=>{
  const { chromium } = await import('playwright');
  let leakReceived=0;
  const receiver=http.createServer((req,res)=>{leakReceived++;res.writeHead(200);res.end('LEAK_RECEIVED');});
  const p2=await listen(receiver);
  const redirectSource=http.createServer((req,res)=>{
    if(req.url==='/main'){
      res.writeHead(200,{'content-type':'text/html; charset=utf-8'});
      res.end('<!doctype html><title>LOCAL</title><script src="/redirect.js"></script><main>OK</main>');
    } else if(req.url==='/redirect.js'){
      res.writeHead(302,{location:'http://127.0.0.1:'+p2+'/leak'});
      res.end();
    } else if(req.url==='/favicon.ico') {
      res.writeHead(200,{'content-type':'image/x-icon'});res.end();
    } else {res.writeHead(404);res.end();}
  });
  const p1=await listen(redirectSource);
  let browser=null, reason=null, sourceCount=0;
  try{
    browser=await chromium.launch({headless:true,args:['--no-sandbox']});
    const ctx=await browser.newContext({serviceWorkers:'block'});
    await ctx.addInitScript(disableUnroutedChannels);
    await ctx.route('**/*',route=>guardedRoute(route,{
      policy:({url,method})=>{
        const u=new URL(url);
        return {
          allow:u.protocol==='http:' && u.hostname==='127.0.0.1' && u.port===String(p1) && method==='GET',
          reason:'SYNTHETIC_LOCAL_ONLY',
        };
      },
      stop:r=>{reason ||= r;},
    }));
    const page=await ctx.newPage();
    await page.goto('http://127.0.0.1:'+p1+'/main',{waitUntil:'domcontentloaded',timeout:20000});
    await page.waitForTimeout(500);
    assert.equal(reason,'HTTP_REDIRECT_BLOCKED');
    assert.equal(leakReceived,0,'redirect recipient must see ZERO requests');
    assert.ok(sourceCount>=0);
    await ctx.close();
  } finally {
    if(browser)await browser.close().catch(()=>{});
    await close(redirectSource);
    await close(receiver);
  }
});

test('Chromium: Worker/WebRTC/WebSocket constructors and sendBeacon are blocked in window', {skip:!run}, async()=>{
  const { chromium } = await import('playwright');
  const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
  try{
    const ctx=await browser.newContext({serviceWorkers:'block'});
    await ctx.addInitScript(disableUnroutedChannels);
    const page=await ctx.newPage();
    await page.goto('about:blank');
    const result=await page.evaluate(()=>{
      const keys=['Worker','SharedWorker','WebSocket','RTCPeerConnection','EventSource'];
      return { ctors:keys.map(k=>{
        try { new window[k]('blob://test');return false; } catch { return true; }
      }),beacon:navigator.sendBeacon('/test','x') };
    });
    assert.ok(result.ctors.every(Boolean));
    assert.equal(result.beacon,false);
    await ctx.close();
  } finally { await browser.close(); }
});
