// R3.17 adversarial offline regression: Gemini P1/P2, no external network or account access.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { executePlan, guardedFetch, runDouyinOnce } from '../../probes/r316/one-shot-runner.mjs';
import { reconcileDouyinFourLayers } from '../../probes/r36/douyin-evidence-gate.mjs';
import { parseStateKey, sealState, openState } from '../../probes/r316/state-cipher.mjs';

const cfg=JSON.parse(fs.readFileSync('config/probe-targets.json','utf8'));
const at=Date.parse('2026-11-12T14:10:00.000Z');
const plan={ decision:'ONE_SHOT', targets:[{platform:'douyin',status:'READY_FOR_SINGLE_SCAN'}] };
const rooms=n=>Array.from({length:n},(_,i)=>({id:601+i,platform:'douyin',shop_id:1601+i,category:'电视',bound_session_key:null}));
const response=(u,n=10)=>{
  const path=new URL(String(u)).pathname;
  const data=path==='/api/capture/rooms'?{ok:true,rooms:rooms(n)}
    :path==='/api/shops'?Array.from({length:n},(_,i)=>({id:1601+i,platform:'抖音'}))
    :path==='/api/assistant/active-rooms'?{ok:true,rooms:[]}:{ok:true,days:[]};
  return new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json'}});
};

