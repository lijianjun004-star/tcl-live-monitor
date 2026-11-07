/** R1.6 Beijing hourly observation log. Pure data transform: NO network, NO fake LIVE. */
import {emptyLedger, parseLedger} from './r14-tmall-durable.mjs';
import {reduceTmallSingleStore,R13_POLICY} from './r13-tmall-interval-monitor.mjs';

const HOUR=3_600_000;
const BJ='Asia/Shanghai';
export const HOURLY_POLICY=Object.freeze({
  ...R13_POLICY,
  liveIntervalMinutes:60,
  idleDiscoveryMinutes:60,
  confirmationMaxGapMinutes:65,
  contiguousLiveMaxGapMinutes:65,
  freshnessMinutes:90
});
function epoch(value){
 if(typeof value!=='string'||!value.trim()||!Number.isFinite(Date.parse(value)))throw Error('INVALID_TIME');
 return Date.parse(value);
}
const iso = value=>new Date(value).toISOString();
export const beijingTime = value => new Date(epoch(value)).toLocaleString('zh-CN',{timeZone:BJ,hour12:false});
export function planHourly(nowIso){
 const at=epoch(nowIso),slot=Math.floor(at/HOUR)*HOUR;
 return {
   plannedSlotAt:iso(slot),plannedSlotBeijing:beijingTime(iso(slot)),
   actuallyStartedAt:iso(at),actuallyStartedBeijing:beijingTime(iso(at)),
   delayMinutes:Math.round((at-slot)/60000*100)/100,
   exactHourGuaranteed:false
 };
}
/** Store an ATTEMPT only. Without a verified source, state must remain UNKNOWN.
 * This function deliberately cannot accept LIVE/OFFLINE inputs.
 */
export function recordUnverifiedHourlyAttempt(original,{
  atIso,trigger='manual',reason='NO_APPROVED_SOURCE'
}={}){
 const ledger=original==null?emptyLedger():parseLedger(original);
 if(!['manual','scheduled'].includes(trigger))throw Error('INVALID_TRIGGER');
 if(!['NO_APPROVED_SOURCE','CAPTCHA_OR_LOGIN_REQUIRED','PLATFORM_THROTTLED','SITE_ACCESS_BLOCKED',
       'PROBE_NOT_RUN','NETWORK_ERROR','TIMEOUT','SCHEDULER_DELAY'].includes(reason))throw Error('UNSUPPORTED_FAILURE_CODE');
 const t=epoch(atIso),at=iso(t),slot=planHourly(at);
 const last=ledger.attempts.at(-1);
 if(last && t < epoch(last.at))throw Error('NON_MONOTONIC_ATTEMPT');
 if(last && t === epoch(last.at))return {ledger,action:'DUPLICATE_TIME_SKIPPED',slot};
 if(trigger==='scheduled' && ledger.attempts.some(a=>a.trigger==='scheduled'&&a.plannedSlotAt===slot.plannedSlotAt)){
  return {ledger,action:'DUPLICATE_HOUR_SKIPPED',slot};
 }
 const updated=structuredClone(ledger);
 updated.attempts.push({at,trigger,plannedSlotAt:slot.plannedSlotAt,
  plannedSlotBeijing:slot.plannedSlotBeijing,actualCheckBeijing:slot.actuallyStartedBeijing,
  delayMinutes:slot.delayMinutes,failureCode:reason,sourceAttempted:false});
 updated.observations.push({
  key:'tcl-group',accountId:'2050532947',at,
  roomNumber:null,observedName:null,roomStatus:null,streamStatus:null,
  mtop:'NOT_AVAILABLE',codes:[],state:'UNKNOWN'
 });
 if(updated.attempts.length>10000||updated.observations.length>10000)throw Error('LEDGER_LIMIT_EXCEEDED');
 return {ledger:updated,action:'UNKNOWN_ATTEMPT_RECORDED',slot};
}
/** R1.4 ledgers are supported; this module does not attest to external sample provenance. */
export function summarizeHourly(ledger,{asOf}={}){
 const parsed=parseLedger(ledger),now=asOf||new Date().toISOString();
 epoch(now);
 const report=reduceTmallSingleStore(parsed.observations,{asOf:now,policy:HOURLY_POLICY});
 const sessions=report.sessions.map(s=>({
  session:s.sequence,status:s.status,
  firstLiveSeenAt:s.firstLiveDetectedAt,
  lastLiveSeenAt:s.lastLiveDetectedAt,
  firstOfflineSeenAt:s.firstOfflineDetectedAt,
  secondOfflineConfirmedAt:s.endedConfirmedAt,
  observedAdjacentLiveSpanMinutes:s.estimatedContinuousLiveMinutes,
  exactPlatformStartEnd:false,
  note:'Sampling windows only, not exact broadcast times or verified continuous runtime'
 }));
 return {
  schemaVersion:16,platform:'tmall',store:'TCL集团官方旗舰店',
  accountId:'2050532947',historicalRoomNumber:'130742',
  storeKey:'tmall:accountId:2050532947',asOf:iso(epoch(now)),timezone:BJ,
  expectedMinuteOfHour:0,intervalMinutes:60,manualCheckSupported:true,
  historicalSourceVerifiedByThisRunner:false,
  activeSourceConnected:false,exactHourGuaranteed:false,
  currentState:report.currentStatus,currentStateReason:report.currentStatusReason,
  lastObservationAt:report.lastObservationAt,
  observationCounts:report.observationCounts,
  attemptCount:parsed.attempts.length,
  attempts:parsed.attempts.map(a=>({at:a.at,trigger:a.trigger||'legacy',
    plannedSlotAt:a.plannedSlotAt||null,delayMinutes:a.delayMinutes??null,
    failureCode:a.failureCode??null,sourceAttempted:a.sourceAttempted??null})),
  sessions,scoringEnabled:false,
  note:'Real platform source is not connected; do not report LIVE/OFFLINE from these attempts.'
 };
}
