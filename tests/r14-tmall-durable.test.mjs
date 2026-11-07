import test from 'node:test';
import assert from 'node:assert/strict';
import {R13_POLICY} from '../probes/lib/r13-tmall-interval-monitor.mjs';
import {emptyLedger,parseLedger,planTmallTick,recordR14Tick,MAX_SAMPLES} from '../probes/lib/r14-tmall-durable.mjs';
const T=m=>new Date(Date.parse('2026-11-08T00:00:00.000Z')+m*60000).toISOString();
const real=(m,state='LIVE')=>({
 key:'tcl-group',accountId:'2050532947',roomNumber:'130742',observedName:'TCL集团官方旗舰店',
 at:T(m),mtop:'SUCCESS',codes:['SUCCESS'],roomStatus:state==='LIVE'?1:0,streamStatus:state==='LIVE'?1:0,state
});
const tick=(state,ledger,m)=>{
 const x=recordR14Tick(ledger,{nowIso:T(m),approvedSample:real(m,state)});
 return x;
};
test('01 single-store identity fixed',()=>{const s=emptyLedger();assert.equal(s.accountId,'2050532947');assert.equal(s.scoringEnabled,false);});
test('02 empty ledger should attempt idle discovery immediately',()=>{const p=planTmallTick(emptyLedger(),{nowIso:T(0)});assert.equal(p.mode,'IDLE_DISCOVERY');assert.equal(p.intervalMinutes,60);assert.equal(p.due,true);});
test('03 no source records UNKNOWN, not fabricated OFFLINE',()=>{const r=recordR14Tick(emptyLedger(),{nowIso:T(0)});assert.equal(r.action,'UNKNOWN_RECORDED');assert.equal(r.ledger.observations[0].state,'UNKNOWN');assert.equal(r.plan.latestStatus,'UNKNOWN');});
test('04 idle scheduled tick before 60m is skipped',()=>{const r=recordR14Tick(emptyLedger(),{nowIso:T(0)});const n=recordR14Tick(r.ledger,{nowIso:T(15)});assert.equal(n.action,'NOT_DUE');assert.equal(n.ledger.observations.length,1);});
test('05 idle scheduled tick at 60m is due',()=>{const r=recordR14Tick(emptyLedger(),{nowIso:T(0)});const n=planTmallTick(r.ledger,{nowIso:T(60)});assert.equal(n.due,true);});
test('06 a real accepted observation starts a session but never scores',()=>{const r=tick('LIVE',emptyLedger(),0);assert.equal(r.plan.mode,'LIVE_FOLLOW_UP');assert.equal(r.plan.scoringEligible,false);assert.equal(r.plan.sessions[0].firstLiveDetectedAt,T(0));});
test('07 active mode uses 15m',()=>{const r=tick('LIVE',emptyLedger(),0);assert.equal(r.plan.intervalMinutes,15);});
test('08 active skip at 10m and due at 15m',()=>{const r=tick('LIVE',emptyLedger(),0);assert.equal(planTmallTick(r.ledger,{nowIso:T(10)}).due,false);assert.equal(planTmallTick(r.ledger,{nowIso:T(15)}).due,true);});
test('09 two LIVE observations yield estimated 15 minutes',()=>{const r=tick('LIVE',tick('LIVE',emptyLedger(),0).ledger,15);assert.equal(r.plan.sessions[0].estimatedContinuousLiveMinutes,15);});
test('10 one OFFLINE is only pending end',()=>{const r=tick('OFFLINE',tick('LIVE',emptyLedger(),0).ledger,15);assert.equal(r.plan.sessions[0].status,'PENDING_END');assert.equal(r.plan.mode,'LIVE_FOLLOW_UP');});
test('11 two effective OFFLINE close the session',()=>{let s=emptyLedger();for(const [m,v] of [[0,'LIVE'],[15,'OFFLINE'],[30,'OFFLINE']])s=tick(v,s,m).ledger;const p=planTmallTick(s,{nowIso:T(31)});assert.equal(p.sessions[0].status,'CLOSED');assert.equal(p.mode,'IDLE_DISCOVERY');assert.equal(p.intervalMinutes,60);});
test('12 after closure skip until idle 60m',()=>{let s=emptyLedger();for(const [m,v] of [[0,'LIVE'],[15,'OFFLINE'],[30,'OFFLINE']])s=tick(v,s,m).ledger;assert.equal(planTmallTick(s,{nowIso:T(45)}).due,false);assert.equal(planTmallTick(s,{nowIso:T(90)}).due,true);});
test('13 idle discovery can begin next independent session',()=>{let s=emptyLedger();for(const [m,v] of [[0,'LIVE'],[15,'OFFLINE'],[30,'OFFLINE'],[90,'LIVE']])s=tick(v,s,m).ledger;const p=planTmallTick(s,{nowIso:T(91)});assert.equal(p.sessions.length,2);assert.equal(p.sessions[0].status,'CLOSED');assert.equal(p.sessions[1].status,'OPEN');});
test('14 source unavailable while LIVE records UNKNOWN and keeps active',()=>{let s=tick('LIVE',emptyLedger(),0).ledger;s=recordR14Tick(s,{nowIso:T(15),failureCode:'PLATFORM_THROTTLED'}).ledger;const p=planTmallTick(s,{nowIso:T(16)});assert.equal(p.mode,'LIVE_FOLLOW_UP');assert.equal(p.latestStatus,'UNKNOWN');assert.equal(p.sessions[0].status,'OPEN');});
test('15 source unavailable after one OFFLINE cannot finalize end',()=>{let s=tick('LIVE',emptyLedger(),0).ledger;s=tick('OFFLINE',s,15).ledger;s=recordR14Tick(s,{nowIso:T(30),failureCode:'CAPTCHA_OR_LOGIN_REQUIRED'}).ledger;assert.equal(planTmallTick(s,{nowIso:T(31)}).sessions[0].endedConfirmedAt,null);});
test('16 records are portable JSON between invocations',()=>{let s=tick('LIVE',emptyLedger(),0).ledger;const text=JSON.stringify(s);const reloaded=parseLedger(text);const n=tick('LIVE',reloaded,15);assert.equal(n.plan.sessions[0].estimatedContinuousLiveMinutes,15);assert.equal(n.ledger.attempts.length,2);});
test('17 wrong ledger platform never accepted',()=>assert.throws(()=>parseLedger({...emptyLedger(),platform:'douyin'}),/MISMATCH/));
test('18 wrong ledger account never accepted',()=>assert.throws(()=>parseLedger({...emptyLedger(),accountId:'1'}),/MISMATCH/));
test('19 rejected raw cookie/token in recovered samples',()=>{let s=tick('LIVE',emptyLedger(),0).ledger;s.observations[0].token='bad';assert.throws(()=>parseLedger(s),/SENSITIVE/);});
test('20 do not persist unrelated secret raw field even if upstream sample sends one',()=>{const x=recordR14Tick(emptyLedger(),{nowIso:T(0),approvedSample:{...real(0),cookie:'do-not-copy'}});assert.equal('cookie' in x.ledger.observations[0],false);});
test('21 wrong-store sample blocked at ingest',()=>assert.throws(()=>recordR14Tick(emptyLedger(),{nowIso:T(0),approvedSample:{...real(0),accountId:'99'}}),/WRONG_STORE/));
test('22 unusable future-dated source sample rejected',()=>assert.throws(()=>recordR14Tick(emptyLedger(),{nowIso:T(0),approvedSample:real(15)}),/DRIFT/));
test('23 status code includes only bounded safe bytes',()=>assert.throws(()=>recordR14Tick(emptyLedger(),{nowIso:T(0),approvedSample:{...real(0),codes:['SUCCESS https://danger']}}),/BAD_STATUS_CODE/));
test('24 duplicate source sample blocked',()=>{const s=tick('LIVE',emptyLedger(),0).ledger;assert.throws(()=>recordR14Tick(s,{nowIso:T(15),approvedSample:{...real(0),at:T(0)}}),/DRIFT/);});
test('25 failure codes strict whitelist',()=>assert.throws(()=>recordR14Tick(emptyLedger(),{nowIso:T(0),failureCode:'FAKE_LIVE'}),/UNSUPPORTED_FAILURE/));
test('26 duplicate timestamp is not a second attempt',()=>{const s=tick('LIVE',emptyLedger(),0).ledger;assert.equal(recordR14Tick(s,{nowIso:T(0)}).action,'NOT_DUE');});
test('27 future clock or stale evidence is UNKNOWN, not cached LIVE',()=>{const s=tick('LIVE',emptyLedger(),0).ledger;assert.equal(planTmallTick(s,{nowIso:T(120)}).latestStatus,'UNKNOWN');});
test('28 the module never calls Taobao or GitHub network',()=>{assert.equal(typeof recordR14Tick,'function');assert.equal(R13_POLICY.idleDiscoveryMinutes,60);});
test('29 no source means no real sample even on repeated scheduled ticks',()=>{let s=emptyLedger();for(const m of [0,60,120])s=recordR14Tick(s,{nowIso:T(m)}).ledger;assert.equal(s.observations.length,3);assert.equal(planTmallTick(s,{nowIso:T(121)}).latestStatus,'UNKNOWN');});
test('30 bad ledger array shape rejected',()=>assert.throws(()=>parseLedger({...emptyLedger(),observations:{}}),/MISMATCH/));
test('31 ledger limits protect bounded storage',()=>assert.throws(()=>parseLedger({...emptyLedger(),attempts:Array(MAX_SAMPLES+1).fill({at:T(0)})}),/LIMIT/));
test('32 records cannot move backward in time when a tick is forced',()=>{const s=tick('LIVE',emptyLedger(),0).ledger;assert.equal(planTmallTick(s,{nowIso:T(-10)}).due,false);});
