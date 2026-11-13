// Checks the sealed end-to-end run (run-sealed-e2e.sh) and imports its receipts with the R3.22 ledger.
// Usage: node assert-e2e.mjs <repo-root> <work-dir> [copy-to-dir]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const [root, work, copyTo] = process.argv.slice(2);
const read = (...p) => fs.readFileSync(path.join(work, ...p), 'utf8');
const json = (...p) => JSON.parse(read(...p));
const reg = JSON.parse(fs.readFileSync(path.join(root, 'config/probe-targets.json'), 'utf8'));
const [first, second] = JSON.parse(fs.readFileSync(path.join(root, 'config/r316-douyin-rpa-targets.json'), 'utf8')).targets.map(t => t.key);
const row = (r, key) => r.checked.find(x => x.key === key);

// NORMAL: first account verified without a live badge; second verified LIVE on its own registered room only.
const n = json('NORMAL', 'receipt.json');
assert.equal(read('NORMAL', 'probe-exit.txt').trim(), '0');
assert.deepEqual(json('NORMAL', 'server-log.json'), ['profile:first', 'profile:second', 'room:second']);
assert.equal(n.stopped, null);
assert.deepEqual([row(n, first).state, row(n, first).reason, row(n, first).profileIdentityVerified], ['UNKNOWN', 'NO_LIVE_BADGE_NOT_PROOF_OF_OFFLINE', true]);
assert.deepEqual([row(n, second).state, row(n, second).profileIdentityVerified, row(n, second).roomIdentityVerified], ['LIVE', true, true]);

// FORBIDDEN_FIRST: a 403 on the first profile stops the run; the second account is never visited.
const f = json('FORBIDDEN_FIRST', 'receipt.json');
assert.equal(read('FORBIDDEN_FIRST', 'probe-exit.txt').trim(), '3');
assert.deepEqual(json('FORBIDDEN_FIRST', 'server-log.json'), ['profile:first:403']);
assert.deepEqual(f.stopped, { key: first, reason: 'HTTP_403' });
assert.deepEqual(f.stopEvidence, { status: 403, hostClass: 'DOUYIN_WWW', resourceType: 'document', method: 'GET', mainFrameNavigation: true });
assert.deepEqual([row(f, first).state, row(f, first).reason], ['UNKNOWN', 'STOPPED_HTTP_403']);
assert.deepEqual([row(f, second).state, row(f, second).reason], ['NOT_RUN', 'STOPPED_AFTER_ACCESS_LIMIT']);

// Ledger: both receipts import through the real CLI; one session clue for the second account.
const ledgerDir = path.join(work, 'ledger');
for (const s of ['NORMAL', 'FORBIDDEN_FIRST']) {
  const r = spawnSync(process.execPath, [path.join(root, 'probes/r322/import-receipt.mjs'), '--receipt', path.join(work, s, 'receipt.json'),
    '--state', path.join(ledgerDir, 'state.json'), '--html', path.join(ledgerDir, 'index.html'), '--evidence-kind', 'synthetic'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}
const { buildSummary } = await import(path.join(root, 'probes/r322/observation-ledger.mjs'));
const ledger = JSON.parse(fs.readFileSync(path.join(ledgerDir, 'state.json'), 'utf8'));
const summary = buildSummary(ledger);
assert.equal(ledger.observations.length, 4);
assert.deepEqual(summary.sessions.map(s => s.key), [second]);
assert.deepEqual(summary.rooms.map(r => [r.key, r.executedCount, r.notRunCount]).sort(), [[first, 2, 0], [second, 1, 1]].sort());
const html = fs.readFileSync(path.join(ledgerDir, 'index.html'), 'utf8');
assert.doesNotMatch(html, /<script|src=|href=|https?:\/\//i);

// Privacy: no registry identifier of ANY Douyin account in receipts, logs, ledger or page.
const needles = reg.douyin.flatMap(t => [new URL(t.profileUrl).pathname.split('/').pop(), t.displayDouyinId, t.roomId && String(t.roomId), t.accountName]).filter(Boolean);
const outputs = ['NORMAL', 'FORBIDDEN_FIRST'].flatMap(s => ['receipt.json', 'probe-stdout.txt', 'server-log.json'].map(f => read(s, f)))
  .concat(fs.readFileSync(path.join(ledgerDir, 'state.json'), 'utf8'), html);
for (const o of outputs) for (const x of needles) assert.ok(!o.includes(x), 'registry identifier leaked into an output');

if (copyTo) {
  fs.mkdirSync(copyTo, { recursive: true });
  for (const s of ['NORMAL', 'FORBIDDEN_FIRST']) for (const f of ['receipt.json', 'server-log.json', 'probe-stdout.txt'])
    fs.copyFileSync(path.join(work, s, f), path.join(copyTo, `${s}-${f}`));
  for (const f of ['state.json', 'index.html']) fs.copyFileSync(path.join(ledgerDir, f), path.join(copyTo, `ledger-${f}`));
}
console.log('R322_SEALED_E2E ' + JSON.stringify({
  normal: n.checked.map(r => [r.key, r.state, r.reason]), forbiddenFirst: f.checked.map(r => [r.key, r.state, r.reason]),
  stopEvidence: f.stopEvidence, ledgerObservations: ledger.observations.length, sessionClues: summary.sessions.length, result: 'PASS' }));
