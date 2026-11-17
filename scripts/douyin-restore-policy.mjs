// No I/O. Fail closed: failed-run evidence may be restored, but cannot authorize sampling.
export function restorePolicy({run, downloaded=false, ledgerValid=false, cooldown=null, cooldownAbsenceReviewed=false, recoveryBlocked=false, now=Date.now()}) {
  const out={skip:true,reason:'RESTORE_UNVERIFIED'};
  if(!Number.isFinite(now) || !run || !/^\d+$/.test(String(run.databaseId)) || run.status!=='completed' || !downloaded || !ledgerValid) return out;
  if(recoveryBlocked) return {...out,reason:'PERSISTENT_RECOVERY_REVIEW_REQUIRED'};
  if(run.conclusion!=='success') return {...out,reason:'LATEST_RUN_FAILED_REVIEW_REQUIRED'};
  if(cooldown===null&&!cooldownAbsenceReviewed)return {...out,reason:'COOLDOWN_ABSENCE_REVIEW_REQUIRED'};
  if(cooldown!==null) {
    const at=typeof cooldown.stoppedAt==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(cooldown.stoppedAt)?Date.parse(cooldown.stoppedAt):NaN;
    if(!Number.isFinite(at)||new Date(at).toISOString()!==cooldown.stoppedAt)return {...out,reason:'COOLDOWN_INVALID'};
    if(!Number.isFinite(at)||!Number.isFinite(now)||at>now) return {...out,reason:'COOLDOWN_INVALID'};
    if(now-at<24*3600e3)return {...out,reason:'ACCESS_LIMIT_COOLDOWN'};
  }
  return {skip:false,reason:'VERIFIED_RESTORE'};
}

// A future, separately owner-approved PR may add ONE exact recovery receipt.
// This validates its binding, not the authenticity of human approval; Git review is mandatory.
// No wildcard, environment switch, latest-success fallback, reset or cooldown exemption.
export function reviewedRecovery(receipt,{run,stateSha256,cooldownSha256,blockSha256,now=Date.now()}) {
  const hash=x=>typeof x==='string'&&/^[0-9a-f]{64}$/.test(x);
  return !!(receipt && receipt.schemaVersion===1 && receipt.reason==='ENCRYPTION_FAILURE_ONLY' &&
    /^\d+$/.test(String(run?.databaseId)) && receipt.runId===String(run.databaseId) &&
    hash(receipt.stateSha256) && receipt.stateSha256===stateSha256 &&
    receipt.cooldownSha256===cooldownSha256 && (cooldownSha256===null||hash(cooldownSha256)) &&
    receipt.blockSha256===blockSha256 && (blockSha256===null||hash(blockSha256)) &&
    typeof receipt.approvedBy==='string' && /^[A-Za-z0-9-]{1,39}$/.test(receipt.approvedBy) &&
    /^https:\/\/github\.com\/lijianjun004-star\/tcl-live-monitor\/(issues|pull)\/\d+#issuecomment-\d+$/.test(receipt.approvalUrl) &&
    Number.isFinite(now) && Number.isFinite(Date.parse(receipt.approvedAt)) &&
    Number.isFinite(Date.parse(receipt.expiresAt)) && Date.parse(receipt.approvedAt)<=now &&
    Date.parse(receipt.expiresAt)>now && Date.parse(receipt.expiresAt)-Date.parse(receipt.approvedAt)<=86400000);
}
