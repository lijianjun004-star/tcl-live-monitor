import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const workflow=fs.readFileSync(new URL('../.github/workflows/jd-r23-scheduled.yml',import.meta.url),'utf8');

test('second MAIN smoke has an explicit opt-in marker, not a scheduled hard fail',()=>{
 assert.match(workflow,/REQUIRE_PRIOR_MAIN: \$\{\{ github\.event_name == 'push' && contains\(github\.event\.head_commit\.message, '\[jd-main-smoke-2\]'\) \}\}/);
 assert.match(workflow,/if test "\$\{REQUIRE_PRIOR_MAIN\}" = "true"; then/);
 assert.match(workflow,/Normal scheduled scans still bootstrap without prior state/);
});

test('second MAIN smoke refuses silent fresh-baseline reset if main artifact is missing',()=>{
 assert.match(workflow,/if ! test -s r23-previous\.json; then/);
 assert.match(workflow,/MAIN continuity smoke requires prior MAIN state; refusing fresh baseline/);
 assert.match(workflow,/exit 3/);
});

test('second MAIN smoke verifies actual previously stored checks, events, rooms, and last run',()=>{
 for(const token of [
  's.schema_version!==23','s.platform!==','s.checks.length<7',
  '!Array.isArray(s.events)','!s.last_processed_run',
  'Object.keys(s.rooms||{}).length<7','R27_MAIN_CONTINUITY_RESTORED',
  'previous_run_id:s.last_processed_run'
 ]) assert.ok(workflow.includes(token),'missing verification '+token);
});

test('history continuation is evaluated only with accepted source evidence',()=>{
 assert.match(workflow,/const continuity = summary\?\.source_evidence_accepted === true &&/);
 assert.match(workflow,/newChecks>oldChecks/);
 assert.match(workflow,/Previous stored check count/);
 assert.match(workflow,/Current stored check count/);
 assert.match(workflow,/Verified same-state continuity/);
});

test('all regular schedule, manual dispatch, and first main smoke triggers preserved',()=>{
 assert.match(workflow,/schedule:\s*\n\s+- cron: '0,5,10,15,30,45,55 \* \* \* \*'/);
 assert.match(workflow,/workflow_dispatch:/);
 assert.match(workflow,/contains\(github\.event\.head_commit\.message, '\[jd-main-smoke\]'\)/);
 assert.match(workflow,/ref: 267b6709a8563ef779cda6b11c97b9684c4e1c16/);
});

test('main provenance, read-only and Pages safety boundaries remain intact',()=>{
 assert.match(workflow,/\.workflow_run\.head_branch == "main"/);
 assert.match(workflow,/\.workflow_run\.repository_id == \.workflow_run\.head_repository_id/);
 assert.match(workflow,/name: r24-jd-main-state/);
 assert.match(workflow,/permissions:\s*\n\s+contents: read\s*\n\s+actions: read/);
 assert.doesNotMatch(workflow,/contents:\s*write|deploy-pages|upload-pages-artifact/);
});
