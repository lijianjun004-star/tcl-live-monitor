/**
 * Audit the historical JD six-room, two-round TCL_OPS observations.
 * This audit NEVER produces formal opening rate, stream duration, or current state.
 */
const ID=/^[0-9]{1,16}$/;
export function auditJdHistoricalRoundEvidence(record){
 if(record?.schema_version!==20||record.platform!=='jd'||
    record.origin!=='TCL_OPS_READ_ONLY_GITHUB_ACTION_LOG'||record.rounds?.length!==2)
   throw Error('INVALID_HISTORICAL_EVIDENCE');
 if(record.source_run_url!=='https://github.com/lijianjun004-star/tcl-live-monitor/actions/runs/42356978045')throw Error('SOURCE_RUN_MISMATCH');
 if(record.source_boundaries?.room_identity_public_jd_accounts_verified!==false||
    record.source_boundaries?.formal_schedules_verified!==false||
    record.source_boundaries?.actual_opening_rate_known!==false||
    record.source_boundaries?.estimated_opening_rate_percent!==null)
   throw Error('UNSUPPORTED_RATE_CLAIM');
 const expected=['1','14','15','16','17','18'],rounds=[];
 for(let i=0;i<2;i++){
  const group=record.rounds[i];
  if(group.round!==i+1||!Array.isArray(group.observations)||group.observations.length!==6)
   throw Error('BAD_ROUND');
  if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(group.log_printed_at_utc)||
     !Number.isFinite(Date.parse(group.log_printed_at_utc)))
   throw Error('INVALID_LOG_PRINTED_TIME');
  const seen=new Set(),stats={LIVE:0,OFFLINE:0,UNKNOWN:0};
  for(const row of group.observations){
   if(!ID.test(row.ops_room_id)||!ID.test(row.ops_shop_id)||seen.has(row.ops_room_id))
    throw Error('BAD_OR_DUPLICATE_ROOM');
   if(!['LIVE','UNKNOWN','OFFLINE'].includes(row.state))throw Error('INVALID_SCAN_STATE');
   if(typeof row.reason!=='string'||!row.reason)throw Error('MISSING_OBSERVATION_PROVENANCE');
   if(row.state==='LIVE'&&!/^FRESH_MINUTE_DATA_STATUS_/.test(row.reason))throw Error('LIVE_SOURCE_UNSUPPORTED');
   if(row.state==='OFFLINE')throw Error('UNVALIDATED_OFFLINE');
   seen.add(row.ops_room_id);stats[row.state]++;
  }
  if(expected.some(r=>!seen.has(r)))throw Error('ROOM_CATALOG_MISMATCH');
  rounds.push({round:group.round,log_printed_at_utc:group.log_printed_at_utc,stats});
 }
 if(Date.parse(rounds[1].log_printed_at_utc)<=Date.parse(rounds[0].log_printed_at_utc))
  throw Error('ROUND_CLOCK_REGRESSION');
 return {
  scope:'TCL_OPS_INTERNAL_ONLY',days:[record.observed_day_beijing],
  rounds,observed_internal_room_count:6,
  public_jd_account_count_verified:0,
  schedule_due_shifts_verified:0,
  historical_status_pattern:'5_LIVE_1_UNKNOWN_PER_ROUND',
  can_compute_opening_rate:false,
  opening_rate_percent:null,
  current_live_state:'UNKNOWN',
  stream_start_time:null,
  stream_duration_minutes:null
 };
}
