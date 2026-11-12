#!/usr/bin/env node
/** R2.0 JD schedule opening-rate readiness report. OFFLINE; no API/network. */
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {evaluateJdOpening,validateJdCrosswalk,validateJdSchedule} from './jd-opening-rate.mjs';

const args=process.argv.slice(2),flags=new Set(['--schedule','--crosswalk','--observations','--as-of','--out']);
for(const x of args)if(x.startsWith('--')&&!flags.has(x))throw Error('UNKNOWN_FLAG_'+x);
function get(flag,fallback){const i=args.indexOf(flag);if(i<0)return fallback;const v=args[i+1];if(!v||v.startsWith('--'))throw Error('MISSING_'+flag);return v;}
const scheduleDefault=fileURLToPath(new URL('../../config/r20-jd-schedule-inbox.json',import.meta.url));
const crosswalkDefault=fileURLToPath(new URL('../../config/r20-jd-crosswalk-review.json',import.meta.url));
const scheduleFile=get('--schedule',scheduleDefault);
const crosswalkFile=get('--crosswalk',crosswalkDefault);
const observationFile=get('--observations',null);
const at=get('--as-of',new Date().toISOString());
const schedule=JSON.parse(await fs.readFile(scheduleFile,'utf8'));
const crosswalk=JSON.parse(await fs.readFile(crosswalkFile,'utf8'));
const observations=observationFile?JSON.parse(await fs.readFile(observationFile,'utf8')):[];
const identity=validateJdCrosswalk(crosswalk),roster=validateJdSchedule(schedule);
const report=evaluateJdOpening({schedule,crosswalk,observations,as_of:at});
const output={
 ...report,source_connected:false,live_data_fetched_by_cli:false,formal_report_ready:false,
 observed_real_jd_opening_rate:null,
 readiness:{verified_public_jd_accounts:identity.verified_accounts,internal_rooms:identity.mapped_ops_rooms,
  blocked_identity_mappings:identity.pending,imported_schedule_shifts:roster.total,
  must_have_actual_verified_schedule:true,
  must_have_public_account_identity_verified:true,
  must_have_real_live_observation_in_shift_window:true,
  five_minute_on_time_rule_needs_minute_level_evidence:true},
 warning:'No source scan is performed. Results reflect only supplied, auditable inputs. Historical 5/6 LIVE snapshot is not an opening rate.'
};
const out=get('--out',null);
if(out)await fs.writeFile(out,JSON.stringify(output,null,2)+'\n');
console.log(JSON.stringify({as_of:at,formal_report_ready:false,verified_identity_count:identity.verified_accounts,
 imported_schedules:roster.total,due:report.due_shifts,opening_rate_percent:report.opening_rate_percent,
 opening_rate_status:report.opening_rate_status, output:out||'stdout_only'},null,2));
