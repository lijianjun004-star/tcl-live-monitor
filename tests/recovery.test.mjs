import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {restorePolicy} from '../scripts/douyin-restore-policy.mjs';
import {importReceipt} from '../probes/r322/observation-ledger.mjs';
const now=Date.parse('2026-11-17T08:05:00Z');
const base={run:{databaseId:44042982575,run_attempt:1,status:'completed',conclusion:'success'},downloaded:true,ledgerValid:true,cooldownAbsenceReviewed:true,now};

const repo='lijianjun004-star/tcl-live-monitor';
function dyRun(conclusion='success'){return {id:123,run_attempt:1,status:'completed',conclusion,head_branch:'main',event:'schedule',path:'.github/workflows/douyin-daily-broadcast.yml',repository:{full_name:repo},head_repository:{full_name:repo}};}
function dyLedger(at=new Date().toISOString()){
 return importReceipt(null,{schemaVersion:319,at,checked:[{key:'synthetic-only',at,state:'UNKNOWN',reason:'SYNTHETIC_ONLY'}]},{evidenceKind:'real',platform:'douyin'});
}
function dyFixture(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dy-shell-'));
 for(const sub of ['bin','scripts','probes/r322','fixture','config'])fs.mkdirSync(path.join(dir,sub),{recursive:true});
 for(const file of ['scripts/douyin-ledger-recovery.mjs','scripts/douyin-restore-policy.mjs','scripts/recovery-file-store.mjs','probes/r322/observation-ledger.mjs'])fs.copyFileSync(file,path.join(dir,file));
 fs.writeFileSync(path.join(dir,'fixture/run.json'),JSON.stringify(dyRun()));
 fs.writeFileSync(path.join(dir,'fixture/state.json'),JSON.stringify(dyLedger()));
 fs.writeFileSync(path.join(dir,'fixture/cooldown.json'),JSON.stringify({stoppedAt:new Date(Date.now()-2*86400000).toISOString()}));
 fs.writeFileSync(path.join(dir,'bin/gh'),`#!/bin/bash
set -e
case "$1 $2" in
 'run list') if [ "$FAIL_STAGE" = list ]; then echo '[]'; else node -e "const r=require('./fixture/run.json'); console.log(JSON.stringify([{databaseId:r.id,status:r.status,conclusion:r.conclusion}]))"; fi;;
 'api '*) cat fixture/run.json;;
 'run download') [ "$FAIL_STAGE" != download ]; for f in state.json cooldown.json recovery-block.json recovery-reviewed.json; do if [ -f "fixture/$f" ]; then cp "fixture/$f" prev/; fi; done;;
 *) exit 2;;
esac
`,{mode:0o755});
 const env={...process.env,PATH:path.join(dir,'bin')+path.delimiter+process.env.PATH,GITHUB_REPOSITORY:repo,GITHUB_RUN_ID:'200',GITHUB_RUN_ATTEMPT:'1',GITHUB_OUTPUT:path.join(dir,'outputs'),FAIL_STAGE:''};
 return {dir,env,run:()=>spawnSync('bash',[path.resolve('scripts/restore-douyin-ledger.sh')],{cwd:dir,env,encoding:'utf8'})};
}

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
 const f=dyFixture();try{
  for(const conclusion of ['failure','success']){
   fs.writeFileSync(path.join(f.dir,'fixture/run.json'),JSON.stringify(dyRun(conclusion)));
   fs.writeFileSync(f.env.GITHUB_OUTPUT,'');const r=f.run();assert.equal(r.status,0,r.stderr);
   assert.doesNotMatch(fs.readFileSync(f.env.GITHUB_OUTPUT,'utf8'),/skip=false/);
   assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir,'out/ledger/state.json'))).observations[0].key,'synthetic-only');
   fs.copyFileSync(path.join(f.dir,'out/ledger/recovery-block.json'),path.join(f.dir,'fixture/recovery-block.json'));
   fs.rmSync(path.join(f.dir,'prev'),{recursive:true});fs.rmSync(path.join(f.dir,'out'),{recursive:true});
  }
 }finally{fs.rmSync(f.dir,{recursive:true,force:true});}
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
 const f=dyFixture();try{
  f.env.FAIL_STAGE='download';const r=f.run();assert.notEqual(r.status,0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir,'out/ledger/recovery-block.json'))).reason,'RESTORE_UNVERIFIED');
  assert.doesNotMatch(fs.readFileSync(f.env.GITHUB_OUTPUT,'utf8'),/skip=false/);
 }finally{fs.rmSync(f.dir,{recursive:true,force:true});}
});


