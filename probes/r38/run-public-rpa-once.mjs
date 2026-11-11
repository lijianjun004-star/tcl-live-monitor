/** R3.8 - One controlled public guest RPA sample, no login or bypass. */
import fs from 'node:fs/promises';
import {runDouyinRpaReadOnly} from '../r37/rpa-safe-douyin.mjs';

if(process.env.R38_SINGLE_SHOT!=='TWO_APPROVED_PUBLIC_ACCOUNTS'){
  throw Error('R38_ONE_SHOT_GUARD_MISSING');
}
const keys=['tcl-douyin-flagship','tcl-douyin-tv-official-live'];
const config=JSON.parse(await fs.readFile('config/probe-targets.json','utf8'));
const result=await runDouyinRpaReadOnly({config,keys,holdMs:1000});
const safe={
  schemaVersion:38,
  source:'REAL_GITHUB_RUNNER_PUBLIC_GUEST_RPA',
  mode:'ONESHOT_NO_AUTH_NO_CRON',
  executedAt:new Date().toISOString(),
  expectedAccounts:keys.length,
  attemptedAccounts:result.observations.length,
  sourceAccess:result.sourceAccess,
  stoppedForChallenge:result.stoppedForChallenge===true,
  publicIdentityDoubleVerifiedCount:result.observations.filter(o=>o.state==='LIVE'&&o.profileIdentityVerified&&o.roomIdentityVerified).length,
  opsBridgeVerifiedCount:0,
  formalOpeningRatePercent:null,
  formalFullDurationRatePercent:null,
  exactStartTimesKnown:0,
  exactEndTimesKnown:0,
  observations:result.observations.map(o=>({
    accountKey:o.accountKey,checkedAt:o.checkedAt,state:o.state==='LIVE'?'LIVE':'UNKNOWN',
    reason:o.reason,profileHttp:o.profileHttp??null,roomHttp:o.roomHttp??null,
    profileIdentityVerified:o.profileIdentityVerified===true,
    roomIdentityVerified:o.roomIdentityVerified===true,
    observedRoomId:o.observedRoomId??null,roomIdChanged:o.roomIdChanged===true,
    opsBridgeVerified:false,exactStartAt:null,exactEndAt:null,
  })),
};
await fs.mkdir('out/r38',{recursive:true});
await fs.writeFile('out/r38/real-rpa-safe.json',JSON.stringify(safe,null,2)+'\n');
console.log('R38_REAL_RPA_SAFE_SUMMARY '+JSON.stringify(safe));
if(result.sourceAccess==='BROWSER_UNAVAILABLE'||result.observations.length===0){
  console.error('R38_INFRASTRUCTURE_UNAVAILABLE_NO_PUBLIC_OBSERVATIONS');
  process.exitCode=2;
}
