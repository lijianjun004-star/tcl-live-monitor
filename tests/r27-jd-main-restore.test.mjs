import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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
 assert.match(w,/origin: 'MAIN_ONLY_ARTIFACT'/);
 assert.match(w,/last_processed_run: state\.last_processed_run/);
 assert.match(w,/stored_checks: state\.checks\.length/);
 assert.match(w,/stored_events: state\.events\.length/);
 assert.match(w,/Previous run ID:/);
 assert.doesNotMatch(w,/console\.log\(process\.env\.GH_TOKEN\)/);
});

test('state restore is main-only and cannot load experiment artifacts',()=>{
 assert.match(w,/artifacts\?name=r24-jd-main-state&per_page=100/);
 assert.match(w,/\.workflow_run\.head_branch == "main"/);
 assert.match(w,/\.workflow_run\.repository_id == \.workflow_run\.head_repository_id/);
});

test('90-day artifact retention is not enabled on every high-frequency scan',()=>{
 assert.match(w,/name: r24-jd-main-state/);
 assert.match(w,/retention-days: 7/);
 assert.doesNotMatch(w,/retention-days: 90/);
});

test('the one-shot opt in still requires a main HEAD commit label',()=>{
 assert.match(w,/github\.event_name == 'push' && github\.ref == 'refs\/heads\/main' && contains\(github\.event\.head_commit\.message, '\[jd-main-smoke\]'\)/);
});

test('cron, original pinned collector and read-only permissions remain intact',()=>{
 assert.match(w,/cron: '0,5,10,15,30,45,55 \* \* \* \*'/);
 assert.match(w,/ref: 267b6709a8563ef779cda6b11c97b9684c4e1c16/);
 assert.match(w,/permissions:\s*\n\s+contents: read\s*\n\s+actions: read/);
 assert.doesNotMatch(w,/deploy-pages|upload-pages-artifact/);
});
