import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html=fs.readFileSync(new URL('../preview/jd/index.html',import.meta.url),'utf8');
test('self-contained mobile-first preview has a real viewport and no remote scripts',()=>{
 assert.match(html,/<meta name="viewport" content="width=device-width, initial-scale=1">/);
 assert.match(html,/@media\(max-width:690px\)/);
 assert.doesNotMatch(html,/<script[^>]+src=/i);
 assert.doesNotMatch(html,/<iframe/i);
});
test('client code is valid JavaScript syntax',()=>{
 const m=html.match(/<script>([\s\S]*?)<\/script>/);
 assert.ok(m,'missing app script');
 assert.doesNotThrow(()=>new vm.Script(m[1],{filename:'jd-preview.js'}));
});
test('historical snapshot is dated and must expire after 15 minutes',()=>{
 assert.match(html,/2026-11-10T12:23:50\.475Z/);
 assert.match(html,/age<=900000/);
 assert.match(html,/历史快照，已过实时有效期/);
});
test('view does not publish fabricated formal opening percentage',()=>{
 assert.match(html,/formal_opening_rate_percent:null/);
 assert.match(html,/el\("rate"\)\.textContent="—"/);
 assert.match(html,/账号映射/);
});
test('all 7 observed internal room IDs are present, new 19 is not dropped',()=>{
 for(const id of ['1','14','15','16','17','18','19']){
  assert.ok(html.includes('"'+id+'"'));
 }
});
test('browser data import only parses local user file, not network',()=>{
 assert.match(html,/await f\.text\(\)/);
 assert.doesNotMatch(html,/\bfetch\s*\(/);
 assert.doesNotMatch(html.match(/<script>([\s\S]*?)<\/script>/)?.[1]||'',/localStorage|indexedDB|(?:document\.)?cookie/i);
});
test('safe text rendering avoids injecting untrusted imported report strings as HTML',()=>{
 assert.match(html,/e\.textContent=String\(text\)/);
 assert.doesNotMatch(html,/innerHTML\s*=/);
});
test('CSV contains effective current_state and excludes current LIVE when historical',()=>{
 assert.match(html,/\(!importedUnverified&&fresh\(data\)\)\?r\.state:"UNKNOWN"/);
 assert.match(html,/NOT_VERIFIED/);
});
const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
test('CSV cells neutralise formulas hidden behind whitespace, control characters or full-width signs',()=>{
 const m=script.match(/const cell=v=>\{[^\n]*\};/);
 assert.ok(m,'cell() not found');
 const cell=vm.runInNewContext(m[0]+'cell');
 for(const bad of ['=1+1',' =1+1','\t=cmd|x','\r\n=HYPERLINK("http://e","x")','  @SUM(1)','-2+3','+1','＝1+1','\u0000=1']){
  const out=cell(bad);
  assert.match(out,/^"\s*'/,JSON.stringify(bad)+' -> '+out);
  assert.doesNotMatch(out,/[\u0000-\u001f]/);
 }
 assert.equal(cell('空调'),'"空调"');assert.equal(cell('2026-11-10T12:23:50.475Z'),'"2026-11-10T12:23:50.475Z"');
 assert.equal(cell('a"b'),'"a""b"');assert.equal(cell(null),'""');
});
test('freshness is re-evaluated while the page stays open',()=>{
 assert.match(script,/setInterval\(render,30000\)/);
 assert.match(script,/visibilitychange/);
});
test('BLOCKED reports never render or export room rows',()=>{
 assert.match(script,/safe=!isBlocked&&Array\.isArray\(data\.rooms\)\?data\.rooms:\[\]/);
 assert.match(script,/data\.readiness==="BLOCKED"\?\[\]:\(data\.rooms\|\|\[\]\)/);
});
