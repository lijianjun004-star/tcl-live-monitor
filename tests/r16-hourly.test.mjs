import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyLedger} from '../probes/lib/r14-tmall-durable.mjs';
import {HOURLY_POLICY,planHourly,recordUnverifiedHourlyAttempt,summarizeHourly} from '../probes/lib/r16-hourly.mjs';
const ts='2026-11-08T04:02:00.000Z';
const base=()=>emptyLedger();
const tick=(l,at,trigger='manual',reason='NO_APPROVED_SOURCE')=>recordUnverifiedHourlyAttempt(l,{atIso:at,trigger,reason});
test('60-minute live and idle cadence',()=>{
 assert.equal(HOURLY_POLICY.liveIntervalMinutes,60);
 assert.equal(HOURLY_POLICY.idleDiscoveryMinutes,60);
 assert.equal(HOURLY_POLICY.contiguousLiveMaxGapMinutes,65);
 assert.equal(HOURLY_POLICY.confirmationMaxGapMinutes,65);
});
test('Beijing boundary is UTC aligned, clock delay preserved',()=>{
 const p=planHourly('2026-11-07T16:01:01Z');
 assert.equal(p.plannedSlotAt,'2026-11-07T16:00:00.000Z');
 assert.equal(p.delayMinutes,1.02);
 assert.equal(p.exactHourGuaranteed,false);
});
test('Beijing midnight is not merged into previous hour',()=>{
 assert.equal(planHourly('2026-11-07T15:59:59Z').plannedSlotAt,'2026-11-07T15:00:00.000Z');
 assert.equal(planHourly('2026-11-07T16:00:00Z').plannedSlotAt,'2026-11-07T16:00:00.000Z');
});
test('manual run records UNKNOWN without requesting platform',()=>{
 const r=tick(base(),ts);
 assert.equal(r.action,'UNKNOWN_ATTEMPT_RECORDED');
 assert.equal(r.ledger.observations[0].state,'UNKNOWN');
 assert.equal(r.ledger.attempts[0].sourceAttempted,false);
});
test('manual can repeat within an hour',()=>{
 const r=tick(tick(base(),ts).ledger,'2026-11-08T04:30:00Z');
 assert.equal(r.ledger.attempts.length,2);
});
test('hourly schedule is idempotent within same hour',()=>{
 const r=tick(tick(base(),ts,'scheduled').ledger,'2026-11-08T04:10:00Z','scheduled');
 assert.equal(r.action,'DUPLICATE_HOUR_SKIPPED');
 assert.equal(r.ledger.attempts.length,1);
});
test('subsequent hour creates separate attempt',()=>{
 const r=tick(tick(base(),ts,'scheduled').ledger,'2026-11-08T05:05:00Z','scheduled');
 assert.equal(r.ledger.attempts.length,2);
});
test('exact duplicate timestamp skipped',()=>{
 const r=tick(tick(base(),ts).ledger,ts);
 assert.equal(r.action,'DUPLICATE_TIME_SKIPPED');
});
test('reversed chronology blocked',()=>assert.throws(()=>tick(tick(base(),ts).ledger,'2026-11-08T03:00:00Z'),/NON_MONOTONIC/));
test('fake LIVE input is ignored completely',()=>{
 const r=recordUnverifiedHourlyAttempt(base(),{atIso:ts,trigger:'manual',state:'LIVE',accountId:'other'});
 assert.equal(r.ledger.observations[0].state,'UNKNOWN');
 assert.equal(r.ledger.accountId,'2050532947');
});
test('throttle and login failures never become OFFLINE',()=>{
 let l=base();
 l=tick(l,ts,'manual','PLATFORM_THROTTLED').ledger;
 l=tick(l,'2026-11-08T04:03:00Z','manual','CAPTCHA_OR_LOGIN_REQUIRED').ledger;
 assert.equal(summarizeHourly(l,{asOf:'2026-11-08T04:04:00Z'}).currentState,'UNKNOWN');
});
test('invalid statuses and bad triggers rejected',()=>{
 assert.throws(()=>tick(base(),ts,'manual','LIVE'),/UNSUPPORTED/);
 assert.throws(()=>tick(base(),ts,'probe'),/INVALID_TRIGGER/);
 assert.throws(()=>tick(base(),'not-a-date'),/INVALID_TIME/);
});
test('unknown means unknown, not false offline',()=>{
 const s=summarizeHourly(tick(base(),ts).ledger,{asOf:ts});
 assert.equal(s.currentState,'UNKNOWN');
 assert.equal(s.activeSourceConnected,false);
 assert.equal(s.scoringEnabled,false);
 assert.equal(s.intervalMinutes,60);
});
test('historical verified LIVE remains historical, current is UNKNOWN',()=>{
 const l=base();
 l.observations.push({key:'tcl-group',accountId:'2050532947',
  at:'2026-11-07T08:18:10.528Z',observedName:'TCL集团官方旗舰店',roomNumber:'130742',
  roomStatus:1,streamStatus:1,mtop:'SUCCESS',codes:['SUCCESS'],state:'LIVE'});
 const out=summarizeHourly(l,{asOf:'2026-11-08T04:00:00Z'});
 assert.equal(out.currentState,'UNKNOWN');
 assert.equal(out.sessions.length,1);
 assert.equal(out.sessions[0].exactPlatformStartEnd,false);
});
test('two consecutive hourly LIVE points provide estimated span only',()=>{
 const l=base();
 for (const at of ['2026-11-07T08:00:00Z','2026-11-07T09:00:00Z'])
 l.observations.push({key:'tcl-group',accountId:'2050532947',at,
 observedName:'TCL集团官方旗舰店',roomNumber:'130742',
 roomStatus:1,streamStatus:1,mtop:'SUCCESS',codes:['SUCCESS'],state:'LIVE'});
 const out=summarizeHourly(l,{asOf:'2026-11-07T09:00:00Z'});
 assert.equal(out.sessions[0].observedAdjacentLiveSpanMinutes,60);
 assert.equal(out.sessions[0].exactPlatformStartEnd,false);
});
test('two OFFLINE observations confirm first offline, not exact end',()=>{
 const l=base();
 for (const [at,state] of [
 ['2026-11-07T08:00:00Z','LIVE'],['2026-11-07T09:00:00Z','LIVE'],
 ['2026-11-07T10:00:00Z','OFFLINE'],['2026-11-07T11:00:00Z','OFFLINE']])
 l.observations.push({key:'tcl-group',accountId:'2050532947',at,
 observedName:'TCL集团官方旗舰店',roomNumber:'130742',
 roomStatus:state==='LIVE'?1:0,streamStatus:state==='LIVE'?1:0,
 mtop:'SUCCESS',codes:['SUCCESS'],state});
 const out=summarizeHourly(l,{asOf:'2026-11-07T11:00:00Z'});
 assert.equal(out.sessions[0].status,'CLOSED');
 assert.equal(out.sessions[0].firstOfflineSeenAt,'2026-11-07T10:00:00.000Z');
 assert.equal(out.sessions[0].secondOfflineConfirmedAt,'2026-11-07T11:00:00.000Z');
});
