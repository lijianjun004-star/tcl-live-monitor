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

// R3.23 scenarios mirror the page shape seen in approved real run 43449924435.
const R323 = ['REAL_LAYOUT', 'FOREIGN_BADGE', 'ROOM_TITLE_EMPTY'];
for (const s of R323) { assert.equal(read(s, 'probe-exit.txt').trim(), '0', s); assert.equal(json(s, 'receipt.json').stopped, null, s); }
const pick = r => ({ state: r.state, reason: r.reason, scope: r.ownerAnchorScope, profileId: r.profileIdentityVerified,
  roomId: r.roomIdentityVerified, badge: r.liveBadgeSeen, roomHttp: r.roomHttp, titleEmpty: r.profileSignals?.titleEmpty, roomSignals: r.roomSignals });
const noRoom = { roomId: false, roomHttp: null, roomSignals: null };
// REAL_LAYOUT: empty profile title; the account's OWN registered room is the only live link, outside the
// owner containers -> visited, room page confirms owner -> LIVE. The other account has no badge.
const rl = json('REAL_LAYOUT', 'receipt.json');
assert.deepEqual(json('REAL_LAYOUT', 'server-log.json'), ['profile:first', 'room:first', 'profile:second']);
assert.deepEqual(pick(row(rl, first)), { state: 'LIVE', reason: 'PROFILE_LIVE_BADGE_AND_ROOM_PAGE_IDENTITY', scope: 'REGISTERED_ROOM_LIVE_ANCHOR',
  profileId: true, roomId: true, badge: true, roomHttp: 200, titleEmpty: true,
  roomSignals: { httpOk: true, titleEmpty: false, titleExact: true, metaExact: true, ownerLinkExact: true } });
assert.deepEqual(pick(row(rl, second)), { state: 'UNKNOWN', reason: 'NO_LIVE_BADGE_NOT_PROOF_OF_OFFLINE', scope: 'NO_OWNER_HEADER_LIVE_ANCHOR',
  profileId: true, badge: false, titleEmpty: true, ...noRoom });
// FOREIGN_BADGE: a live link to ANOTHER room (alone, or next to the registered one) is never visited and
// is reported as outside the owner scope, not as "no live badge".
const fb = json('FOREIGN_BADGE', 'receipt.json');
assert.deepEqual(json('FOREIGN_BADGE', 'server-log.json'), ['profile:first', 'profile:second']);
for (const k of [first, second]) assert.deepEqual(pick(row(fb, k)), { state: 'UNKNOWN', reason: 'LIVE_BADGE_OUTSIDE_OWNER_SCOPE',
  scope: 'NO_OWNER_HEADER_LIVE_ANCHOR', profileId: true, badge: true, titleEmpty: true, ...noRoom });
// ROOM_TITLE_EMPTY: the registered room is visited but its page lacks the exact title -> fail closed.
const rte = json('ROOM_TITLE_EMPTY', 'receipt.json');
assert.deepEqual(json('ROOM_TITLE_EMPTY', 'server-log.json'), ['profile:first', 'room:first', 'profile:second']);
assert.deepEqual(pick(row(rte, first)), { state: 'UNKNOWN', reason: 'LIVE_BADGE_BUT_ROOM_PAGE_NOT_CROSS_VERIFIED', scope: 'REGISTERED_ROOM_LIVE_ANCHOR',
  profileId: true, roomId: false, badge: true, roomHttp: 200, titleEmpty: true,
  roomSignals: { httpOk: true, titleEmpty: true, titleExact: false, metaExact: true, ownerLinkExact: true } });
