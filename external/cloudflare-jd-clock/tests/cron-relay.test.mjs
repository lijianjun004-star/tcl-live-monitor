import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
  CRON, CRON_MINUTES, MAX_CRON_LATENESS_MS,
  decideRelay, dispatchBackup, runScheduled, beijingClock
} from '../src/index.mjs';

const ms=t=>Date.parse(t);
const decide=(when,delayMs=500)=>decideRelay({scheduledMs:ms(when),nowMs:ms(when)+delayMs});
const token='ghp_test_ONLY_NOT_REAL_1234567890';

test('one external free cron matches existing staggered backup opportunities',()=>{
  const c=JSON.parse(readFileSync(new URL('../wrangler.jsonc',import.meta.url),'utf8'));
  assert.deepEqual(c.triggers.crons,[CRON]);
  assert.deepEqual(CRON_MINUTES,[4,9,14,19,34,49,59]);
  assert.equal(c.workers_dev,false);
  assert.equal(c.main,'src/index.mjs');
  assert.equal(MAX_CRON_LATENESS_MS,4*60000);
});

test('Beijing boundaries: 06:19 blocked, 06:34 allowed, 01:59 allowed, 02:04 blocked',()=>{
  assert.equal(decide('2026-11-10T22:19:00.000Z').reason,'OUTSIDE_BEIJING_OPERATING_WINDOW');
  assert.equal(decide('2026-11-10T22:34:00.000Z').dispatch,true);
  assert.equal(decide('2026-11-11T17:59:00.000Z').dispatch,true);
  assert.equal(decide('2026-11-11T18:04:00.000Z').reason,'OUTSIDE_BEIJING_OPERATING_WINDOW');
  assert.equal(beijingClock(ms('2026-11-10T22:34:00.000Z')).hour,6);
});
test('only authorized minute slots can cause external GitHub actions',()=>{
  assert.equal(decide('2026-11-11T12:04:00.000Z').dispatch,true);
  assert.equal(decide('2026-11-11T12:05:00.000Z').reason,'NOT_AN_AUTHORIZED_CRON_SLOT');
  assert.equal(decide('2026-11-11T12:09:00.000Z').dispatch,true);
});
test('delayed cron cannot cause delayed out-of-window scan bursts',()=>{
  assert.equal(decide('2026-11-11T10:04:00.000Z',5*60000).reason,'STALE_OR_FUTURE_CRON');
  assert.equal(decide('2026-11-11T10:04:00.000Z',3*60000).dispatch,true);
  assert.equal(decide('2026-11-11T17:59:00.000Z',5*60000).dispatch,false);
});
test('invalid cron clock fails closed',()=>{
  assert.throws(()=>decideRelay({scheduledMs:NaN,nowMs:Date.now()}),/INVALID_SCHEDULE_TIME/);
  assert.throws(()=>decideRelay({scheduledMs:0,nowMs:undefined}),/INVALID_SCHEDULE_TIME/);
  assert.throws(()=>beijingClock('wrong'),/INVALID_CLOCK/);
});
test('outside window means no GitHub request and no token required',async()=>{
  let count=0;
  const r=await runScheduled({scheduledMs:ms('2026-11-10T22:19:00.000Z'),nowMs:ms('2026-11-10T22:19:00.000Z'),request:async()=>{count++;return {status:204}}});
  assert.equal(r.dispatch,false);
  assert.equal(count,0);
});
test('valid trigger requests GitHub Actions workflow_dispatch on MAIN only',async()=>{
  const calls=[];
  const reply=await runScheduled({
    scheduledMs:ms('2026-11-11T10:49:00.000Z'),
    nowMs:ms('2026-11-11T10:49:25.000Z'),token,
    request:async(url,opts)=>{calls.push({url,opts});return {status:204}}
  });
  assert.equal(reply.accepted,true);
  assert.equal(calls.length,1);
  assert.equal(calls[0].url,'https://api.github.com/repos/lijianjun004-star/tcl-live-monitor/actions/workflows/jd-r33-backup.yml/dispatches');
  assert.equal(calls[0].opts.method,'POST');
  assert.deepEqual(JSON.parse(calls[0].opts.body),{ref:'main'});
  assert.equal(calls[0].opts.headers.Authorization,'Bearer '+token);
});
test('GitHub dispatch 200 and 204 both count as acceptance; 401/403 never do',async()=>{
  assert.equal((await dispatchBackup({token,request:async()=>({status:200})})).accepted,true);
  assert.equal((await dispatchBackup({token,request:async()=>({status:204})})).accepted,true);
  for(const status of [401,403,404,429,500]){
    await assert.rejects(dispatchBackup({token,request:async()=>({status})}),new RegExp('GITHUB_DISPATCH_HTTP_'+status));
  }
});
test('missing token is rejected before request',async()=>{
  let count=0;
  await assert.rejects(dispatchBackup({token:'',request:async()=>{count++;return {status:204}}}),/GITHUB_ACTIONS_TOKEN_MISSING_OR_INVALID/);
  assert.equal(count,0);
});
test('secrets are never printed or hardcoded in error messages',async()=>{
  let message='';
  try{await dispatchBackup({token,request:async()=>({status:403,body:'secret'})})}catch(e){message=e.message}
  assert.equal(message,'GITHUB_DISPATCH_HTTP_403');
  assert.doesNotMatch(message,/ghp_test|Bearer|secret/);
  const source=readFileSync(new URL('../src/index.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(source,/console\.log\(.*env\.GH_ACTIONS_TOKEN|console\.log\(.*token/);
});
