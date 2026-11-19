import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { SOURCE_ROUTES } from '../probes/lib/tcl-jd-all.mjs';

const exec = promisify(execFile);
const script = fileURLToPath(new URL('../scripts/check-jd-source-recovery.mjs', import.meta.url));
const roomId = '700001';

async function fixture(t, { online = true, coverage = true, catalogUnavailable = false, duplicate = false } = {}) {
  const requests = [];
  const server = http.createServer((request, response) => {
    const { pathname, searchParams } = new URL(request.url, 'http://localhost');
    requests.push({ method: request.method, path: pathname });
    response.setHeader('connection', 'close');
    const now = new Date().toISOString();
    const shops = [{ id: '900001', platform: 'jd', owner: 'FIXTURE_PRIVATE_NAME' }];
    const room = { id: roomId, platform: 'jd', shop_id: '900001', bound_session_key: 'FIXTURE_PRIVATE_KEY' };
    const rooms = duplicate ? [room, room] : [room];
    const fixtures = {
      [SOURCE_ROUTES.rooms]: { rooms, total: rooms.length },
      [SOURCE_ROUTES.shops]: coverage ? { shops, total: 1 } : shops,
      [SOURCE_ROUTES.heartbeats]: { rooms: online ? [{ id: roomId, last_heartbeat_at: now }] : [] },
      [SOURCE_ROUTES.daily]: { days: online ? [{ date: searchParams.get('start_date'),
        minute_count: 1, latest_minute_ts: now, latest: { status: 1 } }] : [] },
    };
    if (catalogUnavailable && pathname === SOURCE_ROUTES.rooms) {
      response.statusCode = 503;
      response.end('FIXTURE_PRIVATE_ERROR');
      return;
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(fixtures[pathname] ?? {}));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    requests,
    async run(overrides = {}) {
      const env = {
        ...process.env,
        TCL_OPS_BASE_URL: origin,
        JD_APPROVED_SOURCE_ORIGIN: origin,
        JD_LEGACY_SOURCE_ORIGIN: '',
        JD_RECOVERY_TARGET_ROOM_ID: roomId,
        ...overrides,
      };
      const result = await exec(process.execPath, [script], { env, timeout: 15_000 }).then(
        value => ({ ...value, code: 0 }),
        error => {
          if (typeof error.code !== 'number') throw error;
          return error;
        },
      );
      assert.doesNotMatch(result.stdout + result.stderr, /127\.0\.0\.1|example\.invalid|FIXTURE_PRIVATE|700001|900001/);
      assert.equal(result.stderr, '');
      return { exitCode: result.code, report: JSON.parse(result.stdout) };
    },
  };
}

test('the validation runs before any requests', async t => {
  const source = await fixture(t);
  assert.deepEqual(await source.run({ JD_APPROVED_SOURCE_ORIGIN: 'https://example.invalid' }),
    { exitCode: 2, report: { status: 'BLOCKED', reason: 'APPROVED_ORIGIN_MISMATCH' } });
  assert.deepEqual(await source.run({ JD_RECOVERY_TARGET_ROOM_ID: '' }),
    { exitCode: 2, report: { status: 'BLOCKED', reason: 'INTERNAL_ROOM_ID_REQUIRED' } });
  assert.deepEqual(source.requests, []);
});

test('the known room needs a fresh accepted live signal', async t => {
  const source = await fixture(t);
  const { report, exitCode } = await source.run();
  assert.equal(exitCode, 0);
  assert.deepEqual(report, {
    status: 'PASS', coverage: 'COMPLETE', roomCount: 1, liveCount: 1, unknownCount: 0,
    sourceCodes: [], reason: 'TARGET_LIVE_CONFIRMED',
  });
  assert.deepEqual(source.requests.map(({ path }) => path).sort(), Object.values(SOURCE_ROUTES).sort());
  assert.ok(source.requests.every(({ method }) => method === 'GET'));
  const missing = await source.run({ JD_RECOVERY_TARGET_ROOM_ID: '700002' });
  assert.equal(missing.exitCode, 2);
  assert.equal(missing.report.reason, 'TARGET_ROOM_MISSING');
});

test('unknown target does not pass while partial coverage can still prove the chosen room', async t => {
  const unknownSource = await fixture(t, { online: false });
  const unknown = await unknownSource.run();
  assert.equal(unknown.exitCode, 2);
  assert.equal(unknown.report.reason, 'TARGET_LIVE_NOT_CONFIRMED');
  assert.equal(unknown.report.unknownCount, 1);

  const partialSource = await fixture(t, { coverage: false });
  const partial = await partialSource.run();
  assert.equal(partial.exitCode, 0);
  assert.equal(partial.report.reason, 'TARGET_LIVE_CONFIRMED');
  assert.equal(partial.report.coverage, 'PARTIAL');
  assert.equal(partial.report.liveCount, 1);
});

test('a duplicate target identity is blocked even when the accepted row appears live', async t => {
  const source = await fixture(t, { duplicate: true });
  const { report, exitCode } = await source.run();
  assert.equal(exitCode, 2);
  assert.equal(report.reason, 'TARGET_IDENTITY_CONFLICT');
});

test('a failed source reports the safe transport code and exits nonzero', async t => {
  const source = await fixture(t, { catalogUnavailable: true });
  const { report, exitCode } = await source.run();
  assert.equal(exitCode, 2);
  assert.equal(report.reason, 'SOURCE_UNAVAILABLE');
  assert.deepEqual(report.sourceCodes, ['HTTP_SERVER_ERROR']);
  assert.deepEqual(source.requests, [{ method: 'GET', path: SOURCE_ROUTES.rooms }]);
});
