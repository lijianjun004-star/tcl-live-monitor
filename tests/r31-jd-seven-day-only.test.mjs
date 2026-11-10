import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';

const w=fs.readFileSync(new URL('../.github/workflows/jd-r23-scheduled.yml',import.meta.url),'utf8');
function getScript(stepName){
 const head='      - name: '+stepName+'\n';
 const start=w.indexOf(head);
 assert.ok(start>=0,'missing workflow step: '+stepName);
 const code=w.indexOf('        run: |\n',start);
 assert.ok(code>=0,'missing script: '+stepName);
 const next=w.indexOf('      - name:',code+12);
 const body=w.slice(code+'        run: |\n'.length,next>=0?next:w.length);
 return body.split('\n').map(l=>l.startsWith('          ')?l.slice(10):l).join('\n');
}

test('user opted out: no 90-day archive upload or daily checkpoint',()=>{
 assert.doesNotMatch(w,/retention-days:\s*90|r27-jd-daily-|steps\.dailycheck|steps\.dailyupload|id: dailycheck|id: dailyupload/);
 assert.doesNotMatch(w,/name: Upload one daily 90-day immutable checkpoint|Check if today's 90-day history checkpoint already exists/);
});
test('rolling state remains 7 days with exactly one artifact upload job',()=>{
 const x=w.match(/name: Upload rolling history and sanitized snapshot[\s\S]*?(?=\n\s+- name:)/)?.[0]||'';
 assert.match(x,/name: r24-jd-main-state/);
 assert.match(x,/retention-days: 7/);
 assert.match(x,/r23-state\.json/);
 assert.match(x,/r23-summary\.json/);
 assert.equal((w.match(/uses: actions\/upload-artifact@v4/g)||[]).length,1);
});
test('no date-dependent archive query consumes source availability',()=>{
 assert.equal((w.match(/actions\/artifacts\?name=/g)||[]).length,1);
 assert.match(w,/artifacts\?name=r24-jd-main-state&per_page=100/);
 assert.doesNotMatch(w,/TZ=Asia\/Shanghai date|checkpoint_name/);
});
test('cron remains +2 shifted and manual dispatch is allowed',()=>{
 assert.match(w,/schedule:\s*\n\s+# \+2 minute offset/);
 assert.match(w,/cron: '2,7,12,17,32,47,57 \* \* \* \*'/);
 assert.match(w,/workflow_dispatch:/);
});
test('one-off main push cannot execute without explicit smoke marker',()=>{
 assert.match(w,/github\.ref == 'refs\/heads\/main' && contains\(github\.event\.head_commit\.message, '\[jd-main-smoke\]'\)/);
 assert.match(w,/if: github\.event_name == 'schedule' \|\| github\.event_name == 'workflow_dispatch'/);
});
test('provenance on restored state remains restricted to original main repository',()=>{
 assert.match(w,/\.workflow_run\.head_branch == "main"/);
 assert.match(w,/\.workflow_run\.repository_id == \.workflow_run\.head_repository_id/);
 assert.match(w,/validateState\(JSON\.parse\(fs\.readFileSync\('r23-previous\.json','utf8'\)\)\)/);
 assert.match(w,/MAIN_PRIOR_STATE_HAS_NO_RUN/);
});
test('failure of data source, state or restore fails final gate',()=>{
 const s=getScript('Gate true source/persistence success after evidence upload');
 for(const x of ["steps.restore.outcome","steps.source.outcome","steps.accepted.outcome","steps.state.outcome"])assert.ok(s.includes(x));
 assert.match(s,/exit 1/);
 assert.doesNotMatch(s,/dailycheck|dailyupload/);
});
test('real operational shell code parses as Bash, not just regex',()=>{
 for(const step of ['Restore latest 7-day rolling state from Actions artifact','Validate one scan (partial directory stays partial)','Gate true source/persistence success after evidence upload']){
   const script=getScript(step);
   const result=spawnSync('bash',['-n'],{input:script,encoding:'utf8'});
   assert.equal(result.status,0,step+': '+result.stderr);
 }
});
test('read-only collector SHA remains fixed and no Pages deployment',()=>{
 assert.match(w,/ref: 267b6709a8563ef779cda6b11c97b9684c4e1c16/);
 assert.match(w,/permissions:\s*\n\s+contents: read\s*\n\s+actions: read/);
 assert.doesNotMatch(w,/contents:\s*write|actions:\s*write|deploy-pages|upload-pages-artifact|gh-pages/);
});
test('UNKNOWN never becomes OFFLINE and no formal rate is fabricated',()=>{
 assert.match(w,/mark failed\/unknown signals UNKNOWN/);
 assert.match(w,/formal opening rate remains NULL/);
 assert.match(w,/Exact broadcast starts, ends and formal opening rate: NOT VERIFIED/);
});
test('seven-day policy is explicit in report output and workflow name',()=>{
 assert.match(w,/^name: R3\.1 JD scheduled background monitor \(7-day rolling only\)$/m);
 assert.match(w,/R3\.1: JD source accepted, MAIN state restored and 7-day rolling history uploaded/);
});
