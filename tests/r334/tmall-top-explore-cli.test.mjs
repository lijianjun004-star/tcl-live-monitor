import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { executeExplore, summaryText } from '../../probes/r334/tmall-top-explore-once.mjs';
const cli = fileURLToPath(new URL('../../probes/r334/tmall-top-explore-once.mjs', import.meta.url));
const SECRETS = /synthetic-key|synthetic-secret/;

async function run(env) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'top-explore-cli-'));
  try {
    const child = spawnSync(process.execPath, [cli], { cwd, env, encoding: 'utf8', timeout: 10000 });
    const receipt = JSON.parse(await fs.readFile(path.join(cwd, 'out/tmall-top-explore-receipt.json'), 'utf8'));
    return { child, receipt };
  } finally { await fs.rm(cwd, { recursive: true, force: true }); }
}

test('unarmed explore CLI makes no request even with credentials and a valid mode', async () => {
  const { child, receipt } = await run({ TOP_APP_KEY: 'synthetic-key', TOP_APP_SECRET: 'synthetic-secret', R334_TOP_MODE: 'venue' });
  assert.equal(child.status, 2);
  assert.equal(receipt.reason, 'NOT_ARMED'); assert.equal(receipt.requestsSent, 0); assert.deepEqual(receipt.registeredHits, []);
  assert.doesNotMatch(child.stdout + child.stderr + JSON.stringify(receipt), SECRETS);
});

test('armed explore CLI persists a blocked receipt when credentials or the mode are missing', async () => {
  const { child, receipt } = await run({ R334_TOP_EXPLORE: 'AUTHORIZED_STRUCTURE_READ' });
  assert.equal(child.status, 2);
  assert.equal(receipt.status, 'BLOCKED'); assert.equal(receipt.requestsSent, 0); assert.equal(receipt.credentialsConfigured, false);
  assert.deepEqual(receipt.blockers, ['MODE_INVALID', 'TOP_CREDENTIALS_MISSING']);
  assert.equal(child.stderr, ''); assert.match(child.stdout, /R334_TOP_EXPLORE_RESULT /);
});

test('armed explore CLI with credentials still sends nothing for an invalid mode, incomplete pair or invalid option', async () => {
  const armed = { R334_TOP_EXPLORE: 'AUTHORIZED_STRUCTURE_READ', TOP_APP_KEY: 'synthetic-key', TOP_APP_SECRET: 'synthetic-secret' };
  for (const extra of [{ R334_TOP_MODE: 'bogus' }, { R334_TOP_MODE: 'contents', R334_TOP_QUERY_DATE: 'not-a-date' },
    { R334_TOP_MODE: 'venue', R334_TOP_SCENE: 'two words' }, { R334_TOP_MODE: 'contents', R334_TOP_PAGE_SIZE: '1000' }]) {
    const { child, receipt } = await run({ ...armed, ...extra });
    assert.equal(child.status, 2, JSON.stringify(extra)); assert.equal(receipt.status, 'BLOCKED'); assert.equal(receipt.requestsSent, 0);
    assert.equal(receipt.credentialsConfigured, true);
    assert.doesNotMatch(child.stdout + JSON.stringify(receipt), SECRETS);
  }
  const { receipt } = await run({ R334_TOP_EXPLORE: 'AUTHORIZED_STRUCTURE_READ', R334_TOP_MODE: 'venue', TOP_APP_KEY: 'synthetic-key', TAOBAO_APP_SECRET: 'synthetic-secret' });
  assert.equal(receipt.credentialsConfigured, false); assert.equal(receipt.requestsSent, 0);
});

test('armed explore run reads the committed registry, makes one injected request and writes receipt and summary', async () => {
  const cfg = JSON.parse(await fs.readFile(new URL('../../config/probe-targets.json', import.meta.url), 'utf8'));
  const registered = cfg.tmall[0].accountId;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'top-explore-run-'));
  try {
    let calls = 0, body;
    const summary = path.join(dir, 'summary.md');
    const env = { R334_TOP_EXPLORE: 'AUTHORIZED_STRUCTURE_READ', R334_TOP_MODE: 'contents', R334_TOP_PAGE_SIZE: '5', R334_TOP_QUERY_DATE: '20261110',
      TOP_APP_KEY: 'synthetic-key', TOP_APP_SECRET: 'synthetic-secret', GITHUB_STEP_SUMMARY: summary };
    const result = await executeExplore({ env, outputDir: path.join(dir, 'out'), now: new Date('2026-11-16T00:00:00Z'), fetchFn: async (url, options) => {
      calls++; body = Object.fromEntries(new URLSearchParams(options.body));
      return new Response(JSON.stringify({ taobao_live_contents_query_response: { model: { total_count: 1,
        data_json_str: JSON.stringify([{ liveId: '777000000001', anchorId: registered, title: 'PRIVATE_TITLE' }]) } } }));
    } });
    assert.equal(calls, 1); assert.equal(result.status, 'EXPLORED'); assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(body.query_request), { query_date: '20261110', start: 0, page_size: 5 });
    assert.equal(result.registeredHits.length, 1); assert.equal(result.registeredHits[0].ids.liveId, '777000000001');
    const saved = JSON.parse(await fs.readFile(path.join(dir, 'out/tmall-top-explore-receipt.json'), 'utf8'));
    assert.deepEqual(saved, JSON.parse(JSON.stringify(result)));
    const shown = await fs.readFile(summary, 'utf8');
    assert.match(shown, /Official TOP structure probe/); assert.match(shown, /does not verify account coverage/);
    assert.doesNotMatch(shown + JSON.stringify(saved), /PRIVATE_TITLE|synthetic-key|synthetic-secret/);
    assert.deepEqual((await fs.readdir(path.join(dir, 'out'))).sort(), ['tmall-top-explore-receipt.json']);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('step summaries stay below the platform limit while the artifact keeps the full receipt', () => {
  const small = { status: 'EXPLORED', shape: { a: 'string' } };
  assert.equal(summaryText(small), JSON.stringify(small, null, 2));
  const huge = { status: 'EXPLORED', shape: { a: 'x'.repeat(500_000) }, registeredHits: [{ key: 'synthetic-a' }] };
  const shown = summaryText(huge);
  assert.ok(shown.length < 1000); assert.match(shown, /omitted here because of size/); assert.match(shown, /synthetic-a/);
});
