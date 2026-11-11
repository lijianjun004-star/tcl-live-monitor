/** R3.9 one-shot, two approved Douyin public accounts only; no login, no cron. */
import fs from 'node:fs/promises';
import {runDouyinRpaReadOnly} from '../r37/rpa-safe-douyin.mjs';

if(process.env.R310_SINGLE_SHOT!=='SAFE_ROOM_PARITY_SYSTEM_CHROME')
  throw Error('R39_SINGLE_SHOT_NOT_AUTHORIZED_IN_WORKFLOW');
const keys=['tcl-douyin-flagship','tcl-douyin-tv-official-live'];
const config=JSON.parse(await fs.readFile('config/probe-targets.json','utf8'));
const {chromium}=await import('playwright');
const report=await runDouyinRpaReadOnly({config,keys,holdMs:1000,
  browserFactory:()=>chromium.launch({channel:'chrome',headless:true})});
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
  roomDiagnosticGap:typeof o.roomDiagnosticGap==='string'?o.roomDiagnosticGap:null,
  roomDiagnostics:o.roomDiagnostics ? Object.fromEntries([
    'roomHttp200','roomPageHostVerified','expectedExactTitle','expectedNormalizedTitle',
    'titleContainsExpectedName','titleHasLiveRoomLabel','descExpectedPrefix',
    'descContainsExpectedName','descriptionPresent','roomBodyContainsDisplayId',
    'pageTitleLength','descriptionLength','roomTextExcerptLength'
  ].map(k=>[k,o.roomDiagnostics?.[k]??null])) : null,
}));
const result={schemaVersion:39,mode:'REAL_PUBLIC_ROOM_PARITY_SYSTEM_CHROME_ONESHOT',
  checkedAt:new Date().toISOString(),sourceAccess:report.sourceAccess,
  expectedAccounts:keys.length,observations:minimal,stoppedForChallenge:report.stoppedForChallenge===true,
  actualBroadcastStatusAccuracy:null,validatedOfflineCount:0,opsBridgeVerifiedCount:0,
  formalOpeningRatePercent:null,formalFullDurationRatePercent:null,
  exactStartTimesKnown:0,exactEndTimesKnown:0};
await fs.mkdir('out/r310',{recursive:true});
await fs.writeFile('out/r310/public-room-parity-safe.json',JSON.stringify(result,null,2)+'\n');
console.log('R310_SAFE_ROOM_PARITY '+JSON.stringify(result));
if(report.sourceAccess==='BROWSER_UNAVAILABLE'||!minimal.length){
  console.error('R39_BROWSER_UNAVAILABLE_OR_EMPTY');process.exitCode=2;
}