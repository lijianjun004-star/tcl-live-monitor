/**
 * Hourly pilot preflight ONLY. The caller must obtain an independent exclusive
 * platform lock and independently verify the last artifact before using any
 * ALLOW result. This pure function never starts a timer or does network IO.
 */
const TIMES=Object.freeze({jd:{primary:17,backup:47},douyin:{primary:23,backup:53}});
const ISO=/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const parsed=s=>typeof s==='string'&&ISO.test(s)&&!Number.isNaN(Date.parse(s))&&
 new Date(s).toISOString()===s?Date.parse(s):NaN;
export function preflightHourlyPilot({platform,trigger,now,priorReceipt=null,
 trustedPrior=false,lockHeld=false,sourceApproved=false}={}){
 if(!Object.hasOwn(TIMES,platform)||!['schedule','workflow_dispatch'].includes(trigger)||
  !Number.isFinite(parsed(now)))return {decision:'BLOCK',reason:'INVALID_PILOT_INPUT'};
 if(sourceApproved!==true)return {decision:'BLOCK',reason:'SOURCE_AUTHORIZATION_NOT_VERIFIED'};
 if(lockHeld!==true)return {decision:'BLOCK',reason:'EXCLUSIVE_PLATFORM_LOCK_REQUIRED'};
 const time=new Date(now),clock=time.getUTCMinutes(),config=TIMES[platform];
 if(trigger==='workflow_dispatch')return {decision:'DIAGNOSTIC_ONLY',reason:'NOT_A_SCHEDULE_EVENT',formalRate:null};
 const primaryDelta=clock-config.primary,backupDelta=clock-config.backup;
 const primary=primaryDelta>=0&&primaryDelta<=12,backup=backupDelta>=0&&backupDelta<=6;
 if(!primary&&!backup)return {decision:'SKIP',reason:'OUTSIDE_APPROVED_SLOT_WINDOW'};
 if(priorReceipt!==null){
  if(trustedPrior!==true||typeof priorReceipt!=='object'||Array.isArray(priorReceipt)||
   priorReceipt.platform!==platform || priorReceipt.verifiedArtifact!==true||
   priorReceipt.sourceReadOk!==true ||priorReceipt.schemaValidated!==true||
   typeof priorReceipt.artifactSha256!=='string'||
   !/^[a-f0-9]{64}$/i.test(priorReceipt.artifactSha256))
    return {decision:'BLOCK',reason:'UNTRUSTED_PRIOR_STATE'};
  const last=parsed(priorReceipt.observedAt),elapsed=Date.parse(now)-last;
  if(!Number.isFinite(last)||elapsed<0||elapsed>24*60*60*1000)
    return {decision:'BLOCK',reason:'PRIOR_TIMESTAMP_INVALID'};
  if(elapsed<55*60*1000)return {decision:'SKIP',reason:'RECENT_VERIFIED_SUCCESS'};
 }
 return {decision:'ALLOW_CANDIDATE',slot:primary?'primary':'backup',
  reason:'REQUIRES_CROSS_RUN_LOCK_AND_PERSISTENCE_VERIFICATION',
  guaranteedHourly:false,formalRate:null};
}
