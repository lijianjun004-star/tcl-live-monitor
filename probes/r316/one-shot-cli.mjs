// R3.16 CLI: execute the READY targets of one switch plan exactly once, then exit.
// usage: node probes/r316/one-shot-cli.mjs <plan.json> <previous-state.json|-> <public-receipt.json> <private-run.json> <next-state.json>
import fs from 'node:fs';
import { executePlan, nextState, publicReceipt, deliveryKey } from './one-shot-runner.mjs';
const [planPath, prevPath, pubPath, privPath, statePath] = process.argv.slice(2);
if (!planPath || !pubPath || !privPath || !statePath) { console.error('usage: one-shot-cli plan prev pub priv state'); process.exit(2); }
const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
let previous = {};
if (prevPath && prevPath !== '-' && fs.existsSync(prevPath)) { try { previous = JSON.parse(fs.readFileSync(prevPath, 'utf8')); } catch { console.log('R316_PREVIOUS_STATE_UNREADABLE (continuing without; missing rooms cannot be restored)'); } }
const config = JSON.parse(fs.readFileSync('config/probe-targets.json', 'utf8'));
const runKey = (process.env.GITHUB_RUN_ID ? deliveryKey({ eventName: process.env.GITHUB_EVENT_NAME, runId: process.env.GITHUB_RUN_ID, now: Date.now() }) : 'local') + (process.env.R316_RUN_KEY_SUFFIX || '');
const run = await executePlan({ plan, runKey, origin: process.env.TCL_OPS_ORIGIN || 'http://101.96.215.251', config, previous });
const receipt = publicReceipt(run);
fs.writeFileSync(pubPath, JSON.stringify(receipt, null, 1) + '\n');
fs.writeFileSync(privPath, JSON.stringify(run) + '\n', { mode: 0o600 });
fs.writeFileSync(statePath, JSON.stringify(nextState(previous, run)) + '\n', { mode: 0o600 });
console.log('R316_RECEIPT ' + JSON.stringify(receipt));
if (run.results.some(r => r.status === 'BLOCKED' && r.sourceAccess)) process.exitCode = 3;
