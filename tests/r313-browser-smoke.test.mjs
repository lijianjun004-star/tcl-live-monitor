import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
// Browser dependency is loaded ONLY in the dedicated smoke workflow.

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const head=['序号','内部房间ID','内部店铺ID','来源类目(11-11)','来源类目(11-07原值)',
 '采集绑定','第1层 房间→店铺','11-07是否已存在','第2层 店铺→公开账号secUid',
 '第2层证据(原件位置/截图/导出)','第3层 账号→公开直播间ID','第3层证据',
 '第4层 跨系统桥接','审核人','审核时间','当前状态','说明'];
const quote=x=>{const s=String(x||'');return /[",\n]/.test(s)?'"'+s.replaceAll('"','""')+'"':s};
const csv='\uFEFF'+head.join(',')+'\r\n'+Array.from({length:10},(_,i)=>[
 i+1,300+i,600+i,i===2?'未核实':'电视',i===2?'家电':'电视',
 i===0?'是':'否','VERIFIED(来源接口 11-11)','是','UNVERIFIED','',
 'UNVERIFIED','','UNVERIFIED','','','UNKNOWN','合成测试',
].map(quote).join(',')).join('\r\n')+'\r\n填写规则,"仅离线测试"';
const source={schemaVersion:311,rooms:Array.from({length:10},(_,i)=>({
 opsRoomId:String(300+i),opsShopId:String(600+i),platform:'dy',category:i===2?'家电':'电视',
 captureBound:i===0,opsShopIdentityMatched:true}))};
const sec='MS4wLjABAAAAHLgxNf9c59NqJuH9tm5U2L3E1B6bNBehePdI5rKsZ2s';
const registry={douyin:[{key:'fake-approved',scopeApproved:true,
 profileUrl:'https://www.douyin.com/user/'+sec}]};
function fixture(name,content,mimeType){return{name,mimeType,buffer:Buffer.from(content)}}
test('real headless Chrome opens mobile workbench, audits 10 synthetic rows, never sends remote request',{skip:process.env.R313_BROWSER_SMOKE!=='1'},async()=>{
 const {chromium}=await import('playwright');
 const server=createServer(async(req,res)=>{
  try{
   const url=new URL(req.url,'http://localhost');
   const resolved=path.resolve(root,'.'+url.pathname);
   if(!resolved.startsWith(root+path.sep)){res.writeHead(403).end();return}
   const data=await fs.readFile(resolved);
   res.writeHead(200,{'Content-Type':resolved.endsWith('.mjs')?'text/javascript; charset=utf-8':
     resolved.endsWith('.html')?'text/html; charset=utf-8':'application/octet-stream'}).end(data);
  }catch{res.writeHead(404).end()}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin='http://127.0.0.1:'+server.address().port;
 let browser;
 try{
  browser=await chromium.launch({channel:'chrome',headless:true});
  const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  const external=[];
  page.on('request',r=>{if(!r.url().startsWith(origin+'/'))external.push(r.url())});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin+'/tools/r313/index.html');
  await page.locator('#input-csv').setInputFiles(fixture('private.csv',csv,'text/csv'));
  await page.locator('#input-source').setInputFiles(fixture('private.json',JSON.stringify(source),'application/json'));
  await page.locator('#input-registry').setInputFiles(fixture('approved.json',JSON.stringify(registry),'application/json'));
  assert.equal(await page.locator('#analyze').isEnabled(),true);
  await page.locator('#analyze').click();
  await page.waitForFunction(()=>document.getElementById('k-internal').textContent==='10/10',{timeout:10000});
  assert.equal(await page.locator('#rooms details').count(),10);
  assert.equal(await page.locator('#k-public').textContent(),'0');
  assert.equal(await page.locator('#k-bridges').textContent(),'0');
  assert.equal(await page.locator('#export-safe').isEnabled(),true);
  await page.locator('#rooms details').first().locator('summary').click();
  await page.locator('#rooms details').first().locator('input').first().fill('UNVERIFIED');
  assert.equal(await page.locator('#export-safe').isEnabled(),false);
  assert.equal(await page.locator('#export-csv').isEnabled(),false);
  assert.deepEqual(external,[]);
  assert.deepEqual(errors,[]);
  await page.close();
 }finally{if(browser)await browser.close();await new Promise(r=>server.close(r))}
});
