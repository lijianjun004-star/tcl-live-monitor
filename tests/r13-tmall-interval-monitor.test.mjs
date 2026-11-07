import test from 'node:test';
import assert from 'node:assert/strict';
import {reduceTmallSingleStore,renderR13Markdown,R13_POLICY,assertR13Policy} from '../probes/lib/r13-tmall-interval-monitor.mjs';
import {readFileSync} from 'node:fs';
const fixture=JSON.parse(readFileSync(new URL('../docs/evidence/r12-tmall-tcl-group-archived-samples.json',import.meta.url),'utf8'));
const rawHistory=fixture.runs.flatMap(x=>x.samples.filter(s=>s.kind!=='summary-only'));
const at=(m)=>new Date(Date.parse('2026-11-08T00:00:00Z')+m*60000).toISOString();
const ok=(m,v)=>({
 key:'tcl-group',accountId:'2050532947',roomNumber:'130742',
 observedName:'TCL集团官方旗舰店',codes:['SUCCESS'],mtop:'SUCCESS',
 roomStatus:v==='LIVE'?1:0,streamStatus:v==='LIVE'?1:0,
 state:v,at:at(m)
});
const bad=(m,reason='RGV587_ERROR')=>({
 key:'tcl-group',accountId:'2050532947',roomNumber:null,observedName:null,
 codes:[reason],mtop:'THROTTLED_OR_VALIDATION',roomStatus:null,streamStatus:null,
 state:'UNKNOWN',at:at(m)
});
const view=(rows,minute=130)=>reduceTmallSingleStore(rows,{asOf:at(minute)});
test('01 uses 15 minute active interval',()=>assert.equal(R13_POLICY.liveIntervalMinutes,15));
test('02 uses 60 minute passive discovery after stop',()=>assert.equal(R13_POLICY.idleDiscoveryMinutes,60));
test('03 no roster even with zero samples',()=>{let r=view([]);assert.equal(r.mode,'IDLE_DISCOVERY');assert.equal(r.currentStatus,'UNKNOWN');assert.deepEqual(r.sessions,[]);});
test('04 first true LIVE starts one session',()=>{let r=view([ok(0,'LIVE')],2);assert.equal(r.mode,'LIVE_FOLLOW_UP');assert.equal(r.sessions[0].firstLiveDetectedAt,at(0));assert.equal(r.currentStatus,'LIVE');});
test('05 adjacent successful LIVE gives only estimated span',()=>{let r=view([ok(0,'LIVE'),ok(15,'LIVE'),ok(30,'LIVE')],31);assert.equal(r.sessions[0].estimatedContinuousLiveMinutes,30);assert.equal(r.sessions[0].durationQualification,'ESTIMATE_FROM_ADJACENT_LIVE_SAMPLES_NOT_ACTUAL_DURATION');});
test('06 one OFFLINE cannot close',()=>{let r=view([ok(0,'LIVE'),ok(15,'OFFLINE')],16);assert.equal(r.sessions[0].status,'PENDING_END');assert.equal(r.sessions[0].endedConfirmedAt,null);assert.equal(r.mode,'LIVE_FOLLOW_UP');});
test('07 two independent OFFLINE confirmations close',()=>{let r=view([ok(0,'LIVE'),ok(15,'LIVE'),ok(30,'OFFLINE'),ok(45,'OFFLINE')],46);assert.equal(r.sessions[0].status,'CLOSED');assert.equal(r.sessions[0].firstOfflineDetectedAt,at(30));assert.equal(r.sessions[0].endedConfirmedAt,at(45));assert.equal(r.mode,'IDLE_DISCOVERY');assert.equal(r.recommendedNextIntervalMinutes,60);});
test('08 unknown RGV587 does NOT close',()=>{let r=view([ok(0,'LIVE'),bad(15),bad(30)],31);assert.equal(r.sessions[0].status,'OPEN');assert.equal(r.mode,'LIVE_FOLLOW_UP');assert.equal(r.currentStatus,'UNKNOWN');});
test('09 unknown between LIVE samples breaks continuity estimate',()=>{let r=view([ok(0,'LIVE'),bad(15),ok(30,'LIVE')],31);assert.equal(r.sessions[0].estimatedContinuousLiveMinutes,0);});
test('10 LIVE after a one-off OFFLINE cancels end',()=>{let r=view([ok(0,'LIVE'),ok(15,'OFFLINE'),ok(30,'LIVE')],31);assert.equal(r.sessions[0].status,'OPEN');assert.equal(r.sessions[0].offlineCandidatesDiscarded,1);});
test('11 UNKNOWN between OFFLINE confirmations cancels end',()=>{let r=view([ok(0,'LIVE'),ok(15,'OFFLINE'),bad(30),ok(45,'OFFLINE')],46);assert.equal(r.sessions[0].status,'PENDING_END');assert.equal(r.sessions[0].endedConfirmedAt,null);});
test('12 two OFFLINE observations separated by a long gap do not close',()=>{let r=view([ok(0,'LIVE'),ok(15,'OFFLINE'),ok(70,'OFFLINE')],71);assert.equal(r.sessions[0].status,'PENDING_END');assert.equal(r.mode,'LIVE_FOLLOW_UP');});
test('13 can discover next live after a closed session',()=>{let r=view([ok(0,'LIVE'),ok(15,'OFFLINE'),ok(30,'OFFLINE'),ok(90,'LIVE')],91);assert.equal(r.sessions.length,2);assert.equal(r.sessions[0].status,'CLOSED');assert.equal(r.sessions[1].status,'OPEN');assert.equal(r.sessions[1].sequence,2);});
test('14 offline before any LIVE does not invent a session',()=>{let r=view([ok(0,'OFFLINE'),ok(15,'OFFLINE')],16);assert.equal(r.sessions.length,0);assert.equal(r.mode,'IDLE_DISCOVERY');});
test('15 stale last LIVE must show current UNKNOWN',()=>{let r=view([ok(0,'LIVE')],200);assert.equal(r.currentStatus,'UNKNOWN');assert.equal(r.mode,'LIVE_FOLLOW_UP');assert.equal(r.currentStatusReason,'LAST_OBSERVATION_STALE');});
test('16 wrong account ID cannot create live',()=>{let r=view([{...ok(0,'LIVE'),accountId:'2050532948'}],2);assert.equal(r.sessions.length,0);assert.equal(r.currentStatus,'UNKNOWN');});
test('17 wrong room ID cannot create live',()=>{let r=view([{...ok(0,'LIVE'),roomNumber:'130743'}],2);assert.equal(r.sessions.length,0);});
test('18 source reported LIVE without real success code does not count',()=>{let r=view([{...ok(0,'LIVE'),mtop:'ERROR',codes:['ERROR']}],2);assert.equal(r.sessions.length,0);});
test('19 HTTP access error mapped UNKNOWN cannot add live time',()=>{let r=view([ok(0,'LIVE'),{...ok(15,'LIVE'),mtop:'THROTTLED_OR_VALIDATION',codes:['RGV587_ERROR']}],16);assert.equal(r.sessions[0].estimatedContinuousLiveMinutes,0);});
test('20 repeated identical sample has no effect',()=>{let r=view([ok(0,'LIVE'),ok(0,'LIVE')],1);assert.equal(r.observationCounts.LIVE,1);});
test('21 conflicting observations at same timestamp fail closed',()=>assert.throws(()=>view([ok(0,'LIVE'),ok(0,'OFFLINE')],1),/CONFLICTING_SAMPLES/));
test('22 future-dated samples are excluded',()=>{let r=view([ok(15,'LIVE')],10);assert.equal(r.currentStatus,'UNKNOWN');assert.equal(r.excluded[0].reason,'FUTURE_OBSERVATION');});
test('23 missing time samples are excluded',()=>{let r=view([{...ok(0,'LIVE'),at:null}],2);assert.equal(r.sessions.length,0);assert.equal(r.excluded[0].reason,'MISSING_OBSERVATION_TIME');});
test('24 no official start or end time is inferred',()=>{let r=view([ok(0,'LIVE'),ok(15,'OFFLINE'),ok(30,'OFFLINE')],31);assert.equal(r.actualStartEndKnown,false);assert.equal(r.sessions[0].endWindow.afterLastLive,at(0));assert.equal(r.sessions[0].endWindow.noLaterThanFirstObservedOffline,at(15));});
test('25 no formal score, cron, or data-source approval',()=>{let r=view([ok(0,'LIVE')],2);assert.equal(r.scoreEligible,false);assert.equal(r.scheduledPollingEnabled,false);assert.equal(r.sourceAccessValidated,false);});
test('26 invalid policy values rejected',()=>assert.throws(()=>assertR13Policy({...R13_POLICY,idleDiscoveryMinutes:0}),/INVALID_POLICY/));
test('27 true archived R1.2 evidence produces historical sessions and UNKNOWN today',()=>{let r=reduceTmallSingleStore(rawHistory,{asOf:'2026-11-09T00:00:00Z'});assert.equal(r.currentStatus,'UNKNOWN');assert.equal(r.sessions.length,1);assert.equal(r.sessions[0].status,'OPEN');assert.equal(r.observationCounts.LIVE,5);assert.equal(r.observationCounts.UNKNOWN,3);});
test('28 old archive never asserts current LIVE even if last row was success',()=>{let r=reduceTmallSingleStore(rawHistory,{asOf:'2026-11-08T00:00:00Z'});assert.equal(r.currentStatus,'UNKNOWN');});
test('29 markdown labels estimates and does not claim actual timestamps',()=>{let m=renderR13Markdown(view([ok(0,'LIVE')],2));assert.match(m,/估算/);assert.match(m,/不是平台真实的开关播时刻/);});
test('30 disconnected >22 minute success samples are not interpolated',()=>{let r=view([ok(0,'LIVE'),ok(45,'LIVE')],46);assert.equal(r.sessions[0].estimatedContinuousLiveMinutes,0);});
test('31 sorted timeline even if input out of order',()=>{let r=view([ok(30,'OFFLINE'),ok(0,'LIVE'),ok(45,'OFFLINE')],46);assert.equal(r.sessions[0].status,'CLOSED');});
test('32 unknown observations after closure do not reopen old session',()=>{let r=view([ok(0,'LIVE'),ok(15,'OFFLINE'),ok(30,'OFFLINE'),bad(45)],46);assert.equal(r.sessions.length,1);assert.equal(r.sessions[0].status,'CLOSED');assert.equal(r.currentStatus,'UNKNOWN');});
