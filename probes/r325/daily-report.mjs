// R3.25 offline: per account and Beijing day, "did it broadcast?" from an R3.22 ledger file.
// Prints account keys, dates, statuses, evidence labels, counts and sample times only. No network.
// Usage: node probes/r325/daily-report.mjs <ledger-state.json>
import fs from 'node:fs';
import { buildDailyBroadcast } from '../r322/observation-ledger.mjs';
const file = process.argv[2];
if (!file || process.argv.length !== 3) { console.error('USAGE: daily-report.mjs <ledger-state.json>'); process.exit(2); }
const days = buildDailyBroadcast(JSON.parse(fs.readFileSync(file, 'utf8')));
for (const d of days) console.log('R325_DAILY ' + JSON.stringify(d));
console.log('R325_DAILY_SUMMARY ' + JSON.stringify({ days: days.length,
  broadcastSeen: days.filter(d => d.status === 'BROADCAST_SEEN').length,
  notSeenInSamples: days.filter(d => d.status === 'NOT_SEEN_IN_SAMPLES').length,
  unknown: days.filter(d => d.status === 'UNKNOWN').length }));
