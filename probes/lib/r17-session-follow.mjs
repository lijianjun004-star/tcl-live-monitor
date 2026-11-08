/**
 * R1.7 account-following single-store session tracker. Pure data functions only.
 * No HTTP, no login, no captcha bypass, no scheduled jobs.
 * Public page access and source attestation belong to a separately reviewed adapter.
 * A different liveId under the SAME verified account is a new session even when
 * roomNum is unchanged; changed roomNum alone never proves a new session.
 */
import {classifyTmall} from './tmall.mjs';
import {FIRST_TARGET} from './r12-tmall-first.mjs';

const MINUTE=60000;
const FRESHNESS_MS=90*MINUTE, OFFLINE_CONFIRM_MS=65*MINUTE, ADJACENT_MS=65*MINUTE;
const LIVE_ID=/^[1-9][0-9]{4,23}$/;
const ROOM_ID=/^[0-9]{3,15}$/;
const ISO=x=>new Date(x).toISOString();
function when(x){
 if(typeof x!=='string'||x.trim()===''||!Number.isFinite(Date.parse(x)))throw Error('INVALID_OBSERVATION_TIME');
 return Date.parse(x);
}
const UNKNOWN=(reason,at)=>({
 at:ISO(when(at)),platform:'tmall',accountId:FIRST_TARGET.accountId,
 state:'UNKNOWN',reason,liveId:null,roomNumber:null,
 accountVerified:false,roomVerified:false,sourceAttested:false
});
/**
 * Validate the ordinary live-detail response captured PASSIVELY while
 * visiting https://h5.m.taobao.com/taolive/video.html?userId=2050532947.
 *
 * This returns a CANDIDATE, not a verified network observation. Its caller
 * must independently attest page URL, response URL, transport and permissions
 * before accepting it as real evidence. No caller in R1.7 does that yet.
 */
export function candidateFromLiveDetail(payload,{checkedAt}={}){
 const at=ISO(when(checkedAt));
 const target={accountId:FIRST_TARGET.accountId,displayName:FIRST_TARGET.name};
 // Intentionally no target.roomNumber: 130742 is HISTORICAL, not a fixed session.
 const d=classifyTmall(payload,target);
 if(d.state==='UNKNOWN')return {...UNKNOWN(d.reason||'UNRECOGNIZED_PAGE_RESPONSE',at),
   apiReason:d.reason||null};
 const id=String(payload?.data?.accountId??'');
 const room=String(d.observed?.roomNumber??'');
 const liveId=d.state==='LIVE'?String(d.liveId??''):null;
 if(id!==FIRST_TARGET.accountId||!ROOM_ID.test(room))
   return UNKNOWN('ACCOUNT_OR_ROOM_NOT_CROSS_VERIFIED',at);
 if(d.state==='LIVE'&&!LIVE_ID.test(liveId))
   return UNKNOWN('MISSING_VALID_LIVE_ID',at);
 return {
  at,platform:'tmall',accountId:FIRST_TARGET.accountId,
  accountName:FIRST_TARGET.name,roomNumber:room,
  state:d.state,reason:d.state==='LIVE'?'ACCOUNT_AND_LIVE_ID_CROSS_VERIFIED':'ACCOUNT_OFFLINE_CROSS_VERIFIED',
  liveId,accountVerified:true,roomVerified:true,
  sourceAttested:false, // The pure classifier cannot verify transport provenance.
  sourceKind:'UNATTESTED_PAGE_PAYLOAD',
 };
}
function validSample(s){
 const evidence=!!s&&s.accountId===FIRST_TARGET.accountId&&s.accountVerified===true&&
  s.roomVerified===true&&s.sourceAttested===true&&ROOM_ID.test(String(s.roomNumber||''))&&
  ['LIVE','OFFLINE'].includes(s.state)&&
  (s.state==='OFFLINE'||LIVE_ID.test(String(s.liveId||'')));
 return evidence;
}
function newSession(s,sequence){
 return {sequence,liveId:String(s.liveId),status:'OPEN',
  firstLiveSeenAt:s.at,lastLiveSeenAt:s.at,
  firstOfflineSeenAt:null,confirmedOfflineAt:null,
  observedAdjacentLiveSpanMinutes:0,observedLivePoints:1,unknownPoints:0,
  offlineCandidatesDiscarded:0,roomNumbers:[String(s.roomNumber)],
  closingEvidence:null,endWindow:null,_offline:null};
}
function publicSession(s){
 const { _offline, ...publicValues }=s; return publicValues;
}
/**
 * Account-following state machine. Input rows are from an independently
 * approved and source-attested reader; synthetic tests set sourceAttested=true
 * but must NEVER be represented as real platform captures.
 */