test('actual ledger validator gates malformed state/cooldown, future time and missing history',()=>{
 for(const mode of ['valid','bad-ledger','bad-cooldown','future-cooldown','no-run','synthetic','foreign']){
  const f=dyFixture();try{
   if(mode==='bad-ledger')fs.writeFileSync(path.join(f.dir,'fixture/state.json'),'{}');
   if(mode==='synthetic'){const s=dyLedger();s.evidenceKind='synthetic';fs.writeFileSync(path.join(f.dir,'fixture/state.json'),JSON.stringify(s));}
   if(mode==='bad-cooldown')fs.writeFileSync(path.join(f.dir,'fixture/cooldown.json'),'INVALID');
   if(mode==='future-cooldown')fs.writeFileSync(path.join(f.dir,'fixture/cooldown.json'),JSON.stringify({stoppedAt:'2999-01-01T00:00:00.000Z'}));
   if(mode==='no-run')f.env.FAIL_STAGE='list';
   if(mode==='foreign')fs.writeFileSync(path.join(f.dir,'fixture/run.json'),JSON.stringify({...dyRun(),head_repository:{full_name:'foreign/repo'}}));
   const r=f.run(),output=fs.readFileSync(f.env.GITHUB_OUTPUT,'utf8');
   if(mode==='valid'){assert.equal(r.status,0,r.stderr);assert.match(output,/skip=false/);}
   else {assert.doesNotMatch(output,/skip=false/);assert.equal(fs.existsSync(path.join(f.dir,'out/ledger/recovery-block.json')),true);}
  }finally{fs.rmSync(f.dir,{recursive:true,force:true});}
 }
});


test('review receipt is exact, expires, and cannot bypass any cooldown',async()=>{
 const {reviewedRecovery}=await import('../scripts/douyin-restore-policy.mjs');
 const bindings={run:base.run,stateSha256:'a'.repeat(64),cooldownSha256:'b'.repeat(64),blockSha256:'c'.repeat(64),now};
 const receipt={schemaVersion:1,reason:'ENCRYPTION_FAILURE_ONLY',runId:String(base.run.databaseId),runAttempt:1,stateSha256:bindings.stateSha256,cooldownSha256:bindings.cooldownSha256,blockSha256:bindings.blockSha256,approvedBy:'owner',approvalUrl:'https://github.com/lijianjun004-star/tcl-live-monitor/issues/123#issuecomment-456',approvedAt:new Date(now-1000).toISOString(),expiresAt:new Date(now+60000).toISOString()};
 assert.equal(reviewedRecovery(receipt,bindings),true);
 for(const changes of [{runId:'1'},{runAttempt:2},{stateSha256:'d'.repeat(64)},{cooldownSha256:null},{blockSha256:null},{reason:'ACCESS_LIMIT'},{approvalUrl:'https://example.invalid'},{expiresAt:iso(now)},{approvedAt:iso(now+1)}])assert.equal(reviewedRecovery({...receipt,...changes},bindings),false);
 for(const stoppedAt of ['bad',iso(now+1),iso(now-1000)])assert.equal(restorePolicy({...base,cooldown:{stoppedAt},recoveryBlocked:false}).skip,true);
 assert.equal(reviewedRecovery(null,bindings),false);
 function iso(t){return new Date(t).toISOString();}
});

test('unexplained missing cooldown and invalid clock never authorize recovery',()=>{
 assert.equal(restorePolicy({...base,cooldownAbsenceReviewed:false}).reason,'COOLDOWN_ABSENCE_REVIEW_REQUIRED');
 assert.equal(restorePolicy({...base,now:NaN}).skip,true);
 assert.equal(restorePolicy({...base,cooldown:{stoppedAt:'2026-02-30T00:00:00.000Z'}}).skip,true);
});
test('successful download without cooldown persists a block through a later success',()=>{
 const f=dyFixture();try{
  fs.rmSync(path.join(f.dir,'fixture/cooldown.json'));
  for(let i=0;i<2;i++){
   fs.writeFileSync(f.env.GITHUB_OUTPUT,'');const r=f.run();assert.equal(r.status,0,r.stderr);
   assert.doesNotMatch(fs.readFileSync(f.env.GITHUB_OUTPUT,'utf8'),/skip=false/);
   fs.copyFileSync(path.join(f.dir,'out/ledger/recovery-block.json'),path.join(f.dir,'fixture/recovery-block.json'));
   fs.rmSync(path.join(f.dir,'prev'),{recursive:true});fs.rmSync(path.join(f.dir,'out'),{recursive:true});
  }
 }finally{fs.rmSync(f.dir,{recursive:true,force:true});}
});

