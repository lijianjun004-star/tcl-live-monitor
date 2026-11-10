import test from 'node:test';
import assert from 'node:assert/strict';
import {updateJdHistory,latestPublicSummary,validateState} from '../probes/r23/jd-history.mjs';
import {plannedSample,isOperatingTime,beijingClock,CRON} from '../probes/r23/jd-window.mjs';

const t='2026-11-10T12:00:00.000Z';
const at=(min)=>new Date(Date.parse(t)+min*60000).toISOString();
const room=(id,state='LIVE')=>({room_id:String(id),shop_id:String(Number(id)+1),
 category:'电视',state,reason:state==='LIVE'?'FRESH_MINUTE_DATA_STATUS_1':'UNVERIFIED',
 agent_alive:state==='LIVE',offline_candidate:false,minute_age_min:1});
const source=(rows=[room(17),room(19)])=>({
 schema_version:21,platform:'jd',source:'TCL_OPS_READ_ONLY',checked_at:t,
 readiness:'PARTIAL',room_count:rows.length,live:rows.filter(r=>r.state==='LIVE').length,
 unknown:rows.filter(r=>r.state==='UNKNOWN').length,offline:0,rooms:rows,
 formal_opening_rate_percent:null,formal_attendance_ready:false,
 fully_verified_public_accounts:false,fully_verified_schedule:false,
 catalog_complete_attested:false,warnings:['SHOP_CATALOG_NOT_PROVEN_COMPLETE']
});
const run=(prev,report=source(),minute=0,id='r1')=>updateJdHistory(prev,
 {...report,checked_at:at(minute)}, {now:at(minute),run_id:id});
