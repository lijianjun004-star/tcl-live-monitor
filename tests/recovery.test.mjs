import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {restorePolicy} from '../scripts/douyin-restore-policy.mjs';
const now=Date.parse('2026-11-17T08:05:00Z');
const base={run:{databaseId:44042982575,status:'completed',conclusion:'success'},downloaded:true,ledgerValid:true,now};
test('failed encryption run selected as latest completed, not discarded for older success',()=>{
 const runs=[{...base.run,conclusion:'failure'},{...base.run,databaseId:44020227960}];
 assert.equal(runs.find(r=>r.conclusion==='success').databaseId,44020227960);
 const d=restorePolicy({...base,run:runs[0]});assert.equal(d.skip,true);assert.match(d.reason,/REVIEW/);
});
test('failure followed by successful skipped run cannot erase recovery block',()=>{
 assert.equal(restorePolicy({...base,recoveryBlocked:true}).skip,true);
 assert.equal(restorePolicy(base).skip,false);
});
test('lost restore, malformed future cooldown and exact 24h boundary',()=>{
 assert.equal(restorePolicy({...base,downloaded:false}).skip,true);
 assert.equal(restorePolicy({...base,ledgerValid:false}).skip,true);
 for(const stoppedAt of ['bad',new Date(now+1).toISOString(),new Date(now-24*3600e3+1).toISOString()])assert.equal(restorePolicy({...base,cooldown:{stoppedAt}}).skip,true);
 assert.equal(restorePolicy({...base,cooldown:{stoppedAt:new Date(now-24*3600e3).toISOString()}}).skip,false);
});
test('synthetic binary pass reproduces BIO error; hex pass encrypts/decrypts',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dy-bio-test-'));try{
 fs.writeFileSync(path.join(dir,'plain'),'SYNTHETIC ONLY');
 fs.writeFileSync(path.join(dir,'key'),Buffer.concat([Buffer.from([0]),Buffer.alloc(31,65)]));
 const args=['enc','-aes-256-cbc','-pbkdf2','-salt','-in',path.join(dir,'plain'),'-out',path.join(dir,'cipher'),'-pass','file:'+path.join(dir,'key')];
 let r=spawnSync('openssl',args,{encoding:'utf8'});assert.notEqual(r.status,0);assert.match(r.stderr,/Error reading password from BIO/);
 fs.writeFileSync(path.join(dir,'key'),'ab'.repeat(32)+'\n');r=spawnSync('openssl',args,{encoding:'utf8'});assert.equal(r.status,0);
 r=spawnSync('openssl',['enc','-d','-aes-256-cbc','-pbkdf2','-in',path.join(dir,'cipher'),'-pass','file:'+path.join(dir,'key')],{encoding:'utf8'});assert.equal(r.status,0);assert.equal(r.stdout,'SYNTHETIC ONLY');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('workflow source requires affirmative restore permission and encrypted pair',()=>{
 const wf=fs.readFileSync('.github/workflows/douyin-daily-broadcast.yml','utf8');
 assert.equal((wf.match(/steps.gate.outcome == 'success' && steps.gate.outputs.skip == 'false'/g)||[]).length,2);
 assert.match(wf,/out\/ledger\/recovery-block.json/);assert.match(wf,/hashFiles\('out\/enc\/k.enc'\)/);
 const restore=fs.readFileSync('scripts/restore-douyin-ledger.sh','utf8');assert.match(restore,/--status completed/);assert.doesNotMatch(restore,/--status success|\|\| true/);
});
test('restore shell carries failed-run ledger and persistent block through next successful skip',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dy-restore-test-'));try{
 for(const sub of ['bin','scripts','probes/r325','fixture'])fs.mkdirSync(path.join(dir,sub),{recursive:true});
 fs.copyFileSync('scripts/douyin-restore-policy.mjs',path.join(dir,'scripts/douyin-restore-policy.mjs'));
 fs.writeFileSync(path.join(dir,'probes/r325/daily-report.mjs'),'JSON.parse((await import("node:fs")).readFileSync(process.argv[2]));');
 fs.writeFileSync(path.join(dir,'fixture/state.json'),JSON.stringify({synthetic:'newer-failed-run-evidence'}));
 fs.writeFileSync(path.join(dir,'fixture/cooldown.json'),JSON.stringify({stoppedAt:new Date().toISOString()}));
 fs.writeFileSync(path.join(dir,'bin/gh'),'#!/bin/bash\nif [[ "$2" == list ]]; then cat "$FIXTURE/run.json"; else cp "$FIXTURE/state.json" prev/; cp "$FIXTURE/cooldown.json" prev/; if [ -f "$FIXTURE/recovery-block.json" ]; then cp "$FIXTURE/recovery-block.json" prev/; fi; fi\n',{mode:0o755});
 const output=path.join(dir,'outputs');const env={...process.env,PATH:path.join(dir,'bin')+':'+process.env.PATH,FIXTURE:path.join(dir,'fixture'),GITHUB_OUTPUT:output};
 const script=path.resolve('scripts/restore-douyin-ledger.sh');
 for(const conclusion of ['failure','success']){
 fs.writeFileSync(path.join(dir,'fixture/run.json'),JSON.stringify([{databaseId:123,status:'completed',conclusion}]));
 fs.writeFileSync(output,'');const r=spawnSync('bash',[script],{cwd:dir,env,encoding:'utf8'});assert.equal(r.status,0,r.stderr);
 assert.match(fs.readFileSync(output,'utf8'),/skip=true/);assert.doesNotMatch(fs.readFileSync(output,'utf8'),/skip=false/);
 assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'out/ledger/state.json'))).synthetic,'newer-failed-run-evidence');
 fs.copyFileSync(path.join(dir,'out/ledger/recovery-block.json'),path.join(dir,'fixture/recovery-block.json'));
 fs.rmSync(path.join(dir,'prev'),{recursive:true,force:true});fs.rmSync(path.join(dir,'out'),{recursive:true,force:true});
 }
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('binary newline truncates text password; encryption does not use trailing random bytes',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dy-line-'));
 try {
  fs.writeFileSync(path.join(dir,'plain'),'SYNTHETIC');
  fs.writeFileSync(path.join(dir,'key'),Buffer.concat([Buffer.from('abc\n'),Buffer.alloc(28,255)]));
  const enc=spawnSync('openssl',['enc','-aes-256-cbc','-pbkdf2','-salt','-in',dir+'/plain','-out',dir+'/cipher','-pass','file:'+dir+'/key']);assert.equal(enc.status,0);
  const dec=spawnSync('openssl',['enc','-d','-aes-256-cbc','-pbkdf2','-in',dir+'/cipher','-pass','pass:abc'],{encoding:'utf8'});
  assert.equal(dec.status,0);assert.equal(dec.stdout,'SYNTHETIC');
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('actual encryption script: RSA unwrap, authenticated CBC roundtrip, tampering and failure cleanup',async()=>{
 const {authenticateEvidence}=await import('../scripts/evidence-integrity.mjs');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dy-envelope-'));
 try {
  for(const sub of ['scripts','probes/keys','out/private-a','temp'])fs.mkdirSync(path.join(dir,sub),{recursive:true});
  fs.copyFileSync('scripts/evidence-integrity.mjs',dir+'/scripts/evidence-integrity.mjs');
  const openssl=args=>{const r=spawnSync('openssl',args,{cwd:dir,encoding:'utf8'});assert.equal(r.status,0,'synthetic crypto command failed');return r;};
  openssl(['genpkey','-algorithm','RSA','-pkeyopt','rsa_keygen_bits:2048','-out','test-private.pem']);
  openssl(['pkey','-in','test-private.pem','-pubout','-out','probes/keys/analysis-pub.pem']);
  const script=path.resolve('scripts/encrypt-douyin-evidence.sh');
  const run=()=>spawnSync('bash',[script],{cwd:dir,encoding:'utf8',env:{...process.env,TMPDIR:dir+'/temp'}});
  fs.writeFileSync(dir+'/out/private-a/fixture.txt','SYNTHETIC_EVIDENCE_ONLY');
  let r=run();assert.equal(r.status,0,r.stderr);assert.equal(r.stdout+r.stderr,'');
  assert.deepEqual(fs.readdirSync(dir+'/out'),['enc']);
  assert.deepEqual(fs.readdirSync(dir+'/out/enc').sort(),['integrity.txt','k.enc','p.enc']);
  openssl(['pkeyutl','-decrypt','-inkey','test-private.pem','-pkeyopt','rsa_padding_mode:oaep','-in','out/enc/k.enc','-out','unwrapped']);
  assert.match(fs.readFileSync(dir+'/unwrapped','utf8'),/^[0-9a-f]{64}\n$/);
  authenticateEvidence('verify',dir+'/unwrapped',dir+'/out/enc');
  openssl(['enc','-d','-aes-256-cbc','-pbkdf2','-in','out/enc/p.enc','-out','plain.tgz','-pass','file:unwrapped']);
  const tar=spawnSync('tar',['xOzf','plain.tgz','private-a/fixture.txt'],{cwd:dir,encoding:'utf8'});
  assert.equal(tar.status,0);assert.equal(tar.stdout,'SYNTHETIC_EVIDENCE_ONLY');
  for(const name of ['p.enc','k.enc','integrity.txt']) {
   const f=dir+'/out/enc/'+name,original=fs.readFileSync(f),changed=Buffer.from(original);changed[0]^=1;fs.writeFileSync(f,changed);
   assert.throws(()=>authenticateEvidence('verify',dir+'/unwrapped',dir+'/out/enc'));fs.writeFileSync(f,original);
  }
  fs.writeFileSync(dir+'/wrong-key','cd'.repeat(32)+'\n');
  assert.throws(()=>authenticateEvidence('verify',dir+'/wrong-key',dir+'/out/enc'));
  fs.mkdirSync(dir+'/out/private-a');fs.writeFileSync(dir+'/out/private-a/test','SYNTHETIC');
  fs.writeFileSync(dir+'/probes/keys/analysis-pub.pem','INVALID_SYNTHETIC_KEY');
  r=run();assert.notEqual(r.status,0);assert.equal(r.stdout,'::error::PRIVATE_EVIDENCE_ENCRYPTION_FAILED\n');assert.equal(r.stderr,'');
  assert.deepEqual(fs.readdirSync(dir+'/out'),[]);assert.deepEqual(fs.readdirSync(dir+'/temp'),[]);
  // No-input run cannot leave an old publishable bundle.
  fs.mkdirSync(dir+'/out/enc');fs.writeFileSync(dir+'/out/enc/p.enc','STALE');
  r=run();assert.equal(r.status,0);assert.deepEqual(fs.readdirSync(dir+'/out'),[]);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('restore download failure leaves durable block and never falls back',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dy-restore-fail-'));
 try {
  fs.mkdirSync(dir+'/bin');fs.writeFileSync(dir+'/bin/gh','#!/bin/bash\nif [[ "$2" == list ]]; then echo \'[{"databaseId":123,"status":"completed","conclusion":"failure"}]\'; else exit 1; fi\n',{mode:0o755});
  const r=spawnSync('bash',[path.resolve('scripts/restore-douyin-ledger.sh')],{cwd:dir,encoding:'utf8',env:{...process.env,PATH:dir+'/bin:'+process.env.PATH,GITHUB_OUTPUT:dir+'/outputs'}});
  assert.notEqual(r.status,0);assert.equal(JSON.parse(fs.readFileSync(dir+'/out/ledger/recovery-block.json')).reason,'RESTORE_UNVERIFIED');
  assert.doesNotMatch(fs.readFileSync(dir+'/outputs','utf8'),/skip=false/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('actual ledger validator gates malformed state/cooldown, future time and missing history',async()=>{
 const {importReceipt}=await import('../probes/r322/observation-ledger.mjs');
 const ledger=importReceipt(null,{schemaVersion:319,evidenceKind:'synthetic',at:'2026-11-17T00:00:00.000Z',checked:[]},{evidenceKind:'synthetic'});
 for(const mode of ['valid','bad-ledger','bad-cooldown','future-cooldown','no-run']){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dy-real-validator-'));
  try {
   for(const sub of ['bin','scripts','probes/r325','probes/r322','fixture'])fs.mkdirSync(dir+'/'+sub,{recursive:true});
   for(const file of ['scripts/douyin-restore-policy.mjs','probes/r325/daily-report.mjs','probes/r322/observation-ledger.mjs'])fs.copyFileSync(file,dir+'/'+file);
   fs.writeFileSync(dir+'/fixture/state.json',JSON.stringify(mode==='bad-ledger'?{}:ledger));
   if(mode==='bad-cooldown')fs.writeFileSync(dir+'/fixture/cooldown.json','INVALID');
   if(mode==='future-cooldown')fs.writeFileSync(dir+'/fixture/cooldown.json',JSON.stringify({stoppedAt:'2999-01-01T00:00:00Z'}));
   fs.writeFileSync(dir+'/fixture/runs.json',JSON.stringify(mode==='no-run'?[]:[{databaseId:123,status:'completed',conclusion:'success'}]));
   fs.writeFileSync(dir+'/bin/gh','#!/bin/bash\nif [[ "$2" == list ]]; then cat fixture/runs.json; else cp fixture/state.json prev/; if [ -f fixture/cooldown.json ]; then cp fixture/cooldown.json prev/; fi; fi\n',{mode:0o755});
   const r=spawnSync('bash',[path.resolve('scripts/restore-douyin-ledger.sh')],{cwd:dir,env:{...process.env,PATH:dir+'/bin:'+process.env.PATH,GITHUB_OUTPUT:dir+'/outputs'},encoding:'utf8'});
   const output=fs.readFileSync(dir+'/outputs','utf8');
   if(mode==='valid'){assert.equal(r.status,0);assert.match(output,/skip=false/);}
   else {assert.doesNotMatch(output,/skip=false/);if(mode!=='future-cooldown'){assert.notEqual(r.status,0);assert.equal(fs.existsSync(dir+'/out/ledger/recovery-block.json'),true);}}
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
 }
});

test('review receipt is exact, expires, and cannot bypass any cooldown',async()=>{
 const {reviewedRecovery}=await import('../scripts/douyin-restore-policy.mjs');
 const bindings={run:base.run,stateSha256:'a'.repeat(64),cooldownSha256:'b'.repeat(64),blockSha256:'c'.repeat(64),now};
 const receipt={schemaVersion:1,reason:'ENCRYPTION_FAILURE_ONLY',runId:String(base.run.databaseId),stateSha256:bindings.stateSha256,cooldownSha256:bindings.cooldownSha256,blockSha256:bindings.blockSha256,approvedBy:'owner',approvalUrl:'https://github.com/lijianjun004-star/tcl-live-monitor/issues/123#issuecomment-456',approvedAt:new Date(now-1000).toISOString(),expiresAt:new Date(now+60000).toISOString()};
 assert.equal(reviewedRecovery(receipt,bindings),true);
 for(const changes of [{runId:'1'},{stateSha256:'d'.repeat(64)},{cooldownSha256:null},{blockSha256:null},{reason:'ACCESS_LIMIT'},{approvalUrl:'https://example.invalid'},{expiresAt:iso(now)},{approvedAt:iso(now+1)}])assert.equal(reviewedRecovery({...receipt,...changes},bindings),false);
 for(const stoppedAt of ['bad',iso(now+1),iso(now-1000)])assert.equal(restorePolicy({...base,cooldown:{stoppedAt},recoveryBlocked:false}).skip,true);
 assert.equal(reviewedRecovery(null,bindings),false);
 function iso(t){return new Date(t).toISOString();}
});
