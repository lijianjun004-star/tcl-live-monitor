import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const workflow = fs.readFileSync('.github/workflows/r315-switchable-one-shot.yml','utf8');
const cli = fs.readFileSync('probes/r315/runtime-switch-cli.mjs','utf8');

test('switch workflow exposes exactly one hourly schedule opportunity',()=>{
 const matches=[...workflow.matchAll(/cron:\s*'([^']+)'/g)].map(x=>x[1]);
 assert.deepEqual(matches,['35 0-17,22-23 * * *']);
 assert.match(workflow,/workflow_dispatch:/);
 assert.match(workflow,/timeout-minutes:\s*5/);
});

test('manual workflow actions include status, run-once and persistent enable/disable',()=>{
 for(const action of ['status','run_once','enable_auto','disable_auto'])
  assert.match(workflow,new RegExp('^\\s+- '+action+'$', 'm'));
 assert.match(workflow,/INPUT_ACTION:/);
 assert.match(workflow,/INPUT_PLATFORM:/);
});

test('workflow uses isolated runtime-control branch and persists only control actions',()=>{
 assert.match(workflow,/ref=r315-runtime-control/);
 assert.match(workflow,/branch="r315-runtime-control"/);
 assert.match(workflow,/contents:\s*write/);
 assert.match(workflow,/inputs\.action == 'enable_auto'/);
 assert.match(workflow,/inputs\.action == 'disable_auto'/);
});

test('CLI does not contain timers or perform network access',()=>{
 assert.doesNotMatch(cli,/setInterval|setTimeout|EventSource|WebSocket|fetch\s*\(/);
 // R3.16: the compiled-in gate is now the frozen RUNNER_READY map of the reviewed one-shot runner.
 // It must never be read from the control file, environment or dispatch inputs.
 assert.match(cli,/runnerReady:\s*RUNNER_READY\b/);
 assert.match(cli,/import \{ RUNNER_READY \} from '\.\.\/r316\/one-shot-runner\.mjs'/);
 assert.doesNotMatch(cli,/runnerReady:\s*(state|process\.env|JSON)/);
 assert.match(cli,/ONE_SHOT_THEN_EXIT/);
});
