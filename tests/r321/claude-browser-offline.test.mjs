// R3.21: Chromium localhost-only browser tests (no Douyin access).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { guardedRoute, disableUnroutedChannels } from '../../probes/r320/network-guard.mjs';
import { liveAnchorScope } from '../../probes/lib/douyin.mjs';

const run=process.env.R320_BROWSER_SMOKE==='1';
const listen=s=>new Promise(resolve=>s.listen(0,'127.0.0.1',()=>resolve(s.address().port)));
const close=s=>new Promise(resolve=>s.close(resolve));

test('Chromium: WebSocketStream and WebTransport cannot connect to unauthorized receiver', {skip:!run},async()=>{
  const {chromium}=await import('playwright');
  let tcp=0, upgrades=0;
  const sink=http.createServer((_req,res)=>{res.writeHead(404);res.end();});
  sink.on('connection',()=>tcp++);sink.on('upgrade',(_req,s)=>{upgrades++;s.destroy()});
  const p2=await listen(sink);
  const html='<!doctype html><title>LOCAL</title><script>window.__review={};'+
    "for(const [key,url] of [["+
    "'WebSocketStream','ws://127.0.0.1:"+p2+"/ws'],["+
    "'WebTransport','https://127.0.0.1:"+p2+"/wt'],["+
    "'WebSocket','ws://127.0.0.1:"+p2+"/ws']]){"+
    "try{const o=new window[key](url);window.__review[key]='CONSTRUCTED';o.opened?.catch?.(()=>{});o.ready?.catch?.(()=>{});}"+
    "catch{window.__review[key]='BLOCKED';}}</script>";
  const site=http.createServer((_req,res)=>{res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(html)});
  const p1=await listen(site);let browser;
  try{
    browser=await chromium.launch({headless:true,args:['--no-sandbox']});
    const ctx=await browser.newContext({serviceWorkers:'block'});
    await ctx.addInitScript(disableUnroutedChannels);
    await ctx.route('**/*',route=>guardedRoute(route,{
      policy:({url,method})=>({allow:new URL(url).port===String(p1)&&method==='GET',reason:'SYNTHETIC_LOCAL_ONLY'})
    }));
    await ctx.routeWebSocket(/.*/,ws=>ws.close());
    const page=await ctx.newPage();
    await page.goto('http://127.0.0.1:'+p1+'/',{waitUntil:'domcontentloaded',timeout:20000});
    await page.waitForTimeout(500);
    assert.deepEqual(await page.evaluate(()=>window.__review),{
      WebSocketStream:'BLOCKED',WebTransport:'BLOCKED',WebSocket:'BLOCKED'
    });
    assert.equal(tcp,0,'unauthorized TCP connections must be ZERO');
    assert.equal(upgrades,0);
    await ctx.close();
  }finally{
    if(browser)await browser.close().catch(()=>{});
    await close(site);await close(sink);
  }
});
test('Chromium: recommended card under main header must not be owner', {skip:!run},async()=>{
  const {chromium}=await import('playwright');
  const src=fs.readFileSync('probes/r316/douyin-rpa-two-once.mjs','utf8');
  const extractor=/const data = await page\.evaluate\((\(\) => \{[\s\S]*?\n    \})\);/.exec(src)?.[1];
  assert.ok(extractor,'real probe extractor present');
  const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
  try {
    const ctx=await browser.newContext();await ctx.route('**/*',route=>route.abort('blockedbyclient'));
    const page=await ctx.newPage();
    const get=async html=>{await page.setContent(html);return {httpStatus:200,...(await page.evaluate('('+extractor+')()'))};};
    const reco=await get('<main><div data-e2e="user-info">抖音号：SYNTHETIC</div><section><article><header><a href="https://live.douyin.com/30000000003">直播中</a></header></article></section></main>');
    assert.equal(liveAnchorScope(reco).scope,'NO_OWNER_HEADER_LIVE_ANCHOR');
    const owner=await get('<main><div data-e2e="user-info">抖音号：SYNTHETIC<a href="https://live.douyin.com/20000000002">直播中</a></div></main>');
    assert.deepEqual(liveAnchorScope(owner),{scope:'OWNER_HEADER_LIVE_ANCHOR',roomId:'20000000002'});
    const wrong=await get('<main><section><header><a href="https://www.douyin.com/user/SYNTHETIC">推荐</a></header></section></main>');
    assert.deepEqual(wrong.ownerProfileLinks,[]);
    await ctx.close();
  } finally {await browser.close();}
});
