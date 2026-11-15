// Explicit manual structure probe via an owned TOP application. Never imports into the production ledger.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runTopExplore } from './tmall-top-explore.mjs';

// GitHub caps a step summary at 1 MiB; the full receipt always goes to the artifact file.
const SUMMARY_LIMIT = 400_000;

export function summaryText(result) {
  const full = JSON.stringify(result, null, 2);
  return full.length > SUMMARY_LIMIT ? JSON.stringify({ ...result, shape: '(omitted here because of size; see the artifact)' }, null, 2) : full;
}

export async function executeExplore({ env = process.env, outputDir = 'out', fetchFn, now = new Date() } = {}) {
  let result;
  if (env.R334_TOP_EXPLORE !== 'AUTHORIZED_STRUCTURE_READ') {
    result = { schemaVersion: 334, source: 'TAOBAO_TOP', kind: 'STRUCTURE_PROBE', mode: null, method: null, at: now.toISOString(),
      status: 'BLOCKED', reason: 'NOT_ARMED', blockers: ['NOT_ARMED'], requestsSent: 0, request: null, registeredHits: [], exitCode: 2 };
  } else {
    const cfg = JSON.parse(await fs.readFile(new URL('../../config/probe-targets.json', import.meta.url), 'utf8'));
    if (!Array.isArray(cfg.tmall) || cfg.tmall.length < 1 || cfg.tmall.length > 12 ||
        cfg.tmall.some(t => !(t.userConfirmed === true || t.scopeApproved === true))) throw Error('INVALID_TARGET_REGISTRY');
    result = await runTopExplore({ mode: env.R334_TOP_MODE, env, targets: cfg.tmall, fetchFn, now, options: {
      scene: env.R334_TOP_SCENE, liveSource: env.R334_TOP_LIVE_SOURCE, ruleCode: env.R334_TOP_RULE_CODE,
      count: env.R334_TOP_VENUE_COUNT, page: env.R334_TOP_VENUE_PAGE,
      queryDate: env.R334_TOP_QUERY_DATE, start: env.R334_TOP_START, pageSize: env.R334_TOP_PAGE_SIZE } });
  }
  await fs.mkdir(outputDir, { recursive: true });
  const destination = path.join(outputDir, 'tmall-top-explore-receipt.json');
  const temporary = destination + '.tmp';
  await fs.writeFile(temporary, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  await fs.rename(temporary, destination);
  if (env.GITHUB_STEP_SUMMARY) {
    await fs.appendFile(env.GITHUB_STEP_SUMMARY,
      '## Official TOP structure probe: actual result\n\n```json\n' + summaryText(result) +
      '\n```\n\nThis records response structure only. It does not verify account coverage, discover future sessions, or prove that an account is offline.\n');
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = await executeExplore();
    console.log('R334_TOP_EXPLORE_RESULT ' + JSON.stringify({ ...result, shape: undefined }));
    process.exitCode = result.exitCode;
  } catch {
    // Never log upstream error messages, signed URLs, environment values, or raw response bodies.
    console.error('R334_TOP_EXPLORE_INTERNAL_ERROR');
    process.exitCode = 1;
  }
}
