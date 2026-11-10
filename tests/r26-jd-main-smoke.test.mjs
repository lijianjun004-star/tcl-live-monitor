import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const workflow=fs.readFileSync(new URL('../.github/workflows/jd-r23-scheduled.yml',import.meta.url),'utf8');

test('main is on the existing push file trigger with strict path restriction',()=>{
  assert.match(workflow,/push:\s*\n\s+branches:\s*\n\s+- main\s*\n\s+- release\/r23-jd-scheduler-only/);
  assert.match(workflow,/paths:\s*\n\s+- '\.github\/workflows\/jd-r23-scheduled\.yml'/);
});

test('one-off main smoke requires the literal opt-in marker on head commit',()=>{
  assert.match(workflow,/if: github\.event_name == 'schedule' \|\| github\.event_name == 'workflow_dispatch' \|\| \(github\.event_name == 'push' && github\.ref == 'refs\/heads\/main' && contains\(github\.event\.head_commit\.message, '\[jd-main-smoke\]'\)\)/);
});

test('normal unlabelled push and all pull requests do not pass inspect gate',()=>{
  const guard=workflow.match(/^\s+if: github\.event_name == 'schedule' \|\| github\.event_name == 'workflow_dispatch'.*$/m)?.[0]||'';
  assert.ok(guard.includes("contains(github.event.head_commit.message, '[jd-main-smoke]')"));
  assert.doesNotMatch(guard,/pull_request/);
  assert.match(guard,/github\.ref == 'refs\/heads\/main'/);
});

test('cron and normal manual dispatch stay enabled',()=>{
  assert.match(workflow,/workflow_dispatch:/);
  assert.match(workflow,/schedule:\s*\n\s+- cron: '0,5,10,15,30,45,55 \* \* \* \*'/);
  assert.match(workflow,/name: Enforce Beijing 06:30 to 02:00 window/);
});

test('scan source code remains SHA pinned and read only',()=>{
  assert.match(workflow,/ref: 267b6709a8563ef779cda6b11c97b9684c4e1c16/);
  assert.match(workflow,/permissions:\s*\n\s+contents: read\s*\n\s+actions: read/);
  assert.doesNotMatch(workflow,/contents:\s*write|actions:\s*write/);
  assert.match(workflow,/node probes\/tcl-jd-all\.mjs --shard-index 0 --shard-total 1/);
});

test('state restored only from main, writes the isolated seven-day namespace',()=>{
  assert.match(workflow,/\.workflow_run\.head_branch == "main"/);
  assert.match(workflow,/artifacts\?name=r24-jd-main-state&per_page=100/);
  assert.match(workflow,/name: r24-jd-main-state/);
  assert.match(workflow,/retention-days: 7/);
});

test('GH Job Summary is evidence-only and does not claim cron was verified',()=>{
  assert.match(workflow,/name: Write safe run proof to Actions job summary/);
  assert.match(workflow,/fs\.appendFileSync\(process\.env\.GITHUB_STEP_SUMMARY/);
  assert.match(workflow,/push smoke run does not prove cron/);
  assert.match(workflow,/Source evidence accepted:/);
  assert.match(workflow,/Exact broadcast starts, ends and formal opening rate: NOT VERIFIED/);
});

test('does not deploy pages or print secret credentials',()=>{
  assert.doesNotMatch(workflow,/deploy-pages|upload-pages-artifact|gh-pages\/|secrets\.TCL_OPS_BASE_URL.*echo/);
  assert.match(workflow,/persist-credentials: false/);
  assert.doesNotMatch(workflow,/echo.*GH_TOKEN|echo.*TCL_OPS_BASE_URL/);
});
