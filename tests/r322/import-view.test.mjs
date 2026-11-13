import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { importReceipt } from '../../probes/r322/observation-ledger.mjs';
import { renderLedger } from '../../probes/r322/render-ledger.mjs';

const receipt={schemaVersion:319,evidenceKind:'synthetic',at:'2026-11-13T12:30:00Z',checked:[
  {key:'DEMO-01',at:'2026-11-13T12:00:00Z',state:'LIVE',reason:'TEST_VERIFIED_LIVE',profileIdentityVerified:true,roomIdentityVerified:true},
  {key:'DEMO-01',at:'2026-11-13T12:15:00Z',state:'UNKNOWN',reason:'TEST_MISSING'},
  {key:'DEMO-01',at:'2026-11-13T12:30:00Z',state:'LIVE',reason:'TEST_VERIFIED_LIVE',profileIdentityVerified:true,roomIdentityVerified:true}
]};
function setup(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'r322-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
function run(dir,kind='synthetic') {return spawnSync(process.execPath,['probes/r322/import-receipt.mjs','--receipt',path.join(dir,'receipt.json'),'--state',path.join(dir,'state.json'),'--html',path.join(dir,'view.html'),'--evidence-kind',kind],{encoding:'utf8'});}
test('CLI writes reloadable ledger and portable view, repeated import is idempotent',t=>{
  const dir=setup(t);fs.writeFileSync(path.join(dir,'receipt.json'),JSON.stringify(receipt));
  const first=run(dir);assert.equal(first.status,0,first.stderr);
  const state=fs.readFileSync(path.join(dir,'state.json'),'utf8');assert.equal(JSON.parse(state).observations.length,3);
  const second=run(dir);assert.equal(second.status,0,second.stderr);assert.equal(fs.readFileSync(path.join(dir,'state.json'),'utf8'),state);
  const html=fs.readFileSync(path.join(dir,'view.html'),'utf8');
  assert.match(html,/合成测试数据/);assert.match(html,/首次看到直播/);assert.match(html,/不等于精确/);assert.match(html,/不代表真实直播/);
  assert.doesNotMatch(html,/<script|src=|href=|https?:\/\//i);
});
test('invalid input and mixed provenance fail without changing saved ledger or view',t=>{
  const dir=setup(t),input=path.join(dir,'receipt.json');fs.writeFileSync(input,JSON.stringify(receipt));assert.equal(run(dir).status,0);
  const before=fs.readFileSync(path.join(dir,'state.json'),'utf8'),html=fs.readFileSync(path.join(dir,'view.html'),'utf8');
  assert.notEqual(run(dir,'real').status,0);fs.writeFileSync(input,'{"broken":');assert.notEqual(run(dir).status,0);
  assert.equal(fs.readFileSync(path.join(dir,'state.json'),'utf8'),before);assert.equal(fs.readFileSync(path.join(dir,'view.html'),'utf8'),html);
  assert.equal(fs.existsSync(path.join(dir,'state.json.lock')),false);
});
test('concurrent writer is refused without removing another writer lock',t=>{
  const dir=setup(t);fs.writeFileSync(path.join(dir,'receipt.json'),JSON.stringify(receipt));
  fs.writeFileSync(path.join(dir,'state.json.lock'),'OTHER');assert.notEqual(run(dir).status,0);
  assert.equal(fs.readFileSync(path.join(dir,'state.json.lock'),'utf8'),'OTHER');assert.equal(fs.existsSync(path.join(dir,'state.json')),false);
});
test('UNKNOWN-only historical receipt shows no fabricated session or KPI',()=>{
  const r={...receipt,evidenceKind:'real',checked:[{key:'ROOM-01',at:receipt.at,state:'UNKNOWN',reason:'STOPPED_HTTP_403_RESOURCE'}]};
  const html=renderLedger(importReceipt(null,r));
  assert.match(html,/尚无通过身份验证的直播观察/);assert.match(html,/不代表当前实时状态/);assert.match(html,/正式满播率<\/span><strong>—/);
});
test('invalid HTML destination is rejected before committing a ledger',t=>{
  const dir=setup(t);fs.writeFileSync(path.join(dir,'receipt.json'),JSON.stringify(receipt));
  fs.mkdirSync(path.join(dir,'view.html'));
  const result=run(dir);assert.notEqual(result.status,0);assert.match(result.stderr,/OUTPUT_MUST_BE_REGULAR_FILE/);
  assert.equal(fs.existsSync(path.join(dir,'state.json')),false);
});
test('symlink parent aliases cannot overwrite ledger with HTML',t=>{
  const dir=setup(t);fs.mkdirSync(path.join(dir,'actual'));fs.symlinkSync(path.join(dir,'actual'),path.join(dir,'alias'),'dir');
  fs.writeFileSync(path.join(dir,'receipt.json'),JSON.stringify(receipt));
  const r=spawnSync(process.execPath,['probes/r322/import-receipt.mjs','--receipt',path.join(dir,'receipt.json'),'--state',path.join(dir,'actual/data.json'),'--html',path.join(dir,'alias/data.json'),'--evidence-kind','synthetic'],{encoding:'utf8'});
  assert.notEqual(r.status,0);assert.match(r.stderr,/PATH_ALIASES_MUST_DIFFER/);assert.equal(fs.existsSync(path.join(dir,'actual/data.json')),false);
});
test('view may not collide with the state lock file',t=>{
  const dir=setup(t);fs.writeFileSync(path.join(dir,'receipt.json'),JSON.stringify(receipt));
  const r=spawnSync(process.execPath,['probes/r322/import-receipt.mjs','--receipt',path.join(dir,'receipt.json'),'--state',path.join(dir,'state.json'),'--html',path.join(dir,'state.json.lock'),'--evidence-kind','synthetic'],{encoding:'utf8'});
  assert.notEqual(r.status,0);assert.match(r.stderr,/PATH_ALIASES_MUST_DIFFER/);assert.equal(fs.existsSync(path.join(dir,'state.json')),false);
});
