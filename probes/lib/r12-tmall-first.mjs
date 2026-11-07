/** R1.2 one-account historical evidence gate: no network, no cookies, no scoring. */
export const FIRST_TARGET = Object.freeze({
 key:'tcl-group',platform:'tmall',accountId:'2050532947',
 accountStableId:'tmall:accountId:2050532947',
 historicalRoomNum:'130742',name:'TCL集团官方旗舰店',
 sourceURL:'https://h5.m.taobao.com/taolive/video.html?userId=2050532947'
});
const str=x=>x==null?'':String(x).trim();
const unknown=(reason,sample)=>({state:'UNKNOWN',reason,at:sample?.at||null,accountMatches:false,roomMatches:false,scoreEligible:false});
export function classifyObservation(sample,target=FIRST_TARGET){
 if(!sample||typeof sample!=='object')return unknown('MISSING_EVIDENCE');
 if(str(sample.key)!==target.key)return unknown('SOURCE_KEY_MISMATCH',sample);
 if(str(sample.accountId)!==target.accountId)return unknown('ACCOUNT_ID_CONFLICT',sample);
 if(!Number.isFinite(Date.parse(str(sample.at))))return unknown('MISSING_OR_BAD_OBSERVED_TIME',sample);
 // The real RGV587 logs have null roomNumber/name/status: classify throttle before room identity.
 const codes=Array.isArray(sample.codes)?sample.codes.map(str):[];
 if(str(sample.mtop)==='THROTTLED_OR_VALIDATION'||codes.includes('RGV587_ERROR'))
  return unknown('PLATFORM_THROTTLED',sample);
 const room=str(sample.roomNumber);
 if(room!==target.historicalRoomNum)return {...unknown(room?'ROOM_ID_CONFLICT':'ROOM_ID_MISSING',sample),accountMatches:true};
 const name=str(sample.observedName);
 if(name&&name!==target.name)return {...unknown('OBSERVED_NAME_CONFLICT',sample),accountMatches:true,roomMatches:true};
 if(!codes.includes('SUCCESS')||!['SUCCESS','SUCCESS_AFTER_TOKEN_REFRESH'].includes(str(sample.mtop)))
  return {...unknown(codes.includes('RGV587_ERROR')?'PLATFORM_THROTTLED':'API_NOT_SUCCESSFUL',sample),accountMatches:true,roomMatches:true};
 let state='UNKNOWN',reason='AMBIGUOUS_OR_MISSING_STATUS';
 if(sample.roomStatus===1&&sample.streamStatus===1){state='LIVE';reason='CONSISTENT_LIVE_INDICATORS';}
 if(sample.roomStatus===0&&sample.streamStatus===0){state='OFFLINE';reason='CONSISTENT_OFFLINE_INDICATORS';}
 if(state!=='UNKNOWN'&&sample.state&&sample.state!==state){state='UNKNOWN';reason='SOURCE_STATE_CONFLICT';}
 return {state,reason,at:sample.at,accountMatches:true,roomMatches:true,scoreEligible:false};
}
export function currentView(classified,nowIso,maxAgeMinutes=15){
 const now=Date.parse(nowIso);
 if(!Number.isFinite(now))throw new Error('Invalid nowIso');
 if(!Number.isSafeInteger(maxAgeMinutes)||maxAgeMinutes<0||maxAgeMinutes>120)throw new Error('Invalid maxAgeMinutes');
 if(!classified||!classified.at||!['LIVE','OFFLINE'].includes(classified.state))
   return {state:'UNKNOWN',reason:classified?.reason||'NO_CURRENT_OBSERVATION',scoreEligible:false};
 if(classified.accountMatches!==true||classified.roomMatches!==true||!
   ['CONSISTENT_LIVE_INDICATORS','CONSISTENT_OFFLINE_INDICATORS'].includes(classified.reason))
   return {state:'UNKNOWN',reason:'UNVERIFIED_ROOM_EVIDENCE',scoreEligible:false};
 const at=Date.parse(classified.at),ageMs=now-at;
 if(!Number.isFinite(at)||ageMs<0||ageMs>maxAgeMinutes*60000)
   return {state:'UNKNOWN',reason:'EVIDENCE_STALE_OR_CLOCK_INVALID',scoreEligible:false};
 return {state:classified.state,reason:classified.reason,scoreEligible:false};
}
export function summarizeHistoricalRuns(raw,target=FIRST_TARGET){
 const results=[],fingerprints=new Set(); let fullyCrossChecked=0;
 for(const run of raw.runs||[]){
  const samples=[];
  for(const s of run.samples||[]){
   const fingerprint=[run.id,s.arm||run.arm||'none',s.round].join('/');
   if(fingerprints.has(fingerprint))throw new Error('Repeated run/arm/round evidence');
   fingerprints.add(fingerprint);
   if(s.kind==='summary-only')samples.push({state:['LIVE','OFFLINE'].includes(s.state)?s.state:'UNKNOWN',reason:'AGGREGATE_ONLY_NOT_ROW_LEVEL',at:null,scoreEligible:false});
   else {
    const classified=classifyObservation(s,target);
    if(classified.accountMatches&&classified.roomMatches&&['LIVE','OFFLINE'].includes(classified.state)) fullyCrossChecked++;
    samples.push(classified);
   }
  }
  results.push({id:run.id,arm:run.arm||null,samples,
   totals:Object.fromEntries(['LIVE','OFFLINE','UNKNOWN'].map(k=>[k,samples.filter(s=>s.state===k).length]))});
 }
 return {key:target.key,accountId:target.accountId,historicalRoomNum:target.historicalRoomNum,
   identityGate:fullyCrossChecked>0?'HISTORICAL_CROSS_VERIFIED':'NOT_VERIFIED',
   historicallyCrossCheckedSamples:fullyCrossChecked,currentState:'UNKNOWN',
   storeIdentityFromPrimarySite:'NOT_VERIFIED_THIS_TURN',
   businessOwnershipVerified:false,reliableMonitoringPassed:false,scoringEligible:false,runs:results};
}