test('Douyin sample persists stop before failing importer and does not attempt another target',()=>{
 for(const missing of [false,true]){
  const f=dyFixture();try{
   fs.mkdirSync(path.join(f.dir,'probes/r316'),{recursive:true});
   fs.writeFileSync(path.join(f.dir,'probes/r316/douyin-rpa-two-once.mjs'),`import fs from 'node:fs';fs.appendFileSync('calls','one\n');${missing?'':`fs.mkdirSync('out',{recursive:true});fs.writeFileSync('out/r316-rpa-public.json',JSON.stringify({schemaVersion:319,at:new Date().toISOString(),checked:[],stopped:{reason:'HTTP_403'}}));`}process.exit(3);`.replace("'one\n'","'one\\n'"));
   fs.writeFileSync(path.join(f.dir,'probes/r322/import-receipt.mjs'),"import fs from 'node:fs';if(!fs.existsSync('out/ledger/cooldown.json'))process.exit(99);fs.writeFileSync('import-saw-stop','true');process.exit(1);");
   const r=spawnSync('bash',[path.resolve('scripts/douyin-sample-once.sh')],{cwd:f.dir,env:f.env,encoding:'utf8'});
   assert.equal(r.status,1,r.stderr);assert.equal(fs.readFileSync(path.join(f.dir,'calls'),'utf8'),'one\n');
   assert.ok(fs.existsSync(path.join(f.dir,'out/ledger/cooldown.json')));assert.ok(fs.existsSync(path.join(f.dir,'out/ledger/recovery-block.json')));
   assert.equal(fs.existsSync(path.join(f.dir,'import-saw-stop')),!missing);
  }finally{fs.rmSync(f.dir,{recursive:true,force:true});}
 }
});

test('Douyin healthy sample runs only its four existing target sets and clears its own sentinel',()=>{
 const f=dyFixture();try{
  fs.mkdirSync(path.join(f.dir,'probes/r316'),{recursive:true});
  fs.writeFileSync(path.join(f.dir,'probes/r316/douyin-rpa-two-once.mjs'),`import fs from 'node:fs';fs.appendFileSync('calls',JSON.stringify(process.env.R326_TARGET_SET)+'\\n');const at=new Date().toISOString();fs.mkdirSync('out',{recursive:true});fs.writeFileSync('out/r316-rpa-public.json',JSON.stringify({schemaVersion:319,at,checked:[{key:'synthetic-only',at,state:'UNKNOWN',reason:'SYNTHETIC_ONLY'}],stopped:null}));`);
  fs.writeFileSync(path.join(f.dir,'probes/r322/import-receipt.mjs'),`import fs from 'node:fs';import {importReceipt} from './observation-ledger.mjs';const r=JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf('--receipt')+1]));fs.writeFileSync('out/ledger/state.json',JSON.stringify(importReceipt(null,r,{platform:'douyin',evidenceKind:'real'})));`);
  fs.writeFileSync(path.join(f.dir,'bin/sleep'),'#!/bin/bash\nexit 0\n',{mode:0o755});
  const r=spawnSync('bash',[path.resolve('scripts/douyin-sample-once.sh')],{cwd:f.dir,env:f.env,encoding:'utf8'});assert.equal(r.status,0,r.stderr);
  assert.deepEqual(fs.readFileSync(path.join(f.dir,'calls'),'utf8').trim().split('\n').map(JSON.parse),['','SCORING_B','MONITOR_C','MONITOR_D']);
  assert.equal(fs.existsSync(path.join(f.dir,'out/ledger/recovery-block.json')),false);
 }finally{fs.rmSync(f.dir,{recursive:true,force:true});}
});

test('encryption refuses a competing or crashed writer without deleting evidence or published bundle',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'encrypt-lock-'));try{
  for(const name of ['out/.encrypt-lock','out/enc','out/private-a'])fs.mkdirSync(path.join(dir,name),{recursive:true});
  fs.writeFileSync(path.join(dir,'out/enc/p.enc'),'EXISTING_SYNTHETIC_BUNDLE');
  fs.writeFileSync(path.join(dir,'out/private-a/fixture'),'SYNTHETIC_PENDING');
  const r=spawnSync('bash',[path.resolve('scripts/encrypt-douyin-evidence.sh')],{cwd:dir,encoding:'utf8'});
  assert.equal(r.status,1);assert.equal(r.stdout,'::error::PRIVATE_EVIDENCE_ENCRYPTION_FAILED\n');
  assert.equal(fs.readFileSync(path.join(dir,'out/enc/p.enc'),'utf8'),'EXISTING_SYNTHETIC_BUNDLE');
  assert.equal(fs.readFileSync(path.join(dir,'out/private-a/fixture'),'utf8'),'SYNTHETIC_PENDING');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