test('first scan stores two observed LIVE internal rooms without creating actual starts',()=>{
 const out=run(null);
 assert.equal(out.source_accepted,true);
 assert.equal(out.counts.LIVE,2);assert.equal(out.counts.UNKNOWN,0);
 assert.equal(out.state.events.length,2);
 assert.deepEqual(out.state.events.map(x=>x.event),['FIRST_LIVE_SEEN','FIRST_LIVE_SEEN']);
 assert.equal(out.state.rooms['17'].first_live_seen_at,t);
 assert.equal(out.state.rooms['17'].actual_started_at,null);
 assert.equal(out.state.formal_opening_rate_percent,null);
});
test('next LIVE scan updates last-detected marker but not actual start',()=>{
 const a=run(null),b=run(a.state,source(),5,'r2');
 assert.equal(b.delta.length,0);
 assert.equal(b.state.checks.length,4);
 assert.equal(b.state.rooms['17'].last_live_seen_at,at(5));
 assert.equal(b.state.rooms['17'].actual_started_at,null);
});
test('partial catalog dropping one room creates UNKNOWN not OFFLINE',()=>{
 const a=run(null),b=run(a.state,source([room(17)]),5,'r2');
 assert.equal(b.counts.UNKNOWN,1);
 assert.equal(b.state.rooms['19'].state,'UNKNOWN');
 assert.equal(b.delta.find(x=>x.room_id==='19').event,'LIVE_SIGNAL_LOST_NOT_OFFLINE');
 assert.equal(b.state.rooms['19'].actual_ended_at,null);
 assert.equal(b.state.verified_offline_counter,0);
});
test('signal restoring after UNKNOWN is not treated as a new actual broadcast',()=>{
 const a=run(null),b=run(a.state,source([room(17),room(19,'UNKNOWN')]),5,'r2');
 const c=run(b.state,source(),10,'r3');
 assert.equal(c.delta.find(x=>x.room_id==='19').event,'LIVE_SIGNAL_RETURNED');
 assert.equal(c.state.rooms['19'].first_live_seen_at,t);
 assert.equal(c.state.rooms['19'].actual_started_at,null);
});
test('network blocked converts previous live into UNKNOWN without a false end',()=>{
 const a=run(null);
 const blocked={schema_version:21,readiness:'BLOCKED',reason:'SOURCE_UNAVAILABLE'};
 const b=run(a.state,blocked,5,'failure-1');
 assert.equal(b.source_accepted,false);
 assert.equal(b.counts.UNKNOWN,2);assert.equal(b.counts.OFFLINE,0);
 assert.equal(b.state.rooms['17'].actual_ended_at,null);
 assert.equal(b.state.events.at(-1).event,'LIVE_SIGNAL_LOST_NOT_OFFLINE');
});
test('history tracks newly discovered seventh room without six-room hardcode',()=>{
 const a=run(null),b=run(a.state,source([room(17),room(19),room(21)]),5,'r2');
 assert.equal(Object.keys(b.state.rooms).length,3);
 assert.equal(b.state.rooms['21'].state,'LIVE');
});
test('rerunning same workflow attempt is idempotent',()=>{
 const a=run(null),b=run(a.state,source(),5,'r1');
 assert.equal(b.duplicate,true);
 assert.equal(b.state.events.length,a.state.events.length);
 assert.equal(b.state.checks.length,a.state.checks.length);
});
test('stale source report cannot assert live',()=>{
 const a=run(null);
 const stale=source();stale.checked_at=t;
 const b=updateJdHistory(a.state,stale,{now:at(30),run_id:'r2'});
 assert.equal(b.source_accepted,false);
 assert.equal(b.counts.UNKNOWN,2);
});
test('invalid fake production rate and OFFLINE status are rejected',()=>{
 const v=source();v.formal_opening_rate_percent=100;
 assert.throws(()=>run(null,v),/SCAN_CONTRACT_MISMATCH/);
 const v2=source();v2.rooms[0].state='OFFLINE';v2.offline=1;v2.live=1;
 assert.throws(()=>run(null,v2),/SCAN_CONTRACT_MISMATCH/);
});
test('duplicate rooms cannot enter persisted journal',()=>{
 const v=source([room(17),room(17)]);
 assert.throws(()=>run(null,v),/SCAN_DUPLICATE_ROOM/);
});
test('different source provenance cannot insert false live',()=>{
 const v=source();v.source='UNTRUSTED_HTML';
 const o=run(null,v);
 assert.equal(o.source_accepted,false);
 assert.equal(o.counts.LIVE,0);
});
test('corrupt persistence refuses to silently reset and double count',()=>{
 assert.throws(()=>validateState({schema_version:23,platform:'jd',rooms:{},events:[]}),/BAD_PERSISTED_STATE/);
});
test('old observations render UNKNOWN after 15 minutes even when historic LIVE remains',()=>{
 const a=run(null);
 const p=latestPublicSummary(a.state,at(30));
 assert.equal(p.observed_live,0);
 assert.equal(p.current_unknown,2);
 assert.equal(p.rooms[0].last_observed_state,'LIVE');
 assert.equal(p.rooms[0].current_state,'UNKNOWN');
 assert.equal(p.opening_rate_percent,null);
});
test('current scan is explicitly marked as detected not actual start/end',()=>{
 const a=run(null),p=latestPublicSummary(a.state,at(3));
 assert.equal(p.observed_live,2);assert.equal(p.source_fresh,true);
 assert.equal(p.actual_start_times_verified,false);
 assert.equal(p.actual_end_times_verified,false);
 assert.equal(p.interruption_count_verified,false);
});
test('90-day expiration removes old check/event history but preserves identity safely',()=>{
 const a=run(null);
 const now='2027-03-01T12:00:00.000Z';
 const o=updateJdHistory(a.state,null,{now,run_id:'future-1'});
 assert.equal(o.state.checks.length,2);
 assert.equal(o.state.events.filter(x=>x.event==='FIRST_LIVE_SEEN').length,0);
 assert.equal(o.counts.OFFLINE,0);
});
test('clock reversal is not a new event',()=>{
 const a=run(null);
 assert.throws(()=>updateJdHistory(a.state,source(),{now:at(-3),run_id:'r2'}),/CLOCK_MOVED_BACKWARD/);
});
test('operating time is Beijing 06:30 until next-day 02:00',()=>{
 assert.equal(isOperatingTime('2026-11-09T22:29:00Z'),false); // Beijing 06:29
 assert.equal(isOperatingTime('2026-11-09T22:30:00Z'),true);
 assert.equal(isOperatingTime('2026-11-10T18:00:00Z'),true); // Beijing 02:00
 assert.equal(isOperatingTime('2026-11-10T18:05:00Z'),false);
});
test('5m near whole-hour and 15m off-peak are programmed in cron',()=>{
 assert.equal(CRON,'0,5,10,15,30,45,55 * * * *');
 const x=plannedSample('2026-11-10T09:55:00Z');
 assert.equal(x.critical,true);
 assert.equal(x.is_due,true);
 assert.equal(plannedSample('2026-11-10T09:30:00Z').critical,false);
 assert.equal(plannedSample('2026-11-10T09:24:00Z').is_due,false);
});
test('UTC-to-Beijing offset and midnight rollover are correct',()=>{
 assert.deepEqual(beijingClock('2026-11-10T18:00:00Z'),{hour:2,minute:0,second:0});
 assert.equal(plannedSample('2026-11-09T22:30:00Z').is_due,true);
});
