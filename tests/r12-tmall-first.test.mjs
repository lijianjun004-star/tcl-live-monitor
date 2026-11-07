import test from 'node:test';import assert from 'node:assert/strict';
import {FIRST_TARGET,classifyObservation,currentView,summarizeHistoricalRuns} from '../probes/lib/r12-tmall-first.mjs';
// Eight row-level historical samples extracted from GitHub Actions 42354838292.
// Later production runs 42356267543 and 42357590016 expose aggregated statuses only.
const base={key:'tcl-group',accountId:'2050532947',observedName:'TCL集团官方旗舰店',roomNumber:'130742'};
const live=(arm,round,at,code='SUCCESS')=>({...base,arm,round,at,
 mtop:code==='SUCCESS'?'SUCCESS':'SUCCESS_AFTER_TOKEN_REFRESH',
 codes:code==='SUCCESS'?['SUCCESS']:['FAIL_SYS_TOKEN_EMPTY','SUCCESS'],
 state:'LIVE',roomStatus:1,streamStatus:1});
const blocked=(round,at)=>({...base,arm:'baseline',round,at,
 mtop:'THROTTLED_OR_VALIDATION',codes:['RGV587_ERROR'],state:'UNKNOWN',
 roomStatus:null,streamStatus:null});
const fix=[
 live('fix',1,'2026-11-07T08:18:10.528Z','TOKEN_REFRESH'),
 live('fix',2,'2026-11-07T08:23:10.871Z'),
 live('fix',3,'2026-11-07T08:28:10.124Z'),
 live('fix',4,'2026-11-07T08:33:10.928Z')];
const baseline=[
 live('baseline',1,'2026-11-07T08:18:13.206Z','TOKEN_REFRESH'),
 blocked(2,'2026-11-07T08:23:21.811Z'),
 blocked(3,'2026-11-07T08:28:21.765Z'),
 blocked(4,'2026-11-07T08:33:21.941Z')];
const summaries=(n,state)=>Array.from({length:n},(_,i)=>({kind:'summary-only',round:i+1,state}));
const fixture={runs:[
 {id:42354838292,arm:'fix',samples:fix},
 {id:42354838292,arm:'baseline',samples:baseline},
 {id:42356267543,arm:'production',samples:summaries(4,'UNKNOWN')},
 {id:42357590016,arm:'production',samples:summaries(3,'LIVE')} ]};
test('01 first account is TCL group 2050532947/130742',()=>{assert.equal(FIRST_TARGET.accountId,'2050532947');assert.equal(FIRST_TARGET.historicalRoomNum,'130742');});
test('02 four independent fix-arm samples',()=>assert.equal(fix.length,4));
test('03 all fix samples are account/room-matched historical LIVE',()=>{for(const s of fix){const x=classifyObservation(s);assert.equal(x.state,'LIVE');assert.equal(x.accountMatches,true);assert.equal(x.roomMatches,true);assert.equal(x.scoreEligible,false);}});
test('04 baseline 1 LIVE 3 UNKNOWN',()=>assert.deepEqual(baseline.map(s=>classifyObservation(s).state),['LIVE','UNKNOWN','UNKNOWN','UNKNOWN']));
test('05 RGV587 must not mark OFFLINE',()=>assert.equal(classifyObservation(baseline[1]).reason,'PLATFORM_THROTTLED'));
test('06 HTTP 200 without success code cannot prove LIVE',()=>assert.equal(classifyObservation({...fix[0],http:200,codes:['ERROR']}).state,'UNKNOWN'));
test('07 wrong account ID is a conflict',()=>assert.equal(classifyObservation({...fix[0],accountId:'2050532948'}).reason,'ACCOUNT_ID_CONFLICT'));
test('08 wrong roomNum is a conflict',()=>assert.equal(classifyObservation({...fix[0],roomNumber:'130743'}).reason,'ROOM_ID_CONFLICT'));
test('09 mismatched shop name is review-needed',()=>assert.equal(classifyObservation({...fix[0],observedName:'Other'}).reason,'OBSERVED_NAME_CONFLICT'));
test('10 missing timestamp yields UNKNOWN',()=>assert.equal(classifyObservation({...fix[0],at:null}).state,'UNKNOWN'));
test('11 inconsistent room/stream status yields UNKNOWN',()=>assert.equal(classifyObservation({...fix[0],roomStatus:0,streamStatus:1}).state,'UNKNOWN'));
test('12 offline requires two zero indicators',()=>assert.equal(classifyObservation({...fix[0],roomStatus:0,streamStatus:0,state:'OFFLINE'}).state,'OFFLINE'));
test('13 contradictory source reported state blocks promotion',()=>assert.equal(classifyObservation({...fix[0],state:'OFFLINE'}).reason,'SOURCE_STATE_CONFLICT'));
test('14 stale LIVE is current UNKNOWN',()=>assert.equal(currentView(classifyObservation(fix[3]),'2026-11-07T09:00:00Z').state,'UNKNOWN'));
test('15 only bounded-recent observation may show LIVE',()=>assert.equal(currentView(classifyObservation(fix[3]),'2026-11-07T08:40:00Z').state,'LIVE'));
test('16 future-dated evidence is UNKNOWN',()=>assert.equal(currentView(classifyObservation(fix[3]),'2026-11-07T08:30:00Z').state,'UNKNOWN'));
test('17 historical runs keep A/B and production distinct',()=>{const r=summarizeHistoricalRuns(fixture);assert.equal(r.runs.length,4);assert.deepEqual(r.runs.map(x=>x.totals),[{LIVE:4,OFFLINE:0,UNKNOWN:0},{LIVE:1,OFFLINE:0,UNKNOWN:3},{LIVE:0,OFFLINE:0,UNKNOWN:4},{LIVE:3,OFFLINE:0,UNKNOWN:0}]);});
test('18 production aggregate-only cannot become current LIVE',()=>{const r=summarizeHistoricalRuns(fixture);for(const run of r.runs.slice(2))for(const s of run.samples){assert.equal(s.at,null);assert.equal(currentView(s,'2026-11-07T23:00:00Z').state,'UNKNOWN');}});
test('19 no automatic reliable-monitor approval or scoring',()=>{const r=summarizeHistoricalRuns(fixture);assert.equal(r.currentState,'UNKNOWN');assert.equal(r.reliableMonitoringPassed,false);assert.equal(r.scoringEligible,false);});
test('20 duplicate rounds prohibited',()=>assert.throws(()=>summarizeHistoricalRuns({runs:[fixture.runs[0],fixture.runs[0]]}),/Repeated/));
test('21 invalid current time / age throws',()=>{assert.throws(()=>currentView(classifyObservation(fix[3]),'bad'),/Invalid/);assert.throws(()=>currentView(classifyObservation(fix[3]),'2026-11-07T09:00:00Z',999),/Invalid/);});
test('22 no cross-account mixed status',()=>assert.equal(classifyObservation({...fix[0],key:'tmall-ffalcon-tv'}).reason,'SOURCE_KEY_MISMATCH'));
