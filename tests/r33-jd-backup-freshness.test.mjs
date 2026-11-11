import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {beijingOperatingWindow,decideJdBackup,BACKUP_FRESHNESS_MS} from '../probes/r33/jd-backup-freshness.mjs';

const backup=fs.readFileSync(new URL('../.github/workflows/jd-r33-backup.yml',import.meta.url),'utf8');
const canonical=fs.readFileSync(new URL('../.github/workflows/jd-r23-scheduled.yml',import.meta.url),'utf8');
const now=new Date('2026-11-11T08:37:00.000Z');
function state(when='2026-11-11T08:32:00.000Z'){
 return {schema_version:23,rooms:{'jd-1':{status:'LIVE'}},last_processed_run:'42988446429.1',last_checked_at:when};
}
const summary={source_accepted:true,run_id:'42988446429.1'};
const decide=(priorState,priorSummary,at=now)=>decideJdBackup({now:at,priorState,priorSummary});

test('backup respects Beijing 06:30 to following 02:00, including boundary',()=>{
 for(const x of ['2026-11-10T22:30:00.000Z','2026-11-11T08:37:00.000Z','2026-11-11T18:00:00.000Z']){
  assert.equal(beijingOperatingWindow(new Date(x)),true,x);
 }
 for(const x of ['2026-11-10T22:29:00.000Z','2026-11-11T18:01:00.000Z','2026-11-11T20:00:00.000Z']){
  assert.equal(beijingOperatingWindow(new Date(x)),false,x);
 }
});
test('no MAIN state bootstraps only in operating time',()=>{
 assert.deepEqual(decide(null,null).should_run,true);
 assert.equal(decide(null,null,new Date('2026-11-10T18:01:00.000Z')).should_run,false);
});
test('verified recent MAIN scan suppresses duplicate backup request',()=>{
 assert.equal(BACKUP_FRESHNESS_MS,8*60000);
 const r=decide(state('2026-11-11T08:32:00.000Z'),summary);
 assert.equal(r.should_run,false);
 assert.equal(r.reason,'RECENT_SUCCESSFUL_MAIN_SCAN');
 assert.equal(r.elapsed_minutes,5);
});
test('stale MAIN scan authorizes a backup attempt, not verified historical live duration',()=>{
 const r=decide(state('2026-11-11T08:27:00.000Z'),summary);
 assert.equal(r.should_run,true);
 assert.equal(r.reason,'MAIN_SCAN_STALE');
 assert.equal(r.elapsed_minutes,10);
});
test('exactly 8 minutes since last scan allows a backup',()=>{
 assert.equal(decide(state('2026-11-11T08:29:00.000Z'),summary).should_run,true);
});
test('failed/unverified prior source does not block the backup, but never converts to OFFLINE',()=>{
 const r=decide(state('2026-11-11T08:36:00.000Z'),{source_accepted:false});
 assert.equal(r.should_run,true);
 assert.equal(r.reason,'PREVIOUS_SOURCE_UNVERIFIED');
 assert.doesNotMatch(backup,/mark (rooms|status) OFFLINE/i);
});
test('incomplete, malformed or future artifacts fail closed',()=>{
 assert.throws(()=>decide(state(),null),/INCOMPLETE_ARTIFACT_PAIR/);
 assert.throws(()=>decide({schema_version:23,rooms:{}},summary),/INVALID_MAIN_STATE/);
 assert.throws(()=>decide(state('not-a-date'),summary),/INVALID_PREVIOUS_SCAN_TIME/);
 assert.throws(()=>decide(state('2026-11-11T08:50:00.000Z'),summary),/FUTURE_PREVIOUS_SCAN/);
});
test('preflight never accesses the JD source and only uses read-only GitHub Artifact state',()=>{
 assert.match(backup,/artifacts\?name=r24-jd-main-state&per_page=100/);
 assert.match(backup,/\.workflow_run\.head_branch == "main"/);
 assert.match(backup,/\.workflow_run\.repository_id == \.workflow_run\.head_repository_id/);
 assert.match(backup,/\.expired == false/);
 assert.match(backup,/unzip -p previous-main\.zip r23-state\.json/);
 assert.match(backup,/unzip -p previous-main\.zip r23-summary\.json/);
 assert.doesNotMatch(backup,/101\.96\.215\.251|TCL_OPS_BASE_URL|tcl-jd-all\.mjs/);
});
test('staggered backup is separate from canonical schedule, never claims guaranteed frequency',()=>{
 assert.match(backup,/cron: '4,9,14,19,34,49,59 \* \* \* \*'/);
 assert.match(canonical,/cron: '2,7,12,17,32,47,57 \* \* \* \*'/);
 assert.match(backup,/NOT a 5\/15-minute SLA/);
});
test('source is reused exactly through workflow_call, not duplicated or rewritten',()=>{
 assert.match(canonical,/^\s+workflow_call:\s*$/m);
 assert.match(backup,/uses: \.\/\.github\/workflows\/jd-r23-scheduled\.yml/);
 assert.match(backup,/secrets: inherit/);
 assert.match(canonical,/concurrency:\s*\n\s+group: r23-jd-stateful-monitor/);
 assert.match(canonical,/ref: 267b6709a8563ef779cda6b11c97b9684c4e1c16/);
});
test('read-only caller and called workflow, no Pages, never 90-day history',()=>{
 for(const w of [backup,canonical]){
  assert.match(w,/permissions:\s*\n\s+contents: read\s*\n\s+actions: read/);
  assert.doesNotMatch(w,/contents:\s*write|actions:\s*write|deploy-pages|upload-pages-artifact|retention-days:\s*90/);
 }
 assert.match(canonical,/retention-days: 7/);
 assert.equal((canonical.match(/uses: actions\/upload-artifact@v4/g)||[]).length,1);
});
test('PR/push only run offline tests; scheduled or manual backup is the only source path',()=>{
 assert.match(backup,/offline-quality:\s*\n\s+if: github\.event_name == 'push' \|\| github\.event_name == 'pull_request'/);
 assert.match(backup,/check-recent-main-scan:\s*\n\s+if: github\.event_name == 'schedule' \|\| github\.event_name == 'workflow_dispatch'/);
 assert.match(backup,/needs: check-recent-main-scan\s*\n\s+if: needs\.check-recent-main-scan\.outputs\.should_run == 'true'/);
 assert.match(canonical,/if: github\.event_name == 'schedule' \|\| github\.event_name == 'workflow_dispatch'/);
});
test('backup preflight command scripts are Bash parsable',()=>{
 const entries=[...backup.matchAll(/^\s{6}- name: ([^\n]+)\n[\s\S]*?^\s{8}run: \|\n((?:^\s{10}.*(?:\n|$))*)/gm)];
 const scripts=entries.filter(x=>/Read only latest|Decide whether/.test(x[1]));
 assert.equal(scripts.length,2,'expected both inline preflight shell scripts');
 for(const [_,name,body] of scripts){
  const script=body.split('\n').map(l=>l.startsWith('          ')?l.slice(10):l).join('\n');
  const result=spawnSync('bash',['-n'],{input:script,encoding:'utf8'});
  assert.equal(result.status,0,name+' '+result.stderr);
 }
});
