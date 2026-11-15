// Explicit manual query via an owned TOP application. Never imports into the production ledger.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runTopBatch } from './tmall-top.mjs';

export async function executeOnce({ env = process.env, outputDir = 'out', fetchFn, now = new Date() } = {}) {
  let result;
  if (env.R334_TOP_ONCE !== 'AUTHORIZED_OFFICIAL_READ') {
    result = { schemaVersion: 334, source: 'TAOBAO_TOP', method: 'taobao.live.batchlives.get', at: now.toISOString(),
      status: 'BLOCKED', reason: 'NOT_ARMED', blockers: ['NOT_ARMED'], requestsSent: 0,
      verifiedRecordCount: 0, verifiedLiveCount: 0, allRequestedVerified: false, observations: [], exitCode: 2 };
  } else {
    const cfg = JSON.parse(await fs.readFile(new URL('../../config/probe-targets.json', import.meta.url), 'utf8'));
    if (!Array.isArray(cfg.tmall) || cfg.tmall.length < 1 || cfg.tmall.length > 12 ||
        cfg.tmall.some(t => !(t.userConfirmed === true || t.scopeApproved === true))) throw Error('INVALID_TARGET_REGISTRY');
    result = await runTopBatch({ env, liveIdsInput: env.R334_TOP_LIVE_IDS || env.TOP_LIVE_IDS || '', targets: cfg.tmall, fetchFn, now });
  }
  await fs.mkdir(outputDir, { recursive: true });
  const destination = path.join(outputDir, 'tmall-top-receipt.json');
  const temporary = destination + '.tmp';
  await fs.writeFile(temporary, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  await fs.rename(temporary, destination);
  if (env.GITHUB_STEP_SUMMARY) {
    await fs.appendFile(env.GITHUB_STEP_SUMMARY,
      '## Official TOP query: actual result\n\n```json\n' + JSON.stringify(result, null, 2) +
      '\n```\n\nVERIFIED describes only the requested sessions. It does not prove the account is currently offline, discover future sessions, or verify full-day coverage.\n');
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = await executeOnce();
    console.log('R334_TOP_RESULT ' + JSON.stringify(result));
    process.exitCode = result.exitCode;
  } catch {
    // Never log upstream error messages, signed URLs, environment values, or raw response bodies.
    console.error('R334_TOP_INTERNAL_ERROR');
    process.exitCode = 1;
  }
}
