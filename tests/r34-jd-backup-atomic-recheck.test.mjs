import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {decideJdBackup} from '../probes/r33/jd-backup-freshness.mjs';

const primary=fs.readFileSync(new URL('../.github/workflows/jd-r23-scheduled.yml',import.meta.url),'utf8');
const backup=fs.readFileSync(new URL('../.github/workflows/jd-r33-backup.yml',import.meta.url),'utf8');

function stepBlock(name){
 const start=primary.indexOf('      - name: '+name+'\n');
 assert.ok(start>=0,'Missing main workflow step: '+name);
 const next=primary.indexOf('      - name:',start+10);
 return primary.slice(start,next>=0?next:primary.length);
}
function stepIf(name){
 return stepBlock(name).split('\n').find(x=>x.trim().startsWith('if:'))?.trim()||'';
}
test('main and reusable JD backup share serial lock without cancel in progress',()=>{
 assert.match(primary,/^concurrency:\s*\n\s+group: r23-jd-stateful-monitor\s*\n\s+cancel-in-progress: false/m);
 assert.match(backup,/uses: \.\/\.github\/workflows\/jd-r23-scheduled\.yml/);
});
test('backup caller explicitly marks mode and declared input is false by default',()=>{
 assert.match(backup,/uses: \.\/\.github\/workflows\/jd-r23-scheduled\.yml\s*\n\s+with:\s*\n\s+backup_mode: true/);
 assert.match(primary,/workflow_call:\s*\n\s+inputs:\s*\n\s+backup_mode:[\s\S]{0,180}type: boolean[\s\S]{0,130}default: false/);
});
test('restore recovers BOTH prior state and success summary from MAIN only',()=>{
 const restore=stepBlock('Restore latest 7-day rolling state from Actions artifact');
 assert.match(restore,/\.workflow_run\.head_branch == "main"/);
 assert.match(restore,/\.workflow_run\.repository_id == \.workflow_run\.head_repository_id/);
 assert.match(restore,/unzip -p prior-state\.zip r23-state\.json > r23-previous\.json/);
 assert.match(restore,/unzip -p prior-state\.zip r23-summary\.json > r23-previous-summary\.json/);
});
test('second backup check is after serialized restore and before real JD source',()=>{
 const restore=primary.indexOf('      - name: Restore latest 7-day rolling state from Actions artifact');
 const check=primary.indexOf('      - name: Recheck backup freshness after shared MAIN state lock');
 const source=primary.indexOf('      - name: One authorized TCL OPS source scan (no retries)');
 assert.ok(restore>=0 && check>restore && source>check);
 const block=stepBlock('Recheck backup freshness after shared MAIN state lock');
 assert.match(block,/id: lock_recheck/);
 assert.match(block,/node \.r34-backup-policy\/probes\/r33\/jd-backup-freshness\.mjs --state r23-previous\.json --summary r23-previous-summary\.json --output "\$GITHUB_OUTPUT"/);
});
test('main-only identity is validated before running a backup policy',()=>{
 const identity=stepBlock('Confirm reusable backup invocation is MAIN only');
 const checkout=stepBlock('Checkout pinned MAIN backup freshness decision only');
 assert.match(identity,/test "\$\{GITHUB_REF\}" = "refs\/heads\/main"/);
 assert.match(identity,/test "\$\{GITHUB_REPOSITORY\}" = "lijianjun004-star\/tcl-live-monitor"/);
 assert.ok(primary.indexOf('      - name: Confirm reusable backup invocation is MAIN only')<primary.indexOf('      - name: Checkout pinned MAIN backup freshness decision only'));
 assert.match(checkout,/ref: \$\{\{ github\.sha \}\}/);
 assert.match(checkout,/sparse-checkout-cone-mode: false/);
 assert.match(checkout,/probes\/r33\/jd-backup-freshness\.mjs/);
 assert.match(checkout,/persist-credentials: false/);
});
test('source, accept, history, upload and final gate all stop on duplicate backup',()=>{
 const names=[
 'One authorized TCL OPS source scan (no retries)',
 'Validate one scan (partial directory stays partial)',
 'Carry state forward; mark failed/unknown signals UNKNOWN',
 'Upload rolling history and sanitized snapshot',
 'Gate true source/persistence success after evidence upload'];
 for(const name of names){
  const expr=stepIf(name);
  assert.match(expr,/inputs\.backup_mode != true \|\| steps\.lock_recheck\.outputs\.should_run == 'true'/,name);
 }
});
test('failure of recheck fails closed before source, never masquerades as success',()=>{
 const recheck=stepBlock('Recheck backup freshness after shared MAIN state lock');
 assert.match(recheck,/set -euo pipefail/);
 assert.doesNotMatch(recheck,/continue-on-error: true/);
 assert.match(stepIf('One authorized TCL OPS source scan (no retries)'),/steps\.lock_recheck\.outputs\.should_run == 'true'/);
});
test('original main cron still scans independent of backup policy',()=>{
 assert.match(primary,/cron: '2,7,12,17,32,47,57 \* \* \* \*'/);
 assert.match(stepIf('One authorized TCL OPS source scan (no retries)'),/inputs\.backup_mode != true/);
 assert.match(primary,/ref: 267b6709a8563ef779cda6b11c97b9684c4e1c16/);
});
test('race simulation with real pure gate: stale preflight then fresh state after MAIN lock skips',()=>{
 const now=new Date('2026-11-11T10:30:00.000Z');
 const old={schema_version:23,rooms:{'17':{state:'LIVE'}},last_processed_run:'prior.1',last_checked_at:'2026-11-11T10:00:00.000Z'};
 const fresh={...old,last_processed_run:'primary.1',last_checked_at:'2026-11-11T10:28:00.000Z'};
 const summary={source_evidence_accepted:true};
 assert.equal(decideJdBackup({now,priorState:old,priorSummary:summary}).should_run,true);
 const afterLock=decideJdBackup({now,priorState:fresh,priorSummary:summary});
 assert.equal(afterLock.should_run,false);
 assert.equal(afterLock.reason,'RECENT_SUCCESSFUL_MAIN_SCAN');
});
test('backup proceeds after lock when prior source was invalid or state is stale',()=>{
 const now=new Date('2026-11-11T10:30:00.000Z');
 const recent={schema_version:23,rooms:{'17':{state:'UNKNOWN'}},last_processed_run:'failed.1',last_checked_at:'2026-11-11T10:29:00.000Z'};
 assert.equal(decideJdBackup({now,priorState:recent,priorSummary:{source_evidence_accepted:false}}).should_run,true);
 const old={...recent,last_checked_at:'2026-11-11T10:15:00.000Z'};
 assert.equal(decideJdBackup({now,priorState:old,priorSummary:{source_evidence_accepted:true}}).should_run,true);
});
test('new conditional Shell steps parse with actual Bash',()=>{
 for(const name of ['Confirm reusable backup invocation is MAIN only','Recheck backup freshness after shared MAIN state lock']){
  const block=stepBlock(name);
  const mark='        run: |\n';
  const b=block.indexOf(mark);
  assert.ok(b>=0,name+' missing run');
  const script=block.slice(b+mark.length).split('\n').map(x=>x.startsWith('          ')?x.slice(10):x).join('\n');
  const res=spawnSync('bash',['-n'],{input:script,encoding:'utf8'});
  assert.equal(res.status,0,res.stderr);
 }
});
test('read only, 7-day state only, no Pages or 90d archive',()=>{
 assert.match(primary,/permissions:\s*\n\s+contents: read\s*\n\s+actions: read/);
 assert.match(backup,/permissions:\s*\n\s+contents: read\s*\n\s+actions: read/);
 assert.match(primary,/retention-days: 7/);
 assert.equal((primary.match(/uses: actions\/upload-artifact@v4/g)||[]).length,1);
 assert.doesNotMatch(primary+backup,/retention-days:\s*90|r27-jd-daily-|dailyupload|upload-pages-artifact|deploy-pages|contents:\s*write/);
});