// Private calibration record (checked inside the sealed step, reduced to booleans): ancestry chains only,
// letters-only labels, the registered room flagged, the owner link found on the room page.
const shape = json('REAL_LAYOUT', 'private-shape.json');
const sf = shape.find(x => x.key === first), ss = shape.find(x => x.key === second);
assert.deepEqual(sf.profile.liveAnchors, [{ registeredRoom: true, liveText: true, insideLiveEntry: true, insideUserInfo: false, labelsSafe: true }]);
assert.deepEqual(sf.profile.keys, ['liveAnchors', 'ownerLinks']);
assert.deepEqual(sf.profile.anchorKeys, ['ancestry', 'liveText', 'registeredRoom']);
assert.deepEqual(sf.room.ownerLinks, [{ insideRoomOwner: true, insideUserInfo: false, labelsSafe: true }]);
assert.deepEqual([ss.profile.liveAnchors, ss.room], [[], null]);
const fshape = json('FOREIGN_BADGE', 'private-shape.json');
assert.deepEqual(fshape.find(x => x.key === second).profile.liveAnchors.map(x => x.registeredRoom), [true, false]);
assert.deepEqual(fshape.find(x => x.key === first).profile.liveAnchors.map(x => x.registeredRoom), [false]);

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
// R3.23 receipts go through the real CLI into their own ledger: one LIVE clue, then unknowns.
const ledger2Dir = path.join(work, 'ledger-r323');
for (const s of R323) {
  const r = spawnSync(process.execPath, [path.join(root, 'probes/r322/import-receipt.mjs'), '--receipt', path.join(work, s, 'receipt.json'),
    '--state', path.join(ledger2Dir, 'state.json'), '--html', path.join(ledger2Dir, 'index.html'), '--evidence-kind', 'synthetic'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}
const ledger2 = JSON.parse(fs.readFileSync(path.join(ledger2Dir, 'state.json'), 'utf8'));
const summary2 = buildSummary(ledger2);
assert.equal(ledger2.observations.length, 6);
assert.deepEqual(summary2.sessions.map(s => [s.key, s.status, s.hasUnknownObservations]), [[first, 'END_UNCONFIRMED', true]]);
assert.deepEqual(summary2.rooms.map(r => [r.key, r.state, r.reason]).sort(), [[first, 'UNKNOWN', 'LIVE_BADGE_BUT_ROOM_PAGE_NOT_CROSS_VERIFIED'], [second, 'UNKNOWN', 'NO_LIVE_BADGE_NOT_PROOF_OF_OFFLINE']].sort());
const html2 = fs.readFileSync(path.join(ledger2Dir, 'index.html'), 'utf8');
assert.doesNotMatch(html2, /<script|src=|href=|https?:\/\//i);
const ALL = ['NORMAL', 'FORBIDDEN_FIRST', ...R323];
const outputs = ALL.flatMap(s => ['receipt.json', 'probe-stdout.txt', 'server-log.json', 'private-shape.json'].map(f => read(s, f)))
  .concat(fs.readFileSync(path.join(ledgerDir, 'state.json'), 'utf8'), html, fs.readFileSync(path.join(ledger2Dir, 'state.json'), 'utf8'), html2);
for (const o of outputs) for (const x of needles) assert.ok(!o.includes(x), 'registry identifier leaked into an output');

if (copyTo) {
  fs.mkdirSync(copyTo, { recursive: true });
  for (const s of ALL) for (const f of ['receipt.json', 'server-log.json', 'probe-stdout.txt', 'private-shape.json'])
    fs.copyFileSync(path.join(work, s, f), path.join(copyTo, `${s}-${f}`));
  for (const f of ['state.json', 'index.html']) fs.copyFileSync(path.join(ledgerDir, f), path.join(copyTo, `ledger-${f}`));
  for (const f of ['state.json', 'index.html']) fs.copyFileSync(path.join(ledger2Dir, f), path.join(copyTo, `ledger-r323-${f}`));
}
console.log('R322_SEALED_E2E ' + JSON.stringify({
  normal: n.checked.map(r => [r.key, r.state, r.reason]), forbiddenFirst: f.checked.map(r => [r.key, r.state, r.reason]),
  realLayout: rl.checked.map(r => [r.key, r.state, r.reason, r.ownerAnchorScope]), foreignBadge: fb.checked.map(r => [r.key, r.state, r.reason]),
  roomTitleEmpty: rte.checked.map(r => [r.key, r.state, r.reason]),
  stopEvidence: f.stopEvidence, ledgerObservations: ledger.observations.length + ledger2.observations.length,
  sessionClues: summary.sessions.length + summary2.sessions.length, result: 'PASS' }));
