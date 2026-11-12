// R3.16 offline tests. Synthetic IDs shaped like the real source schema (2026-11-12 extraction).
// These are fixtures: they prove code paths, not real platform behaviour.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { executePlan, protectCatalog, guardedFetch, sessionEvidence, nextState, publicReceipt, RUNNER_READY } from '../../probes/r316/one-shot-runner.mjs';
import { planRuntimeAction } from '../../probes/r315/runtime-switch.mjs';

const NOW = Date.parse('2026-11-12T13:58:30.000Z'); // 21:58 Beijing
const DAY = '2026-11-12';
const iso = ms => new Date(ms).toISOString();
const cfg = JSON.parse(fs.readFileSync('config/probe-targets.json', 'utf8'));
function source({ jd = [501, 502, 503], dy = Array.from({ length: 10 }, (_, i) => 601 + i), stale = [], noMinutes = [], status = {}, extra = {} } = {}) {
  const rooms = [...jd.map(id => ({ id, platform: 'jd', shop_id: id + 1000, category: '电视', bound_session_key: 'k' })),
    ...dy.map((id, i) => ({ id, platform: 'douyin', shop_id: id + 1000, category: '电视', bound_session_key: i === 0 ? 'k' : null }))];
  const shops = [...jd.map(id => ({ id: id + 1000, platform: '京东' })), ...dy.map(id => ({ id: id + 1000, platform: '抖音' }))];
  const hb = [...jd.map(id => ({ id, platform: 'jd', last_heartbeat_at: iso(NOW - 30000) })), { id: dy[0], platform: 'douyin', last_heartbeat_at: iso(NOW - 30000) }];
  const daily = id => noMinutes.includes(id) ? { ok: true, days: [] } : { ok: true, days: [{ date: DAY, session_count: 1, minute_count: 800,
    latest_minute_ts: iso(stale.includes(id) ? NOW - 7 * 3600000 : NOW - 60000), latest: status[id] === undefined ? { status: 1 } : status[id] }] };
  return { '/api/capture/rooms': { ok: true, rooms }, '/api/shops': shops, '/api/assistant/active-rooms': { ok: true, rooms: hb }, daily, ...extra };
}
function mockFetch(src, { codes = {}, hang = null, log = [] } = {}) {
  return async (url, init) => {
    const u = new URL(String(url)); log.push(u.pathname + u.search);
    if (init?.method && init.method !== 'GET') throw Error('non-GET');
    if (hang && u.pathname === hang) return new Promise(() => {});
    const code = codes[u.pathname];
    if (code) return new Response('{}', { status: code, headers: { 'content-type': 'application/json' } });
    const body = u.pathname === '/api/capture/room-overview/daily' ? src.daily(Number(u.searchParams.get('live_room_id'))) : src[u.pathname];
    if (body === undefined) return new Response('{"detail":"Not Found"}', { status: 404 });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}
const state = (over = {}) => ({ schemaVersion: 1, autoEnabled: { jd: false, douyin: false }, sourceAccessApproved: { jd: false, douyin: false },
  adapterReady: { jd: false, douyin: false }, updatedAt: '2026-11-12T00:00:00.000Z', updatedBy: 'test', updatedByRunId: null, ...over });
const approved = state({ sourceAccessApproved: { jd: true, douyin: true }, adapterReady: { jd: true, douyin: true } });
const plan = (st, ev = 'workflow_dispatch', action = 'run_once', platform = 'both', when = new Date(NOW)) =>
  planRuntimeAction({ eventName: ev, action, platform, state: st, now: when, runnerReady: RUNNER_READY });
const run = (p, fetchFn, opts = {}) => executePlan({ plan: p, runKey: opts.runKey || 'r.1', origin: 'http://ops.test', fetchFn, config: cfg, at: NOW, ...opts });

test('manual run_once with approved gates reads each platform once and exits', async () => {
  const log = [];
  const r = await run(plan(approved), mockFetch(source(), { log }));
  assert.equal(r.decision, 'ONE_SHOT'); assert.equal(r.processModel, 'ONE_SHOT_THEN_EXIT');
  const jd = r.results.find(x => x.platform === 'jd'), dy = r.results.find(x => x.platform === 'douyin');
  assert.equal(jd.status, 'READ_ONCE'); assert.deepEqual(jd.summary, { LIVE: 3, OFFLINE: 0, UNKNOWN: 6 }); // 3 live (new, unreviewed) + 6 reviewed rooms missing
  assert.equal(jd.newRooms, 3); assert.deepEqual(jd.formalSummary, { LIVE: 0, OFFLINE: 0, UNKNOWN: 6 });
  assert.equal(dy.status, 'READ_ONCE'); assert.equal(dy.rows.length, 10); assert.ok(dy.rows.every(x => x.status === 'UNKNOWN'));
  assert.equal(log.filter(p => p === '/api/capture/rooms').length, 2); // one catalog read per platform, no loop
});
test('automatic switch OFF: schedule skips without any request', async () => {
  const log = [];
  const p = plan(approved, 'schedule', null, 'both', new Date('2026-11-12T12:35:00Z'));
  assert.equal(p.decision, 'SKIP'); const r = await run(p, mockFetch(source(), { log }));
  assert.equal(log.length, 0); assert.ok(r.results.every(x => x.sourceAccess === false));
});
test('automatic switch ON but source not approved: BLOCKED, zero requests', async () => {
  const log = [];
  const p = plan(state({ autoEnabled: { jd: true, douyin: true } }), 'schedule', null, 'both', new Date('2026-11-12T12:35:00Z'));
  assert.equal(p.decision, 'BLOCKED'); const r = await run(p, mockFetch(source(), { log }));
  assert.equal(log.length, 0); assert.ok(r.results.every(x => x.reason === 'SOURCE_ACCESS_NOT_APPROVED'));
});
test('automatic switch ON + approved source: scheduled one shot reads once', async () => {
  const p = plan(state({ ...approved, autoEnabled: { jd: true, douyin: false } }), 'schedule', null, 'both', new Date('2026-11-12T12:35:00Z'));
  assert.equal(p.decision, 'ONE_SHOT'); assert.deepEqual(p.targets.map(t => t.platform), ['jd']);
  const r = await run(p, mockFetch(source()));
  assert.equal(r.results[0].status, 'READ_ONCE');
});
test('outside Beijing operating window: schedule skips', () => {
  assert.equal(plan({ ...approved, autoEnabled: { jd: true, douyin: true } }, 'schedule', null, 'both', new Date('2026-11-12T19:00:00Z')).decision, 'SKIP');
});
test('same run key twice is idempotent: second delivery does not read the source', async () => {
  const log = [];
  const f = mockFetch(source(), { log });
  const first = await run(plan(approved, 'workflow_dispatch', 'run_once', 'jd'), f);
  const st = nextState({}, first); const before = log.length;
  const second = await run(plan(approved, 'workflow_dispatch', 'run_once', 'jd'), f, { previous: st });
  assert.equal(second.results[0].status, 'SKIPPED_DUPLICATE_RUN'); assert.equal(log.length, before);
});
for (const code of [401, 403, 429]) test(`HTTP ${code} stops the run immediately and is never OFFLINE`, async () => {
  const log = [];
  const r = await run(plan(approved, 'workflow_dispatch', 'run_once', 'jd'), mockFetch(source(), { codes: { '/api/shops': code }, log }));
  assert.equal(r.results[0].status, 'BLOCKED'); assert.equal(r.results[0].reason, 'ACCESS_LIMIT_' + code);
  assert.ok(!log.some(p => p.startsWith('/api/capture/room-overview/daily')), 'no request after the limit');
});
test('timeout: a hanging source ends the run as BLOCKED, not partial success', async () => {
  const r = await run(plan(approved, 'workflow_dispatch', 'run_once', 'jd'), mockFetch(source(), { hang: '/api/capture/room-overview/daily' }), { deadlineMs: 50 });
  assert.equal(r.results[0].status, 'BLOCKED'); assert.equal(r.results[0].reason, 'RUN_DEADLINE_EXCEEDED');
});
test('HTTP 500 / schema failure immediately stop the source chain and never mark OFFLINE', async () => {
  const a = await run(plan(approved, 'workflow_dispatch', 'run_once', 'jd'), mockFetch(source(), { codes: { '/api/capture/rooms': 500 } }));
  assert.equal(a.results[0].status, 'BLOCKED');
  assert.equal(a.results[0].reason, 'SOURCE_HTTP_500');
  const b = await run(plan(approved, 'workflow_dispatch', 'run_once', 'jd'), mockFetch(source({ extra: { '/api/capture/rooms': { ok: true, items: [] } } })));
  assert.equal(b.results[0].status, 'BLOCKED');
  assert.equal(b.results[0].reason, 'SOURCE_READ_OR_SCHEMA_ERROR');
});
test('paginated / incomplete catalog is rejected', async () => {
  const s = source(); s['/api/capture/rooms'] = { ...s['/api/capture/rooms'], has_more: true };
  const r = await run(plan(approved, 'workflow_dispatch', 'run_once', 'jd'), mockFetch(s));
  assert.equal(r.results[0].status, 'SOURCE_UNAVAILABLE'); assert.ok(r.results[0].warnings.some(w => /PAGINATED/.test(w)));
});
test('real counter-example 2026-11-11: minutes frozen 4 h while capture agent alive stays UNKNOWN', async () => {
  const r = await run(plan(approved, 'workflow_dispatch', 'run_once', 'jd'), mockFetch(source({ stale: [502] })));
  const row = r.results[0].rows.find(x => x.roomId === '502');
  assert.equal(row.status, 'UNKNOWN'); assert.equal(row.reason, 'OFFLINE_CANDIDATE_AGENT_ALIVE_NO_NEW_MINUTES');
  assert.equal(r.results[0].summary.OFFLINE, 0); assert.equal(r.results[0].offlineRuleValidated, false);
});
test('same numeric id on JD and Douyin never crosses platforms', async () => {
  const r = await run(plan(approved), mockFetch(source({ jd: [601], dy: Array.from({ length: 10 }, (_, i) => 601 + i) })));
  const jd = r.results.find(x => x.platform === 'jd'), dy = r.results.find(x => x.platform === 'douyin');
  assert.equal(jd.rows.filter(x => x.seenInCurrentSource).length, 1); assert.equal(dy.rows.length, 10);
});
test('shop missing from shop list: join reported incomplete', async () => {
  const s = source(); s['/api/shops'] = s['/api/shops'].filter(x => x.id !== 1502);
  const r = await run(plan(approved, 'workflow_dispatch', 'run_once', 'jd'), mockFetch(s));
  assert.ok(r.results[0].shopJoinStatus); assert.ok(publicReceipt(r).results[0].warnings.length >= 1);
});
test('catalog shrinks: Douyin 10 -> 8 keeps 10 rows UNKNOWN; JD missing reviewed room kept UNKNOWN', async () => {
  const first = await run(plan(approved), mockFetch(source({ jd: [501, 502] })), { jdReviewedBaseline: [] });
  const st = nextState({}, first);
  const second = await run(plan(approved), mockFetch(source({ jd: [501], dy: Array.from({ length: 8 }, (_, i) => 601 + i) })), { runKey: 'r.2', previous: st, jdReviewedBaseline: [] });
  const dy = second.results.find(x => x.platform === 'douyin'), jd = second.results.find(x => x.platform === 'jd');
  assert.equal(dy.rows.length, 10); assert.equal(dy.rows.filter(x => !x.seenInCurrentSource).length, 2);
  assert.ok(dy.warnings.includes('BELOW_PRIOR_OBSERVED_10_BASELINE_NOT_PROOF_OF_DELETION'));
  const lost = jd.rows.find(x => x.roomId === '502');
  assert.equal(lost.status, 'UNKNOWN'); assert.equal(lost.reason, 'NOT_IN_CURRENT_SOURCE');
});
test('a room outside the reviewed JD baseline is flagged new and excluded from formal counts', () => {
  const p = protectCatalog({ currentRooms: [{ roomId: '1', status: 'LIVE' }, { roomId: '19', status: 'LIVE' }], reviewedBaseline: ['1', '14'] });
  assert.equal(p.newCount, 1); assert.equal(p.rows.find(r => r.roomId === '19').formalEligible, false);
  assert.equal(p.rows.find(r => r.roomId === '14').reason, 'NOT_IN_CURRENT_SOURCE');
  assert.throws(() => protectCatalog({ currentRooms: [{ roomId: '1' }, { roomId: '1' }] }), /DUPLICATE/);
});
test('guardedFetch refuses non-GET and latches after a limit', async () => {
  const g = {}; const f = guardedFetch(async () => new Response('', { status: 429 }), g);
  await assert.rejects(f('http://x/a', { method: 'POST' }), /ONLY_GET/);
  await assert.rejects(f('http://x/a', { method: 'GET' }), /ACCESS_LIMIT_429/);
  await assert.rejects(f('http://x/b', { method: 'GET' }), /ACCESS_STOPPED/); assert.equal(g.requests, 1);
});
test('session evidence uses sample times only and detects a platform session increase', () => {
  const a = sessionEvidence(null, { date: DAY, status: 'LIVE', sessionCount: 1 }, NOW);
  const b = sessionEvidence(a, { date: DAY, status: 'LIVE', sessionCount: 2 }, NOW + 3600000);
  assert.equal(b.firstSeenLiveAt, a.firstSeenLiveAt); assert.equal(b.event, 'PLATFORM_SESSION_COUNT_INCREASED');
  assert.equal(b.exactStartAt, null); assert.equal(b.exactEndAt, null); assert.equal(b.platformLiveId, null);
  assert.equal(sessionEvidence(b, { date: '2026-11-13', status: 'UNKNOWN', sessionCount: 1 }, NOW + 86400000).firstSeenLiveAt, null);
});
test('public receipt carries no identifiers', async () => {
  const r = await run(plan(approved), mockFetch(source()));
  const text = JSON.stringify(publicReceipt(r));
  assert.ok(!/roomId|shopId|"50[1-3]"|"60\d"|"1[56]0\d"|bound_session|secUid/.test(text), text.slice(0, 200));
});
test('CLI: unreadable previous state does not crash and still produces one receipt', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r316-cli-'));
  try {
    const p = path.join(dir, 'plan.json'); fs.writeFileSync(p, JSON.stringify({ decision: 'BLOCKED', targets: [{ platform: 'jd', status: 'BLOCKED', reason: 'SOURCE_ACCESS_NOT_APPROVED' }] }));
    const prev = path.join(dir, 'prev.json'); fs.writeFileSync(prev, '{not json');
    const out = spawnSync(process.execPath, ['probes/r316/one-shot-cli.mjs', p, prev, path.join(dir, 'pub.json'), path.join(dir, 'priv.json'), path.join(dir, 'state.json')], { encoding: 'utf8' });
    assert.equal(out.status, 0, out.stderr); assert.match(out.stdout, /R316_PREVIOUS_STATE_UNREADABLE/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'pub.json'), 'utf8')).results[0].sourceAccess, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
