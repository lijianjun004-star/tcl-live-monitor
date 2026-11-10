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
 assert.match(html,/2026-11-10T12:23:55\.000Z/);
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
 assert.doesNotMatch(html,/localStorage|indexedDB|cookie/i);
});
test('safe text rendering avoids injecting untrusted imported report strings as HTML',()=>{
 assert.match(html,/e\.textContent=String\(text\)/);
 assert.doesNotMatch(html,/innerHTML\s*=/);
});
test('CSV contains effective current_state and excludes current LIVE when historical',()=>{
 assert.match(html,/fresh\(data\)\?r\.state:"UNKNOWN"/);
 assert.match(html,/NOT_VERIFIED/);
});
