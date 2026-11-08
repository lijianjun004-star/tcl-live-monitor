import test from 'node:test';
import assert from 'node:assert/strict';
import {candidateFromLiveDetail,reduceAccountSessions} from '../probes/lib/r17-session-follow.mjs';

const A='2050532947', NAME='TCL集团官方旗舰店';
const t=(h)=>'2026-11-08T'+String(h).padStart(2,'0')+':00:00.000Z';
function payload({id='102030405060',room='130742',account=A,name=NAME,state='LIVE',ret=['SUCCESS::OK']}={}){
 return {ret,data:{
  accountId:account,roomNum:room,
  roomStatus:state==='LIVE'?1:state==='OFFLINE'?0:2,
  streamStatus:state==='LIVE'?1:0,
  liveId:state==='LIVE'?id:'0',
  broadCaster:{accountId:account,accountName:name,roomNum:room}
 }};
}
const cand=(o,at=t(8))=>candidateFromLiveDetail(payload(o),{checkedAt:at});
const confirmed=(o,at=t(8))=>({...cand(o,at),sourceAttested:true,
 sourceKind:'APPROVED_PAGE_PASSIVE_RESPONSE_TEST_FIXTURE'});
const compile=(rows,at=t(13))=>reduceAccountSessions(rows,{asOf:at});
test('LIVE sample is only a candidate, never source attested by pure classifier',()=>{
 const s=cand({});
 assert.equal(s.state,'LIVE');assert.equal(s.liveId,'102030405060');
 assert.equal(s.sourceAttested,false);
 assert.equal(compile([s]).currentState,'UNKNOWN');
});
test('fixed account and historical room are separate identities',()=>{
 const s=cand({room:'919191',id:'102030405061'});
 assert.equal(s.state,'LIVE');assert.equal(s.accountId,A);
 assert.equal(s.roomNumber,'919191');
});
test('two liveIds under same account, same room create two sessions',()=>{
 const r=compile([confirmed({id:'102030405060'},t(8)),confirmed({id:'102030405061'},t(9))],t(9));
 assert.equal(r.sessions.length,2);
 assert.equal(r.sessions[0].status,'REPLACED_BY_NEW_LIVE_ID');
 assert.equal(r.sessions[1].status,'OPEN');
 assert.deepEqual(r.sessions.map(s=>s.liveId),['102030405060','102030405061']);
 assert.equal(r.sessions[0].endWindow.exactEndUnknown,true);
});
test('same liveId and changed room is one session',()=>{
 const r=compile([confirmed({room:'130742'},t(8)),confirmed({room:'757575'},t(9))],t(9));
 assert.equal(r.sessions.length,1);
 assert.deepEqual(r.sessions[0].roomNumbers,['130742','757575']);
 assert.equal(r.sessions[0].observedAdjacentLiveSpanMinutes,60);
});
test('different liveId and changed room is a new session',()=>{
 const r=compile([confirmed({room:'130742'},t(8)),
   confirmed({room:'777777',id:'102030405061'},t(9))],t(9));
 assert.equal(r.sessions.length,2);
 assert.deepEqual(r.sessions[1].roomNumbers,['777777']);
});
test('different account cannot be reported live',()=>{
 assert.equal(cand({account:'123456789'}).state,'UNKNOWN');
 const bad={...confirmed({}),accountId:'123456789'};
 assert.equal(compile([bad],t(8)).currentState,'UNKNOWN');
});
test('conflicting broadcaster identity cannot be reported live',()=>{
 const s=cand({name:'其他旗舰店'});
 assert.equal(s.state,'UNKNOWN');
});
test('missing liveId cannot prove new session',()=>{
 assert.equal(cand({id:'0'}).state,'UNKNOWN');
 const r=compile([confirmed({},t(8)),cand({id:'0'},t(9))],t(9));
 assert.equal(r.sessions.length,1);
 assert.equal(r.currentState,'UNKNOWN');
});
test('OFFLINE requires account verified and consecutive observations',()=>{
 const r=compile([
  confirmed({},t(8)),
  confirmed({state:'OFFLINE'},t(9)),
  confirmed({state:'OFFLINE'},t(10))
 ],t(10));
 assert.equal(r.sessions.length,1);
 assert.equal(r.sessions[0].status,'CLOSED_AFTER_TWO_OFFLINE');
 assert.equal(r.sessions[0].firstOfflineSeenAt,t(9));
 assert.equal(r.sessions[0].confirmedOfflineAt,t(10));
 assert.equal(r.sessions[0].endWindow.exactEndUnknown,true);
});
test('UNKNOWN between two OFFLINE cannot silently close a session',()=>{
 const r=compile([
  confirmed({},t(8)),
  confirmed({state:'OFFLINE'},t(9)),
  {at:t(10),state:'UNKNOWN',reason:'PLATFORM_THROTTLED'},
  confirmed({state:'OFFLINE'},t(11))
 ],t(11));
 assert.equal(r.sessions.length,1);
 assert.equal(r.sessions[0].status,'PENDING_OFFLINE_CONFIRMATION');
});
test('new liveId after UNKNOWN closes prior with uncertain end window',()=>{
 const r=compile([
  confirmed({},t(8)),
  {at:t(9),state:'UNKNOWN',reason:'CAPTCHA_OR_LOGIN_REQUIRED'},
  confirmed({id:'102030405061'},t(10))
 ],t(10));
 assert.equal(r.sessions.length,2);
 assert.equal(r.sessions[0].status,'REPLACED_BY_NEW_LIVE_ID');
 assert.equal(r.sessions[0].endWindow.noLaterThanNewLiveObservedAt,t(10));
 assert.equal(r.sessions[0].observedAdjacentLiveSpanMinutes,0);
});
test('stale last sample cannot claim current live',()=>{
 const r=compile([confirmed({},t(8))],t(13));
 assert.equal(r.currentState,'UNKNOWN');
 assert.equal(r.currentStateReason,'LAST_EVIDENCE_STALE');
});
test('offline without matching data account ID is not accepted',()=>{
 const p=payload({state:'OFFLINE'});
 delete p.data.accountId;
 const r=candidateFromLiveDetail(p,{checkedAt:t(8)});
 assert.equal(r.state,'UNKNOWN');
});
test('request error is UNKNOWN, not OFFLINE',()=>{
 const r=candidateFromLiveDetail(payload({ret:['RGV587_ERROR::frequent']}),{checkedAt:t(8)});
 assert.equal(r.state,'UNKNOWN');
});
test('broad page text is not a valid live-detail payload',()=>{
 const r=candidateFromLiveDetail({text:'正在直播中'},{checkedAt:t(8)});
 assert.equal(r.state,'UNKNOWN');
});
test('conflicting simultaneous samples are rejected',()=>{
 const a=confirmed({},t(8)),b=confirmed({id:'102030405061'},t(8));
 assert.throws(()=>compile([a,b],t(8)),/CONFLICTING/);
});
test('identical replay sample deduplicated',()=>{
 const a=confirmed({},t(8)),r=compile([a,a],t(8));
 assert.equal(r.counts.LIVE,1);assert.equal(r.sessions.length,1);
});
test('future observations are excluded',()=>{
 const r=compile([confirmed({},t(10))],t(9));
 assert.equal(r.sessions.length,0);assert.equal(r.ignored.length,1);
});
test('manual and hourly cadence is 60 minutes, no auto schedule',()=>{
 const r=compile([]);
 assert.equal(r.intervalMinutes,60);
 assert.equal(r.sourceConnectedByThisModule,false);
 assert.equal(r.scoreEligible,false);
});
