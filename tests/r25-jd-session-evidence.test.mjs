import test from 'node:test';
import assert from 'node:assert/strict';
import {newJdSessionLedger,applyJdSessionEvidence,jdSessionSnapshot,validateJdSessionLedger}
  from '../probes/r25/jd-session-evidence.mjs';
const T='2026-11-10T12:00:00.000Z';
const at=m=>new Date(Date.parse(T)+m*60000).toISOString();
function obs(id,stream_state,min=0,opts={}){
 return {observation_id:id,platform:'jd',room_key:'room17',observed_at:at(min),
 stream_state,evidence:{method:stream_state==='LIVE'?'VERIFIED_INTERNAL_LIVE':
  'VERIFIED_JD_PLATFORM_NEGATIVE',identity_verified:true,source_attested:true,
  positive_live_confirmed:true,negative_offline_confirmed:true,
  platform_live_indicator_checked:true,captured_at:at(min),
  capture_id:'capture-'+id,...opts}};
}
const apply=(state,id,kind,min=0,opts={})=>
 applyJdSessionEvidence(state,obs(id,kind,min,opts));
test('a single observed LIVE is not proof of an actual opening instant',()=>{
 const x=apply(newJdSessionLedger('room17'),'L1','LIVE');
 const s=jdSessionSnapshot(x.ledger);
 assert.equal(s.stream_state,'LIVE');
 assert.equal(s.sessions[0].start_window.after_confirmed_offline_at,null);
 assert.equal(s.sessions[0].start_window.by_first_live_at,at(0));
 assert.equal(s.sessions[0].actual_started_at,null);
 assert.equal(s.opening_rate_percent,null);
});
test('one valid negative is not enough to mark OFFLINE',()=>{
 let s=apply(newJdSessionLedger('room17'),'L1','LIVE').ledger;
 const x=apply(s,'N1','OFFLINE',5);
 assert.equal(x.ledger.stream_state,'UNKNOWN');
 assert.equal(x.ledger.active_session_id,'L1');
 assert.equal(x.ledger.sessions[0].end_window,null);
 assert.equal(jdSessionSnapshot(x.ledger).pending_offline_review,true);
});
test('two independent verified negatives confirm only an observed end window',()=>{
 let s=apply(newJdSessionLedger('room17'),'L1','LIVE').ledger;
 s=apply(s,'L2','LIVE',5).ledger;
 s=apply(s,'N1','OFFLINE',10).ledger;
 const result=apply(s,'N2','OFFLINE',15);
 const p=jdSessionSnapshot(result.ledger);
 assert.equal(p.stream_state,'OFFLINE');
 assert.equal(p.active_session_id,null);
 assert.deepEqual(p.sessions[0].end_window,{
  after_last_live_at:at(5),by_first_verified_offline_at:at(10)});
 assert.equal(p.sessions[0].confirmed_offline_at,at(15));
 assert.equal(p.sessions[0].actual_ended_at,null);
 assert.equal(p.completed_duration_minutes,null);
 assert.equal(p.verified_interruption_count,null);
});
test('new LIVE after two negatives creates a distinct session with bounded start',()=>{
 let s=newJdSessionLedger('room17');
 for(const [id,kind,min] of [['L1','LIVE',0],['N1','OFFLINE',10],['N2','OFFLINE',15],['L3','LIVE',30]])
  s=apply(s,id,kind,min).ledger;
 const p=jdSessionSnapshot(s);
 assert.equal(p.sessions.length,2);
 assert.equal(p.sessions[1].start_window.after_confirmed_offline_at,at(15));
 assert.equal(p.sessions[1].first_live_observed_at,at(30));
 assert.equal(p.stream_state,'LIVE');
 assert.equal(p.sessions[1].presenter_type,'UNKNOWN');
});
test('LIVE following a negative invalidates the pending stop',()=>{
 let s=apply(newJdSessionLedger('room17'),'L1','LIVE').ledger;
 s=apply(s,'N1','OFFLINE',5).ledger;
 s=apply(s,'L2','LIVE',10).ledger;
 assert.equal(s.pending_offline,null);
 assert.equal(s.sessions.length,1);
 assert.equal(s.sessions[0].confirmed_offline_at,null);
 assert.equal(s.stream_state,'LIVE');
});
test('UNKNOWN does not imply offline or close the session',()=>{
 let s=apply(newJdSessionLedger('room17'),'L1','LIVE').ledger;
 const x=apply(s,'U1','UNKNOWN',5);
 assert.equal(x.ledger.stream_state,'UNKNOWN');
 assert.equal(x.ledger.sessions[0].confirmed_offline_at,null);
 assert.equal(x.ledger.active_session_id,'L1');
});
test('stale or unverified internal negative is UNKNOWN',()=>{
 let s=apply(newJdSessionLedger('room17'),'L1','LIVE').ledger;
 const a=apply(s,'N1','OFFLINE',8,{source_attested:false});
 assert.equal(a.ledger.stream_state,'UNKNOWN');
 assert.equal(a.ledger.pending_offline,null);
 const b=apply(a.ledger,'N2','OFFLINE',15,{captured_at:at(0)});
 assert.equal(b.ledger.pending_offline,null);
 assert.equal(b.ledger.sessions.length,1);
});
test('internal agent silence cannot act as JD platform negative',()=>{
 const s=apply(newJdSessionLedger('room17'),'L1','LIVE').ledger;
 const x=apply(s,'N1','OFFLINE',5,{method:'VERIFIED_INTERNAL_LIVE'});
 assert.equal(x.ledger.stream_state,'UNKNOWN');
 assert.equal(x.ledger.pending_offline,null);
});
test('same screenshot/capture twice cannot confirm ending',()=>{
 let s=apply(newJdSessionLedger('room17'),'L1','LIVE').ledger;
 s=apply(s,'N1','OFFLINE',5,{capture_id:'shot-one'}).ledger;
 s=apply(s,'N2','OFFLINE',10,{capture_id:'shot-one'}).ledger;
 assert.equal(s.stream_state,'UNKNOWN');
 assert.equal(s.sessions[0].end_window,null);
});
test('too-fast negative confirmation stays pending',()=>{
 let s=apply(newJdSessionLedger('room17'),'L1','LIVE').ledger;
 s=apply(s,'N1','OFFLINE',5).ledger;
 s=apply(s,'N2','OFFLINE',7).ledger;
 assert.equal(s.stream_state,'UNKNOWN');
 assert.equal(s.pending_offline.at,at(5));
});
test('two negatives separated more than 30 minutes restart the candidate',()=>{
 let s=apply(newJdSessionLedger('room17'),'L1','LIVE').ledger;
 s=apply(s,'N1','OFFLINE',5).ledger;
 s=apply(s,'N2','OFFLINE',40).ledger;
 assert.equal(s.stream_state,'UNKNOWN');
 assert.equal(s.pending_offline.at,at(40));
 assert.equal(s.sessions[0].confirmed_offline_at,null);
});
test('duplicate observation replay is idempotent; conflicting payload rejected',()=>{
 const a=apply(newJdSessionLedger('room17'),'L1','LIVE');
 const same=apply(a.ledger,'L1','LIVE');
 assert.equal(same.duplicate,true);
 assert.equal(same.ledger.sessions.length,1);
 assert.throws(()=>apply(a.ledger,'L1','OFFLINE'),/OBSERVATION_ID_REUSED/);
});
test('cross-room signals and out-of-order observations reject cleanly',()=>{
 const s=apply(newJdSessionLedger('room17'),'L1','LIVE',10).ledger;
 assert.throws(()=>applyJdSessionEvidence(s,{...obs('L2','LIVE',15),room_key:'room18'}),/INVALID_OBSERVATION/);
 assert.throws(()=>apply(s,'L3','LIVE',9),/OUT_OF_ORDER/);
 assert.equal(s.sessions.length,1);
});
test('strict persistence contract refuses fabricated formal metric',()=>{
 const s=newJdSessionLedger('room17');
 assert.throws(()=>validateJdSessionLedger({...s,opening_rate_percent:100}),/INVALID_SESSION_LEDGER/);
 assert.throws(()=>validateJdSessionLedger({...s,actual_start_times_verified:true}),/INVALID_SESSION_LEDGER/);
});
test('untrusted guessed LIVE is UNKNOWN, never session opened',()=>{
 const x=apply(newJdSessionLedger('room17'),'fake','LIVE',0,{source_attested:false});
 assert.equal(x.ledger.stream_state,'UNKNOWN');
 assert.equal(x.ledger.sessions.length,0);
 assert.equal(x.accepted,false);
});
