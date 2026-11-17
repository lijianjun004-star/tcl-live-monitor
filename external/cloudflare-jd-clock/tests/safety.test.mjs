import test from 'node:test';
import assert from 'node:assert/strict';
import worker, {dispatchBackup, runScheduled, beijingClock} from '../src/index.mjs';
const token = 'SYNTHETIC_TOKEN_ONLY_123456789';
test('timeout aborts even an uncooperative transport, without retry', async () => {
  let calls = 0, signal;
  await assert.rejects(dispatchBackup({token, timeoutMs: 5, request: async (_, opts) => {
    calls++; signal = opts.signal; return new Promise(() => {});
  }}), {message: 'GITHUB_DISPATCH_TIMEOUT_OUTCOME_UNKNOWN'});
  assert.equal(calls, 1); assert.equal(signal.aborted, true);
});
test('transport exceptions are redacted, including synchronous exceptions', async () => {
  for (const request of [() => {throw Error(token)}, async () => {throw Error(token)}]) {
    await assert.rejects(dispatchBackup({token, request}),
      {message: 'GITHUB_DISPATCH_TRANSPORT_OUTCOME_UNKNOWN'});
  }
});
test('manual redirect policy rejects every redirect and unexpected final target', async () => {
  for (const response of [{status:301}, {status:302}, {status:307}, {status:308},
    {status:204, redirected:true}, {status:0,type:'opaqueredirect'},
    {status:204,url:'https://invalid.example/'}]) {
    let calls=0;
    await assert.rejects(dispatchBackup({token, request: async (_, opts) => {
      calls++; assert.equal(opts.redirect,'manual'); return response;
    }}), {message:'GITHUB_DISPATCH_REDIRECT_REJECTED'});
    assert.equal(calls,1);
  }
});
test('invalid status never enters error text and response body is never read', async () => {
  for (const status of [token, undefined, NaN, 999]) {
    await assert.rejects(dispatchBackup({token,request:async()=>({status})}),
      {message:'GITHUB_DISPATCH_INVALID_RESPONSE'});
  }
  const result=await dispatchBackup({token,request:async()=>({status:204,
    get body(){throw Error('BODY_READ')}, get headers(){throw Error('HEADERS_READ')}})});
  assert.equal(result.workflowRunId,null); assert.equal(result.sourceOutcome,'UNVERIFIED');
});
test('bad timeout rejected before any request and success clears deadline', async () => {
  for(const timeoutMs of [0,-1,10001,NaN,1.5]) {
    await assert.rejects(dispatchBackup({token,timeoutMs,request:()=>assert.fail('network')}),
      {message:'INVALID_REQUEST_TIMEOUT'});
  }
  let signal;
  await dispatchBackup({token,timeoutMs:5,request:async(_,opts)=>{signal=opts.signal;return{status:200}}});
  await new Promise(resolve=>setTimeout(resolve,15));
  assert.equal(signal.aborted,false);
});
test('missing persistence and feedback blocks duplicates, later rounds and fresh isolates', async () => {
  const start=Date.parse('2026-11-11T10:04:00Z'); let calls=0;
  const request=()=>{calls++;throw Error('NETWORK_FORBIDDEN')};
  for(const delta of [0,0,5,10,15,30,45,55,60,1440]) {
    const scheduledMs=start+delta*60000;
    const result=await runScheduled({scheduledMs,nowMs:scheduledMs,token,request});
    assert.equal(result.dispatch,false);assert.equal(result.accepted,false);
    assert.equal(result.reason,'PERSISTENCE_AND_SOURCE_FEEDBACK_UNCONFIGURED');
    assert.equal(result.opportunityId,'jd-clock-'+scheduledMs);
  }
  const fresh=await import('../src/index.mjs?synthetic-cold-start');
  assert.equal((await fresh.runScheduled({scheduledMs:start,nowMs:start,token,request})).dispatch,false);
  assert.equal(calls,0);
});
test('actual worker entry point cannot dispatch with a token alone', async () => {
  const previousFetch=globalThis.fetch, previousLog=console.log; const logs=[];
  globalThis.fetch=()=>assert.fail('NETWORK_FORBIDDEN');console.log=s=>logs.push(s);
  try {await worker.scheduled({scheduledTime:Date.now()},{GH_ACTIONS_TOKEN:token});}
  finally {globalThis.fetch=previousFetch;console.log=previousLog;}
  assert.equal(logs.length,1);assert.equal(JSON.parse(logs[0]).accepted,false);
  assert.ok(!logs[0].includes(token));
});
test('finite out-of-range clocks are invalid',()=>{
  assert.throws(()=>beijingClock(Number.MAX_VALUE),/INVALID_CLOCK/);
});
