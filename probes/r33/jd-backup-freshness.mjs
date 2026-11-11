/**
 * R3.3 JD backup trigger freshness gate.
 *
 * Runs only in a backup GitHub Actions preflight. No JD HTTP traffic here;
 * no state mutations, status classification or KPI calculation.
 */
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';

export const BACKUP_FRESHNESS_MS = 8 * 60 * 1000;

export function beijingOperatingWindow(date) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    throw new Error('INVALID_NOW');
  }
  const beijing = new Date(date.getTime() + 8 * 3600000);
  const minuteOfDay = beijing.getUTCHours() * 60 + beijing.getUTCMinutes();
  return minuteOfDay >= 390 || minuteOfDay <= 120;
}

/**
 * Existing pair must be sourced from same-repo MAIN-only latest artifact.
 * Source acceptance is a saved result, not proof of a platform OFFLINE state.
 * If either file exists alone, caller must reject the pair before invoking.
 */
export function decideJdBackup({now, priorState = null, priorSummary = null} = {}) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('INVALID_NOW');
  if ((priorState === null) !== (priorSummary === null)) throw new Error('INCOMPLETE_ARTIFACT_PAIR');
  if (!beijingOperatingWindow(now)) {
    return {should_run:false,reason:'OUTSIDE_BEIJING_OPERATING_WINDOW',elapsed_minutes:null};
  }
  if (priorState === null) {
    return {should_run:true,reason:'NO_MAIN_STATE_AVAILABLE',elapsed_minutes:null};
  }
  if (priorState.schema_version !== 23 ||
      !priorState.rooms || typeof priorState.rooms !== 'object' ||
      typeof priorState.last_processed_run !== 'string' ||
      !priorState.last_processed_run) {
    throw new Error('INVALID_MAIN_STATE');
  }
  if (!priorSummary || typeof priorSummary !== 'object') throw new Error('INVALID_MAIN_SUMMARY');
  // The production pinned R2.3 collector writes source_evidence_accepted.
  // Reject ambiguous/synthetic flags instead of silently scanning again.
  if (typeof priorSummary.source_evidence_accepted !== 'boolean') {
    throw new Error('INVALID_SOURCE_EVIDENCE_FLAG');
  }
  if (priorSummary.source_evidence_accepted !== true) {
    return {should_run:true,reason:'PREVIOUS_SOURCE_UNVERIFIED',elapsed_minutes:null};
  }
  const iso = priorState.last_checked_at;
  if (typeof iso !== 'string' ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(iso) ||
      !Number.isFinite(Date.parse(iso)) ||
      new Date(iso).toISOString() !== iso) {
    throw new Error('INVALID_PREVIOUS_SCAN_TIME');
  }
  const age=now.getTime()-Date.parse(iso);
  if(age < -60000) throw new Error('FUTURE_PREVIOUS_SCAN');
  if(age < BACKUP_FRESHNESS_MS) {
    return {should_run:false,reason:'RECENT_SUCCESSFUL_MAIN_SCAN',elapsed_minutes:Math.max(0,Math.floor(age/60000))};
  }
  return {should_run:true,reason:'MAIN_SCAN_STALE',elapsed_minutes:Math.floor(age/60000)};
}

function flag(flagName) {
  const i=process.argv.indexOf(flagName);
  if (i<0 || !process.argv[i+1]) throw new Error('MISSING_FLAG_'+flagName);
  return process.argv[i+1];
}
function main(){
  const stateFile=flag('--state');
  const summaryFile=flag('--summary');
  const output=flag('--output');
  const stateExists=fs.existsSync(stateFile);
  const summaryExists=fs.existsSync(summaryFile);
  if(stateExists!==summaryExists)throw new Error('INCOMPLETE_ARTIFACT_PAIR');
  const priorState=stateExists?JSON.parse(fs.readFileSync(stateFile,'utf8')):null;
  const priorSummary=summaryExists?JSON.parse(fs.readFileSync(summaryFile,'utf8')):null;
  const result=decideJdBackup({now:new Date(),priorState,priorSummary});
  fs.appendFileSync(output,'should_run='+String(result.should_run)+'\n');
  fs.appendFileSync(output,'reason='+result.reason+'\n');
  console.log(JSON.stringify({...result,platform:'jd',source:'MAIN_ONLY_ARTIFACT',actual_start_end_unverified:true}));
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href)main();
