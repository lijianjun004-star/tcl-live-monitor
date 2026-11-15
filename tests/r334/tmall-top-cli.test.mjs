import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const cli = fileURLToPath(new URL('../../probes/r334/tmall-top-once.mjs', import.meta.url));

async function run(env) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'top-cli-'));
  try {
    const child = spawnSync(process.execPath, [cli], { cwd, env, encoding: 'utf8', timeout: 10000 });
    const receipt = JSON.parse(await fs.readFile(path.join(cwd, 'out/tmall-top-receipt.json'), 'utf8'));
    return { child, receipt };
  } finally { await fs.rm(cwd, { recursive: true, force: true }); }
}
test('unarmed CLI makes no request even with supplied application values', async () => {
  const { child, receipt } = await run({ TOP_APP_KEY: 'synthetic-key', TOP_APP_SECRET: 'synthetic-secret', R334_TOP_LIVE_IDS: '90000000000001' });
  assert.equal(child.status, 2);
  assert.equal(receipt.reason, 'NOT_ARMED');
  assert.equal(receipt.requestsSent, 0);
  assert.equal(receipt.allRequestedVerified, false);
  assert.doesNotMatch(child.stdout + JSON.stringify(receipt), /synthetic-key|synthetic-secret/);
});
test('armed CLI persists a blocked receipt for missing credentials and real live IDs', async () => {
  const { child, receipt } = await run({ R334_TOP_ONCE: 'AUTHORIZED_OFFICIAL_READ' });
  assert.equal(child.status, 2);
  assert.equal(receipt.status, 'BLOCKED');
  assert.equal(receipt.credentialsConfigured, false);
  assert.equal(receipt.liveIdsConfigured, false);
  assert.equal(receipt.requestsSent, 0);
  assert.equal(receipt.verifiedRecordCount, 0);
  assert.equal(receipt.blockers.length, 2);
  assert.equal(child.stderr, '');
  assert.match(child.stdout, /R334_TOP_RESULT /);
});
test('incomplete credential pairs cannot be combined and roomNumber cannot become live_id', async () => {
  const { child, receipt } = await run({ R334_TOP_ONCE: 'AUTHORIZED_OFFICIAL_READ', TOP_APP_KEY: 'key-one', TAOBAO_APP_SECRET: 'secret-two', R334_TOP_LIVE_IDS: '130742' });
  assert.equal(child.status, 2);
  assert.equal(receipt.status, 'BLOCKED');
  assert.equal(receipt.credentialsConfigured, false);
  assert.equal(receipt.requestsSent, 0);
  assert.doesNotMatch(child.stdout + JSON.stringify(receipt), /key-one|secret-two/);
});
