import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
 validateJdCrosswalk,validateJdSchedule,validateJdObservations,
 evaluateJdOpening,OPENING_GRACE_MS
} from '../probes/r20/jd-opening-rate.mjs';

const inbox=JSON.parse(fs.readFileSync(new URL('../config/r20-jd-schedule-inbox.json',import.meta.url),'utf8'));
const pending=JSON.parse(fs.readFileSync(new URL('../config/r20-jd-crosswalk-review.json',import.meta.url),'utf8'));
const NOW='2026-11-10T12:00:00Z';
const crosswalk=()=>({
 schema_version:20,entries:[
  {ops_room_id:'17',ops_shop_id:'18',public_jd_account_id:'900123',identity_status:'VERIFIED',evidence_ref:'https://example.org/read-only/confirmed-jd-17'},
  {ops_room_id:'18',ops_shop_id:'19',public_jd_account_id:'900124',identity_status:'VERIFIED',evidence_ref:'https://example.org/read-only/confirmed-jd-18'}
 ]
});
const bjt=(hh,mm='00',day='10')=>'2026-11-'+day+'T'+hh+':'+mm+':00+08:00';
const shift=(key,room,hour='18',opts={})=>({
 shift_id:key,platform:'jd',ops_room_id:room,starts_at:bjt(hour),ends_at:bjt(String(Number(hour)+4).padStart(2,'0')),
 revision_at:bjt('10'),schedule_verified:true,schedule_evidence_ref:'fixture-only-authorized-roster',...opts
});
const obs=(room,at,opts={})=>({
 platform:'jd',ops_room_id:room,ops_shop_id:room==='17'?'18':'19',
 state:'LIVE',source:'TCL_OPS_READ_ONLY',source_ref:'fixture-history-verified',
 identity_attested:true,state_attested:true,observed_at:at,...opts
});
const plan=(shifts)=>({schema_version:20,timezone:'Asia/Shanghai',shifts});
const run=(shifts,observations,cv=crosswalk(),as_of=NOW)=>evaluateJdOpening({
 schedule:plan(shifts),crosswalk:cv,observations,as_of
});
test('crosswalk validation: real repo six rooms are pending, not public JD account IDs',()=>{
 const info=validateJdCrosswalk(pending);
 assert.equal(info.mapped_ops_rooms,6);
 assert.equal(info.verified_accounts,0);
 assert.equal(info.pending,6);
 assert.ok(pending.entries.every(x=>x.public_jd_account_id===null));
});
test('schedule inbox has zero verified shifts; does not accidentally create denominator',()=>{
 assert.equal(validateJdSchedule(inbox).total,0);
 const r=evaluateJdOpening({schedule:inbox,crosswalk:pending,observations:[],as_of:NOW});
 assert.equal(r.due_shifts,0);
 assert.equal(r.opening_rate_percent,null);
 assert.equal(r.opening_rate_status,'NO_DUE_SCHEDULE');
});
test('five-minute grace window exact',()=>assert.equal(OPENING_GRACE_MS,300000));
test('one LIVE positive at +2m is within grace and counts only observed evidence',()=>{
 const s=shift('s1','17');
 const r=run([s],[obs('17','2026-11-10T10:02:00Z')]);
 assert.equal(r.due_shifts,1);
 assert.equal(r.confirmed_within_grace,1);
 assert.equal(r.opening_rate_percent,100);
 assert.equal(r.on_time_rate_percent,100);
 assert.equal(r.actual_open_start_times_known,false);
});
test('LIVE at +20m proves it opened, but not a late start',()=>{
 const r=run([shift('s1','17')],[obs('17','2026-11-10T10:20:00Z')]);
 assert.equal(r.opening_rate_percent,100);
 assert.equal(r.confirmed_within_grace,0);
 assert.equal(r.on_time_rate_percent,null);
 assert.equal(r.results[0].status,'OPEN_CONFIRMED_TIME_UNKNOWN');
});
test('two due shifts; one LIVE one UNKNOWN -> rate must stay NULL not 50%',()=>{
 const r=run([shift('s1','17'),shift('s2','18')],[obs('17','2026-11-10T10:02:00Z')]);
 assert.equal(r.observed_opened_shifts,1);
 assert.equal(r.unknown_or_blocked_shifts,1);
 assert.equal(r.opening_rate_percent,null);
 assert.equal(r.on_time_rate_percent,null);
});
test('missing public JD account mapping is BLOCKED_IDENTITY not a missed opening',()=>{
 const r=run([shift('s1','17')],[obs('17','2026-11-10T10:02:00Z')],pending);
 assert.equal(r.results[0].status,'BLOCKED_IDENTITY');
 assert.equal(r.opening_rate_percent,null);
});
test('unverified shift schedule is BLOCKED_SCHEDULE even with LIVE source',()=>{
 const r=run([shift('s1','17','18',{schedule_verified:false,schedule_evidence_ref:null})],
  [obs('17','2026-11-10T10:02:00Z')]);
 assert.equal(r.results[0].status,'BLOCKED_SCHEDULE');
 assert.equal(r.opening_rate_percent,null);
});
test('future shifts excluded from due denominator',()=>{
 const r=run([shift('s1','17'),shift('s2','18','23',{ends_at:bjt('02','00','11')})],
  [obs('17','2026-11-10T10:02:00Z')]);
 assert.equal(r.due_shifts,1);
 assert.equal(r.scheduled_shifts_total,2);
});
test('cross-midnight Beijing shift accepted without UTC date confusion',()=>{
 const s=shift('night','17','23',{ends_at:bjt('02','00','11')});
 assert.equal(validateJdSchedule(plan([s])).total,1);
 const r=run([s],[obs('17','2026-11-10T15:02:00Z')],'ignored'===null?null:crosswalk(),'2026-11-11T01:00:00Z');
 assert.equal(r.opening_rate_percent,100);
 assert.equal(r.confirmed_within_grace,1);
});
test('observation before shift does not prove current scheduled opening',()=>{
 const r=run([shift('s1','17')],[obs('17','2026-11-10T09:59:00Z')]);
 assert.equal(r.results[0].status,'UNKNOWN');
 assert.equal(r.opening_rate_percent,null);
});
test('observation after shift end does not count',()=>{
 const r=run([shift('s1','17')],[obs('17','2026-11-10T14:05:00Z')],crosswalk(),'2026-11-10T15:00:00Z');
 assert.equal(r.results[0].status,'UNKNOWN');
});
test('OFFLINE from capture system does not prove never opened',()=>{
 const r=run([shift('s1','17')],[obs('17','2026-11-10T10:02:00Z',{state:'OFFLINE'})]);
 assert.equal(r.results[0].status,'UNKNOWN');
 assert.equal(r.opening_rate_percent,null);
 assert.equal(r.offline_detection_validated,false);
});
test('shop mismatch cannot join another internal room',()=>{
 const r=run([shift('s1','17')],[obs('17','2026-11-10T10:02:00Z',{ops_shop_id:'19'})]);
 assert.equal(r.opening_rate_percent,null);
});
test('unattested LIVE cannot be promoted to opening',()=>{
 const r=run([shift('s1','17')],[obs('17','2026-11-10T10:02:00Z',{state_attested:false})]);
 assert.equal(r.opening_rate_percent,null);
});
test('wrong source fixture cannot masquerade as real TCL ops evidence',()=>{
 const r=run([shift('s1','17')],[obs('17','2026-11-10T10:02:00Z',{source:'OFFLINE_FIXTURE'})]);
 assert.equal(r.opening_rate_percent,null);
});
test('two public identities claiming same public JD account are rejected',()=>{
 const cv=crosswalk();cv.entries[1].public_jd_account_id='900123';
 assert.throws(()=>validateJdCrosswalk(cv),/PUBLIC_ACCOUNT_AMBIGUOUS/);
});
test('pending account with fake public ID fails crosswalk',()=>{
 const cv=structuredClone(pending);cv.entries[0].public_jd_account_id='99999';
 assert.throws(()=>validateJdCrosswalk(cv),/UNVERIFIED_PUBLIC_ACCOUNT_MUST_BE_NULL/);
});
test('unauthorized retroactive shift change is rejected',()=>{
 assert.throws(()=>validateJdSchedule(plan([
  shift('s1','17','18',{revision_at:bjt('19')})
 ])),/RETROACTIVE_SHIFT_EDIT_NOT_ACCEPTED/);
});
test('duplicate shift IDs, duplicate room IDs and duplicate live source observations rejected',()=>{
 assert.throws(()=>validateJdSchedule(plan([shift('s1','17'),shift('s1','18')])),/INVALID_OR_DUPLICATE_SHIFT/);
 const cv=crosswalk();cv.entries[1].ops_room_id='17';
 assert.throws(()=>validateJdCrosswalk(cv),/DUPLICATE_OR_INVALID_OPS_ROOM/);
 assert.throws(()=>validateJdObservations([obs('17','2026-11-10T10:02:00Z'),obs('17','2026-11-10T10:02:00Z')]),/DUPLICATE_OBSERVATION/);
});
test('shift dates must be explicit Beijing offset; checks are UTC timestamps',()=>{
 assert.throws(()=>validateJdSchedule(plan([shift('s1','17','18',{starts_at:'2026-11-10T18:00:00Z'})])),/TIME_MUST_BE_BEIJING_OFFSET/);
 assert.throws(()=>validateJdObservations([obs('17','2026-11-10T18:00:00+08:00')]),/TIME_MUST_BE_ISO_UTC/);
});
test('invalid calendar date and excessive duration rejected',()=>{
 assert.throws(()=>validateJdSchedule(plan([shift('s1','17','18',{starts_at:'2026-11-31T18:00:00+08:00'})])),/NONEXISTENT_DATE_TIME/);
 assert.throws(()=>validateJdSchedule(plan([shift('s1','17','18',{ends_at:'2026-11-12T18:00:00+08:00'})])),/INVALID_SHIFT_DURATION/);
});
test('we never provide non-100 opening rate with unresolved shifts',()=>{
 const r=run([shift('s1','17'),shift('s2','18')],[
  obs('17','2026-11-10T10:01:00Z'),
  obs('18','2026-11-10T10:40:00Z')
 ]);
 assert.equal(r.opening_rate_percent,100);
 assert.equal(r.on_time_rate_percent,null);
 assert.equal(r.confirmed_within_grace,1);
});
