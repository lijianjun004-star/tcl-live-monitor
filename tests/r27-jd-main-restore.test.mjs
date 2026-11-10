import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
const w=fs.readFileSync(new URL('../.github/workflows/jd-r23-scheduled.yml',import.meta.url),'utf8');

test('previous MAIN state is validated using production history state guard',()=>{
 assert.match(w,/import \{validateState\} from '\.\/probes\/r23\/jd-history\.mjs'/);
 assert.match(w,/validateState\(JSON\.parse\(fs\.readFileSync\('r23-previous\.json','utf8'\)\)\)/);
 assert.match(w,/MAIN_PRIOR_STATE_HAS_NO_RUN/);
});

test('source still cannot run when previous state restoration fails',()=>{
 assert.match(w,/id: source[\s\S]{0,220}steps\.restore\.outcome == 'success'/);
 assert.match(w,/id: accepted[\s\S]{0,220}steps\.restore\.outcome == 'success'/);
 assert.match(w,/id: state[\s\S]{0,220}steps\.restore\.outcome == 'success'/);
});

test('previous run identity and events are logged without raw credentials',()=>{
 assert.match(w,/origin:'MAIN_ONLY_ARTIFACT'/);
 assert.match(w,/last_processed_run:s\.last_processed_run/);
 assert.match(w,/stored_checks:s\.checks\.length/);
 assert.match(w,/stored_events:s\.events\.length/);
 assert.match(w,/Previous run ID:/);
 assert.doesNotMatch(w,/console\.log\(process\.env\.GH_TOKEN\)/);
});

test('state restore is main-only and cannot load experiment artifacts',()=>{
 assert.match(w,/artifacts\?name=r24-jd-main-state&per_page=100/);
 assert.match(w,/\.workflow_run\.head_branch == "main"/);
 assert.match(w,/\.workflow_run\.repository_id == \.workflow_run\.head_repository_id/);
});

test('7-day rolling only: no daily archive is published',()=>{
 const rolling=w.match(/name: Upload rolling history and sanitized snapshot[\s\S]*?(?=\n\s+- name:)/)?.[0]??'';
 assert.match(rolling,/name: r24-jd-main-state/);
 assert.match(rolling,/retention-days: 7/);
 assert.doesNotMatch(w,/retention-days: 90|r27-jd-daily-|dailycheck|dailyupload/);
});

test('the one-shot opt in still requires a main HEAD commit label',()=>{
 assert.match(w,/github\.event_name == 'push' && github\.ref == 'refs\/heads\/main' && contains\(github\.event\.head_commit\.message, '\[jd-main-smoke\]'\)/);
});

test('cron, original pinned collector and read-only permissions remain intact',()=>{
 assert.match(w,/cron: '2,7,12,17,32,47,57 \* \* \* \*'/);
 assert.match(w,/ref: 267b6709a8563ef779cda6b11c97b9684c4e1c16/);
 assert.match(w,/permissions:\s*\n\s+contents: read\s*\n\s+actions: read/);
 assert.doesNotMatch(w,/deploy-pages|upload-pages-artifact/);
});

test('restore run block passes actual bash -n syntax validation (catches heredoc indentation)',()=>{
 const section='      - name: Restore latest 7-day rolling state from Actions artifact\n';
 const start=w.indexOf(section);
 assert.ok(start>=0,'Restore section must exist');
 const bodyStart=w.indexOf('        run: |\n',start);
 assert.ok(bodyStart>=0,'Restore step must use shell script');
 const next=w.indexOf('      - name:',bodyStart+12);
 const block=w.slice(bodyStart+'        run: |\n'.length,next===-1?w.length:next);
 const script=block.split('\n').map(line=>line.startsWith('          ')?line.slice(10):line).join('\n');
 const parsed=spawnSync('bash',['-n'],{input:script,encoding:'utf8'});
 assert.equal(parsed.status,0,parsed.stderr||'Bash syntax invalid');
 assert.match(script,/validateState/);
 assert.match(script,/last_processed_run/);
});
