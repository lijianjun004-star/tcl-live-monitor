import fs from 'node:fs';
import { planRuntimeAction } from './runtime-switch.mjs';

const statePath = process.argv[2] || 'r315-runtime-switch.json';
const summaryPath = process.argv[3] || 'r315-run-summary.json';
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const eventName = process.env.GITHUB_EVENT_NAME || 'unknown';
const action = process.env.INPUT_ACTION || null;
const platform = process.env.INPUT_PLATFORM || 'both';
const result = planRuntimeAction({
  eventName,
  action,
  platform,
  state,
  now: new Date(),
  actor: process.env.GITHUB_ACTOR || 'unknown',
  runId: process.env.GITHUB_RUN_ID || null,
  runnerReady: false
});

if (result.decision === 'CONTROL_UPDATE') {
  fs.writeFileSync(statePath, JSON.stringify(result.nextState, null, 2) + '\n', { mode: 0o600 });
}
const summary = {
  schemaVersion: 1,
  observedAt: new Date().toISOString(),
  eventName,
  action,
  platform,
  decision: result.decision,
  reason: result.reason || null,
  trigger: result.trigger || null,
  targets: result.targets || [],
  switchState: result.state || result.nextState || state,
  sourceAccess: result.sourceAccess === true,
  continuousPolling: false,
  processModel: 'ONE_SHOT_THEN_EXIT'
};
fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify({
  decision: summary.decision,
  reason: summary.reason,
  targets: summary.targets,
  sourceAccess: summary.sourceAccess,
  continuousPolling: false,
  processModel: summary.processModel
}));
if (result.decision === 'BLOCK') process.exitCode = 1;