test('Gemini P1-2: HTTP 302 latches immediately and never scans follow-up endpoints',async()=>{
  const log=[];
  const result=await executePlan({plan,runKey:'r317.redirect',origin:'http://ops.test',config:cfg,at,
    fetchFn:async u=>{log.push(new URL(String(u)).pathname);return new Response('go to login',{status:302,headers:{location:'/login'}})}});
  assert.equal(result.results[0].status,'BLOCKED');
  assert.equal(result.results[0].reason,'SOURCE_REDIRECT');
  assert.deepEqual(log,['/api/capture/rooms']);
});
test('Gemini P1-2: invalid JSON stops the rest of the source read',async()=>{
  const log=[];
  const result=await executePlan({plan,runKey:'r317.invalid',origin:'http://ops.test',config:cfg,at,
    fetchFn:async u=>{log.push(new URL(String(u)).pathname);return new Response('invalid-json',{headers:{'content-type':'application/json'}})}});
  assert.equal(result.results[0].status,'BLOCKED');
  assert.equal(result.results[0].reason,'SOURCE_READ_OR_SCHEMA_ERROR');
  assert.equal(log.length,1);
});
test('Gemini P1-2: non-JSON challenge response stops on first source request',async()=>{
  const log=[];
  const result=await executePlan({plan,runKey:'r317.challenge',origin:'http://ops.test',config:cfg,at,
    fetchFn:async u=>{log.push(String(u));return new Response('<h1>captcha</h1>',{headers:{'content-type':'text/html'}})}});
  assert.equal(result.results[0].status,'BLOCKED');
  assert.equal(result.results[0].reason,'SOURCE_NON_JSON_RESPONSE');
  assert.equal(log.length,1);
});
test('Gemini P1-2: deadline cancels future requests after timeout',async()=>{
  let requests=0;
  const result=await executePlan({plan,runKey:'r317.deadline',origin:'http://ops.test',config:cfg,at,deadlineMs:45,
    fetchFn:async u=>{requests++;await new Promise(r=>setTimeout(r,30));return response(u)}});
  assert.equal(result.results[0].status,'BLOCKED');
  assert.equal(result.results[0].reason,'RUN_DEADLINE_EXCEEDED');
  const count=requests;
  await new Promise(r=>setTimeout(r,200));
  assert.equal(requests,count,'no source requests are allowed after the deadline');
});
test('Gemini P1-1: cold-start shrink is BLOCKED and never silently records a new eight-room baseline',async()=>{
  const reader=async(path)=>path==='/api/capture/rooms'?{ok:true,rooms:rooms(8)}
    :path==='/api/shops'?Array.from({length:10},(_,i)=>({id:1601+i,platform:'抖音'}))
    :path==='/api/assistant/active-rooms'?{ok:true,rooms:[]}:{ok:true,days:[]};
  const r=await runDouyinOnce({reader,config:cfg,at});
  assert.equal(r.status,'BLOCKED_BASELINE_NOT_RESTORED');
  assert.equal(r.rows.length,8);
  assert.ok(r.warnings.includes('DONT_DROP_HISTORICAL_ROOMS_WITHOUT_ENCRYPTED_BASELINE'));
});
test('Gemini P1-1: encrypted prior state keeps 10 room identities when source shrinks to eight',async()=>{
  const reader=async(path)=>path==='/api/capture/rooms'?{ok:true,rooms:rooms(8)}
    :path==='/api/shops'?Array.from({length:10},(_,i)=>({id:1601+i,platform:'抖音'}))
    :path==='/api/assistant/active-rooms'?{ok:true,rooms:[]}:{ok:true,days:[]};
  const previous={inventory:{platform:'douyin',rooms:rooms(10).map(x=>({roomId:String(x.id),shopId:String(x.shop_id),platform:'douyin',lastSeenAt:'2026-11-11T00:00:00.000Z'}))}};
  const r=await runDouyinOnce({reader,config:cfg,at,previous});
  assert.equal(r.status,'READ_ONCE');
  assert.equal(r.rows.length,10);
  assert.equal(r.rows.filter(x=>x.seenInCurrentSource===false).length,2);
});
test('Gemini P1-1: state encryption roundtrip rejects wrong key and altered ciphertext',()=>{
  const key=parseStateKey('ab'.repeat(32));
  const prior={douyin:{inventory:{platform:'douyin',rooms:[{roomId:'601',platform:'douyin'}]}}};
  const box=sealState(prior,key);
  assert.deepEqual(openState(box,key),prior);
  assert.throws(()=>openState(box,parseStateKey('cd'.repeat(32))),/AUTHENTICATION/);
  assert.throws(()=>openState({...box,ciphertext:Buffer.from('tampered').toString('base64')},key),/AUTHENTICATION/);
  assert.throws(()=>parseStateKey('weak'),/64_HEX/);
});
test('Gemini P1-1: switch workflow restores authenticated state instead of passing dash',()=>{
  const yaml=fs.readFileSync('.github/workflows/r315-switchable-one-shot.yml','utf8');
  assert.match(yaml,/secrets\.R316_STATE_KEY/);
  assert.match(yaml,/state-cli\.mjs decrypt/);
  assert.match(yaml,/state-cli\.mjs encrypt/);
  assert.match(yaml,/r315-runtime-control/);
  assert.doesNotMatch(yaml,/one-shot-cli\.mjs r315-run-summary\.json - /);
});
test('Gemini P1-3: RPA targets are only pre-approved registry keys, with no duplicated secUid',()=>{
  const spec=JSON.parse(fs.readFileSync('config/r316-douyin-rpa-targets.json','utf8'));
  assert.ok(spec.targets.length<=2);
  const approved=new Set(cfg.douyin.filter(x=>x.scopeApproved===true).map(x=>x.key));
  for(const x of spec.targets){assert.deepEqual(Object.keys(x),['key']);assert.ok(approved.has(x.key));}
  const code=fs.readFileSync('probes/r316/douyin-rpa-two-once.mjs','utf8');
  assert.match(code,/ctx\.route\('\*\*\/\*'/);
  assert.match(code,/RPA_TARGET_NOT_SCOPE_APPROVED/);
});
test('Gemini P2-1: incomplete four-layer evidence is CANDIDATE, not VERIFIED',()=>{
  const acct=cfg.douyin[0];
  const report=reconcileDouyinFourLayers({opsRooms:[{roomId:'601',shopId:'1601',platform:'douyin'}],
    accounts:cfg.douyin,evidenceRows:[{opsRoomId:'601',opsShopId:'1601',accountKey:acct.key,
      publicSecUid:new URL(acct.profileUrl).pathname.slice('/user/'.length),publicLiveRoomId:'9001',
      observedAt:'2026-11-12T14:00:00.000Z',reviewApproved:false,proofs:[]}]});
  assert.equal(report.links[0].bridgeStatus,'CANDIDATE');
  assert.equal(report.links[0].status,'UNVERIFIED');
  assert.equal(report.verifiedLinks,0);
});
test('Gemini P2-2: source extractor reuses strict Beijing date helper',()=>{
  const source=fs.readFileSync('probes/r316/source-extract-once.mjs','utf8');
  assert.match(source,/beijingDate\(d\)/);
  assert.doesNotMatch(source,/DateTimeFormat\('en-CA'/);
  assert.match(source,/pub\.stopped = \{ label, reason: meta\.error \}/);
});
