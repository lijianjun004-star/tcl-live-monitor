import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {auditJdHistoricalRoundEvidence} from '../probes/r20/jd-historical-audit.mjs';

const item=JSON.parse(fs.readFileSync(new URL('../docs/r20/evidence/jd-2026-11-07-two-rounds.json',import.meta.url),'utf8'));
const copy=()=>structuredClone(item);
test('two REAL ops rounds preserved as 6 internal JD rooms with 5 LIVE and 1 UNKNOWN',()=>{
 const r=auditJdHistoricalRoundEvidence(item);
 assert.equal(r.observed_internal_room_count,6);
 assert.deepEqual(r.rounds.map(x=>x.stats),[
  {LIVE:5,OFFLINE:0,UNKNOWN:1},{LIVE:5,OFFLINE:0,UNKNOWN:1}
 ]);
});
test('past status distribution is never 5/6 opening rate or current LIVE',()=>{
 const r=auditJdHistoricalRoundEvidence(item);
 assert.equal(r.opening_rate_percent,null);
 assert.equal(r.can_compute_opening_rate,false);
 assert.equal(r.current_live_state,'UNKNOWN');
 assert.equal(r.stream_duration_minutes,null);
 assert.equal(r.public_jd_account_count_verified,0);
 assert.equal(r.schedule_due_shifts_verified,0);
});
test('internal ops shop IDs cannot be silently upgraded to public JD shop IDs',()=>{
 const r=auditJdHistoricalRoundEvidence(item);
 assert.equal(r.scope,'TCL_OPS_INTERNAL_ONLY');
 const bad=copy();bad.source_boundaries.room_identity_public_jd_accounts_verified=true;
 assert.throws(()=>auditJdHistoricalRoundEvidence(bad),/UNSUPPORTED_RATE_CLAIM/);
});
test('historical evidence must never provide fabricated 83.33%',()=>{
 const bad=copy();bad.source_boundaries.estimated_opening_rate_percent=83.33;
 assert.throws(()=>auditJdHistoricalRoundEvidence(bad),/UNSUPPORTED_RATE_CLAIM/);
});
test('no OFFLINE: candidate without negative verification cannot infer non-opening',()=>{
 const bad=copy();bad.rounds[0].observations[0].state='OFFLINE';
 assert.throws(()=>auditJdHistoricalRoundEvidence(bad),/UNVALIDATED_OFFLINE/);
});
test('duplicate or missing JD internal room rejected',()=>{
 const bad=copy();bad.rounds[0].observations[0].ops_room_id='14';
 assert.throws(()=>auditJdHistoricalRoundEvidence(bad),/BAD_OR_DUPLICATE_ROOM/);
});
test('time regression and source mismatch rejected',()=>{
 const bad=copy();bad.rounds[1].log_printed_at_utc=bad.rounds[0].log_printed_at_utc;
 assert.throws(()=>auditJdHistoricalRoundEvidence(bad),/ROUND_CLOCK_REGRESSION/);
 const other=copy();other.source_run_url='https://github.com/not-this-run';
 assert.throws(()=>auditJdHistoricalRoundEvidence(other),/SOURCE_RUN_MISMATCH/);
});
test('clock print times never become exact opening timestamps',()=>{
 const r=auditJdHistoricalRoundEvidence(item);
 assert.equal(r.stream_start_time,null);
 assert.equal(item.source_time_semantics,'ROUND_LOG_PRINT_TIME_NOT_EXACT_LIVE_START_OR_CHECK_TIME');
});
