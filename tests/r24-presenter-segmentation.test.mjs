import test from 'node:test';
import assert from 'node:assert/strict';
import {createPresenterLedger,addPresenterObservation,presenterSnapshot} from '../probes/r24/presenter-sessions.mjs';
const T='2026-11-10T12:00:00.000Z';
const at=m=>new Date(Date.parse(T)+m*60000).toISOString();
const initial=(platform='jd',shop_key='shop17')=>createPresenterLedger({platform,shop_key});
const obs=(id,kind,minute=0,evidence='REVIEWED_REPLAY',platform='jd',shop_key='shop17')=>
 ({id,kind,observed_at:at(minute),evidence,platform,shop_key});
const send=(s,id,kind,minute=0,evidence='REVIEWED_REPLAY')=>
 addPresenterObservation(s,obs(id,kind,minute,evidence,s.platform,s.shop_key)).ledger;
test('human visual evidence opens a human segment, never asserts JD stream LIVE',()=>{
 const s=send(initial(),'v1','HUMAN_PRESENT');
 const p=presenterSnapshot(s);
 assert.equal(p.current_presenter,'HUMAN');
 assert.equal(p.live_status,'UNKNOWN');
 assert.equal(p.segments.length,1);
 assert.equal(p.segments[0].actual_started_at,null);
 assert.equal(p.actual_human_minutes,null);
});
test('digital appearance while a human has not ended is a review conflict',()=>{
 const a=send(initial(),'h1','HUMAN_PRESENT');
 const out=addPresenterObservation(a,obs('d1','DIGITAL_PRESENT',5));
 assert.equal(out.ledger.current_presenter,'UNKNOWN');
 assert.equal(out.ledger.active_mode,'HUMAN');
 assert.equal(out.ledger.segments.length,1);
 assert.equal(out.flags[0].code,'PRESENTER_SWITCH_WITHOUT_CONFIRMED_END');
});
test('human stop followed by digital is two segments, not continuous human streaming',()=>{
 const a=send(initial(),'h1','HUMAN_PRESENT');
 const b=send(a,'h2','HUMAN_STOP_OBSERVED',120);
 const c=send(b,'d1','DIGITAL_PRESENT',121);
 const p=presenterSnapshot(c);
 assert.deepEqual(p.segments.map(s=>s.mode),['HUMAN','DIGITAL']);
 assert.equal(p.segments[0].stop_detected_at,at(120));
 assert.equal(p.segments[1].human_end_before_digital_confirmed,true);
 assert.equal(p.current_presenter,'DIGITAL');
 assert.equal(p.actual_human_minutes,null);
 assert.equal(p.actual_digital_minutes,null);
 assert.equal(p.actual_end_times_verified,false);
});
test('first observed digital is possible but cannot prove a preceding human end',()=>{
 const a=send(initial(),'d1','DIGITAL_PRESENT');
 assert.equal(a.current_presenter,'DIGITAL');
 assert.equal(a.segments[0].human_end_before_digital_confirmed,false);
 assert.equal(a.review_flags[0].code,'PRIOR_HUMAN_END_NOT_OBSERVED');
});
test('unknown/failed signal is not evidence of stopping a human session',()=>{
 const a=send(initial(),'h1','HUMAN_PRESENT');
 const b=send(a,'u1','SIGNAL_UNKNOWN',10,'NO_SIGNAL');
 assert.equal(b.active_mode,'HUMAN');
 assert.equal(b.current_presenter,'UNKNOWN');
 assert.equal(b.segments[0].stop_detected_at,null);
 const c=send(b,'h2','HUMAN_PRESENT',20);
 assert.equal(c.current_presenter,'HUMAN');
 assert.equal(c.segments[0].continuity_verified,false);
});
test('face consistency or model prediction is not sufficient evidence',()=>{
 const a=send(initial(),'fake','DIGITAL_PRESENT',0,'MODEL_PREDICTION');
 assert.equal(a.current_presenter,'UNKNOWN');
 assert.equal(a.segments.length,0);
 assert.equal(a.review_flags.at(-1).code,'PRESENTER_EVIDENCE_NOT_REVIEWED');
});
test('TCL Douyin digital is policy conflict, not assumed platform impossibility',()=>{
 const a=send(initial('douyin'),'d1','DIGITAL_PRESENT');
 assert.equal(a.current_presenter,'UNKNOWN');
 assert.equal(a.segments.length,0);
 assert.equal(a.review_flags[0].code,'TCL_DOUYIN_DIGITAL_POLICY_REVIEW');
});
test('digital observed stop before next human creates a valid new segment',()=>{
 let s=send(initial(),'d1','DIGITAL_PRESENT');
 s=send(s,'d2','DIGITAL_STOP_OBSERVED',20);
 s=send(s,'h1','HUMAN_PRESENT',30);
 assert.deepEqual(s.segments.map(x=>x.mode),['DIGITAL','HUMAN']);
 assert.equal(s.current_presenter,'HUMAN');
});
test('stop event without matching active segment does not invent a completed session',()=>{
 const s=send(initial(),'e1','HUMAN_STOP_OBSERVED');
 assert.equal(s.segments.length,0);
 assert.equal(s.review_flags[0].code,'PRESENTER_STOP_WITHOUT_ACTIVE_SEGMENT');
});
test('cross-shop and cross-platform observations cannot contaminate state',()=>{
 const s=initial();
 assert.throws(()=>addPresenterObservation(s,obs('e1','HUMAN_PRESENT',0,'REVIEWED_REPLAY','tmall')),/INVALID_PRESENTER_OBSERVATION/);
 assert.throws(()=>addPresenterObservation(s,obs('e2','HUMAN_PRESENT',0,'REVIEWED_REPLAY','jd','shop18')),/INVALID_PRESENTER_OBSERVATION/);
});
test('duplicate latest observation is idempotent, conflicting duplicate fails closed',()=>{
 const s=send(initial(),'h1','HUMAN_PRESENT');
 const same=addPresenterObservation(s,obs('h1','HUMAN_PRESENT'));
 assert.equal(same.duplicate,true);
 assert.equal(same.ledger.segments.length,1);
 assert.throws(()=>addPresenterObservation(s,obs('h1','DIGITAL_PRESENT')),/OBSERVATION_ID_CONFLICT/);
});
test('out-of-order observation fails and original ledger remains unchanged',()=>{
 const s=send(initial(),'h1','HUMAN_PRESENT',10);
 assert.throws(()=>addPresenterObservation(s,obs('h2','HUMAN_STOP_OBSERVED',5)),/OUT_OF_ORDER/);
 assert.equal(s.current_presenter,'HUMAN');
});
test('unknown live room signal cannot create presenter-type conclusion',()=>{
 const s=send(initial(),'u1','SIGNAL_UNKNOWN');
 const p=presenterSnapshot(s);
 assert.equal(p.current_presenter,'UNKNOWN');
 assert.equal(p.segments.length,0);
 assert.equal(p.live_status,'UNKNOWN');
});