export function reduceAccountSessions(raw,{asOf=new Date().toISOString()}={}){
 const asOfMs=when(asOf);
 if(!Array.isArray(raw))throw TypeError('OBSERVATIONS_MUST_BE_ARRAY');
 const dedup=new Map(),ignored=[];
 for(const item of raw){
  if(!item||typeof item!=='object'||typeof item.at!=='string'){ignored.push({reason:'INVALID_ROW'});continue;}
  let ms;try{ms=when(item.at);}catch{ignored.push({reason:'BAD_TIMESTAMP'});continue;}
  if(ms>asOfMs){ignored.push({reason:'FUTURE_OBSERVATION'});continue;}
  const key=ISO(ms),normalized={...item,at:key};
  if(dedup.has(key)){
   if(JSON.stringify(dedup.get(key))!==JSON.stringify(normalized))throw Error('CONFLICTING_SAMPLES_AT_SAME_TIME');
   continue;
  }
  dedup.set(key,normalized);
 }
 const observations=[...dedup.values()].sort((a,b)=>when(a.at)-when(b.at)).map(item=>{
  const good=validSample(item);
  return {
   at:item.at, state:good?item.state:'UNKNOWN',
   reason:good?item.reason||null:item.state==='UNKNOWN'?item.reason||'SOURCE_UNKNOWN':'UNATTESTED_OR_IDENTITY_CONFLICT',
   liveId:good&&item.state==='LIVE'?String(item.liveId):null,
   roomNumber:good?String(item.roomNumber):null,
   countedAsEvidence:good
  };
 });
 const sessions=[];let active=null,last=null,seq=1;
 for(const o of observations){
  if(o.state==='LIVE'){
   if(!active)active=newSession(o,seq++);
   else if(o.liveId!==active.liveId){
    // Old session is superseded; its precise end was NOT observed.
    active.status='REPLACED_BY_NEW_LIVE_ID';
    active.closingEvidence='DIFFERENT_LIVE_ID_UNDER_SAME_ACCOUNT';
    active.endWindow={
      afterLastOldLiveObservedAt:active.lastLiveSeenAt,
      noLaterThanNewLiveObservedAt:o.at,
      exactEndUnknown:true
    };
    sessions.push(publicSession(active));
    active=newSession(o,seq++);
   }else{
    if(active._offline){
     active._offline=null;active.offlineCandidatesDiscarded++;
    }else if(last?.state==='LIVE'&&last.liveId===o.liveId&&
       when(o.at)-when(last.at)<=ADJACENT_MS){
     active.observedAdjacentLiveSpanMinutes+=Math.round((when(o.at)-when(last.at))/MINUTE*100)/100;
    }
    if(!active.roomNumbers.includes(o.roomNumber))active.roomNumbers.push(o.roomNumber);
    active.lastLiveSeenAt=o.at;active.observedLivePoints++;active.status='OPEN';
   }
  }else if(o.state==='OFFLINE'){
   if(active){
    if(active._offline&&last?.state==='OFFLINE'&&
        when(o.at)-when(last.at)<=OFFLINE_CONFIRM_MS){
     active.status='CLOSED_AFTER_TWO_OFFLINE';
     active.firstOfflineSeenAt=active._offline.at;
     active.confirmedOfflineAt=o.at;
     active.closingEvidence='TWO_VALID_ACCOUNT_OFFLINE_OBSERVATIONS';
     active.endWindow={
      afterLastOldLiveObservedAt:active.lastLiveSeenAt,
      noLaterThanFirstOfflineObservedAt:active._offline.at,
      exactEndUnknown:true
     };
     sessions.push(publicSession(active));active=null;
    }else {
     active._offline={at:o.at};active.status='PENDING_OFFLINE_CONFIRMATION';
    }
   }
  }else if(active){
   active.unknownPoints++;
   if(active._offline){
    active._offline=null;active.offlineCandidatesDiscarded++;active.status='OPEN';
   }
  }
  last=o;
 }
 if(active){
  if(active._offline)active.firstOfflineSeenAt=active._offline.at;
  sessions.push(publicSession(active));
 }
 const recent=last&&asOfMs-when(last.at)<=FRESHNESS_MS;
 const currentState=recent&&last.countedAsEvidence?last.state:'UNKNOWN';
 return {
  schemaVersion:17,storeKey:FIRST_TARGET.accountStableId,accountId:FIRST_TARGET.accountId,
  historicalRoomNumber:FIRST_TARGET.historicalRoomNum,
  monitorBy:'ACCOUNT_ID_NOT_FIXED_ROOM',trackLiveSessionBy:'LIVE_ID',
  asOf:ISO(asOfMs),timezone:'Asia/Shanghai',intervalMinutes:60,
  currentState,currentStateReason:currentState==='UNKNOWN'?
    (recent?last?.reason||'NO_VALID_EVIDENCE':last?'LAST_EVIDENCE_STALE':'NO_OBSERVATIONS'):
    last.reason,
  lastObservedRoomNumber:last?.roomNumber||null,
  lastObservedLiveId:currentState==='LIVE'?last.liveId:null,
  lastObservationAt:last?.at||null,
  observations:observations.map(x=>({...x})),
  counts:Object.fromEntries(['LIVE','OFFLINE','UNKNOWN'].map(k=>[k,observations.filter(x=>x.state===k).length])),
  sessions,ignored,sourceConnectedByThisModule:false,
  confirmedActualStartStopTimes:false,scoreEligible:false,
  note:'Offline session logic only. Distinct liveId means new session; observation boundaries are not actual start/end times. No approved real-time source is connected.'
 };
}
