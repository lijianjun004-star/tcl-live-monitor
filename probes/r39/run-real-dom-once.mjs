/** R3.9 one-shot, two approved Douyin public accounts only; no login, no cron. */
import fs from 'node:fs/promises';
import {runDouyinRpaReadOnly} from '../r37/rpa-safe-douyin.mjs';

if(process.env.R39_SINGLE_SHOT!=='SAFE_DOM_DIAGNOSTIC_TWO_PUBLIC_ACCOUNTS')
  throw Error('R39_SINGLE_SHOT_NOT_AUTHORIZED_IN_WORKFLOW');
const keys=['tcl-douyin-flagship','tcl-douyin-tv-official-live'];
const config=JSON.parse(await fs.readFile('config/probe-targets.json','utf8'));
const report=await runDouyinRpaReadOnly({config,keys,holdMs:1000});
const whitelist=['totalAnchors','liveHostAnchorCount','liveLabeledAnchorCount',
'visibleLiveTextMentions','liveRelatedButtons','domTextLength','validNormalizedAnchors','delayedDomResample'];
const minimal=report.observations.map(o=>({
  accountKey:o.accountKey, checkedAt:o.checkedAt,
  state:o.state==='LIVE'?'LIVE':'UNKNOWN',reason:o.reason,
  profileHttp:o.profileHttp??null,roomHttp:o.roomHttp??null,
  profileIdentityVerified:o.profileIdentityVerified===true,
  roomIdentityVerified:o.roomIdentityVerified===true,
  observedRoomId:o.observedRoomId??null,
  profileDomGap:typeof o.profileDomGap==='string'?o.profileDomGap:null,
  profileDomDiagnostics:o.profileDomDiagnostics ? Object.fromEntries(whitelist.map(k=>[k,o.profileDomDiagnostics?.[k]??null])) : null,
  opsBridgeVerified:false,exactStartAt:null,exactEndAt:null,
}));
const result={schemaVersion:39,mode:'REAL_PUBLIC_GUEST_DOM_DIAGNOSTIC_ONESHOT',
  checkedAt:new Date().toISOString(),sourceAccess:report.sourceAccess,
  expectedAccounts:keys.length,observations:minimal,stoppedForChallenge:report.stoppedForChallenge===true,
  actualBroadcastStatusAccuracy:null,validatedOfflineCount:0,opsBridgeVerifiedCount:0,
  formalOpeningRatePercent:null,formalFullDurationRatePercent:null,
  exactStartTimesKnown:0,exactEndTimesKnown:0};
await fs.mkdir('out/r39',{recursive:true});
await fs.writeFile('out/r39/public-dom-diagnostic-summary.json',JSON.stringify(result,null,2)+'\n');
console.log('R39_SAFE_DOM_SUMMARY '+JSON.stringify(result));
if(report.sourceAccess==='BROWSER_UNAVAILABLE'||!minimal.length){
  console.error('R39_BROWSER_UNAVAILABLE_OR_EMPTY');process.exitCode=2;
}