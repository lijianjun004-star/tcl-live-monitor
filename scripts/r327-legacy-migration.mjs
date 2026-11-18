// Offline staging only. The normal or scheduled restore path never calls this tool.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {latestCompletedRun} from './restore-jd-fullday-state.mjs';
import {report, validateState} from '../probes/r327/jd-fullday.mjs';
import {withHistoryTransaction} from '../probes/lib/history-files.mjs';

const REPOSITORY = 'lijianjun004-star/tcl-live-monitor';
const WORKFLOW = '.github/workflows/jd-fullday-rate.yml';
const ARTIFACT = 'jd-fullday-state';
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024;
const RUN_FAILURES = new Set(['failure', 'cancelled', 'timed_out', 'startup_failure']);
const HEX_SHA = /^[a-f0-9]{40}$/;
const HEX_DIGEST = /^[a-f0-9]{64}$/;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const digest = value => typeof value === 'string' && HEX_DIGEST.test(value);
const headSha = value => typeof value === 'string' && HEX_SHA.test(value);
const fail = code => { throw new Error(code); };

function time(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(value)) fail('R327_MIGRATION_TIME_INVALID');
  const millis = Date.parse(value);
  const normalized = value.includes('.') ? value : value.replace(/Z$/, '.000Z');
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== normalized) fail('R327_MIGRATION_TIME_INVALID');
  return millis;
}

function safeDirectory(directory) {
  const absolute = path.resolve(directory);
  const stat = fs.lstatSync(absolute);
  const real = fs.realpathSync(absolute);
  const comparable = value => process.platform === 'win32' ? value.toLowerCase() : value;
  if (!stat.isDirectory() || stat.isSymbolicLink() || comparable(absolute) !== comparable(real)) fail('R327_MIGRATION_DIRECTORY_UNSAFE');
  return absolute;
}

function readRegular(file, limit) {
  const absolute = path.resolve(file);
  safeDirectory(path.dirname(absolute));
  const before = fs.lstatSync(absolute);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > limit) fail('R327_MIGRATION_INPUT_UNSAFE');
  const fd = fs.openSync(absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino ||
        opened.size !== before.size || opened.mtimeMs !== before.mtimeMs) fail('R327_MIGRATION_INPUT_CHANGED');
    const bytes = Buffer.alloc(opened.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = fs.readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    const after = fs.fstatSync(fd);
    if (length !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
      fail('R327_MIGRATION_INPUT_CHANGED');
    }
    return bytes.subarray(0, length);
  } finally { fs.closeSync(fd); }
}

function decode(bytes) {
  try { return JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(bytes)); }
  catch { return fail('R327_MIGRATION_JSON_INVALID'); }
}

const runRef = run => ({runId:run.id, runAttempt:run.run_attempt, headSha:run.head_sha});
const sameRun = (reference, run) => record(reference) && reference.runId === run.id &&
  reference.runAttempt === run.run_attempt && reference.headSha === run.head_sha;

function verifyEvidence(evidence, approval, now) {
  if (!record(evidence) || evidence.schemaVersion !== 1 || !record(evidence.runs) ||
      !record(evidence.artifactsByRun) || !record(approval) || approval.schemaVersion !== 1 ||
      approval.purpose !== 'R327_STAGE_HISTORICAL_CARRY_FORWARD' || approval.repository !== REPOSITORY ||
      approval.workflow !== WORKFLOW || typeof approval.approvalReference !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(approval.approvalReference)) fail('R327_MIGRATION_APPROVAL_INVALID');
  const observedAt = time(evidence.observedAt);
  const approvedAt = time(approval.approvedAt);
  const expiresAt = time(approval.expiresAt);
  if (!Number.isFinite(now) || observedAt > approvedAt || approvedAt > now ||
      now >= expiresAt || expiresAt <= approvedAt || expiresAt - observedAt > MAX_AGE_MS) fail('R327_MIGRATION_APPROVAL_EXPIRED');
  const runs = evidence.runs.workflow_runs;
  // The operator must collect every page in the selected completed-run interval.
  // Compare to the original API count rather than the size of the assembled list.
  if (!Array.isArray(runs) || runs.length < 2 || runs.length > 100 ||
      evidence.runs.total_count !== runs.length ||
      new Set(runs.map(run => run?.id)).size !== runs.length) fail('R327_MIGRATION_HISTORY_INCOMPLETE');

  // Reuse the normal restore's same-repository, main, workflow and run checks.
  const blocked = latestCompletedRun(evidence.runs);
  const runList = [...runs].sort((a,b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id);
  for (const run of runList) {
    if (!headSha(run.head_sha) || time(run.created_at) > time(run.updated_at) ||
        time(run.updated_at) > observedAt) fail('R327_MIGRATION_RUN_INVALID');
  }
  if (!RUN_FAILURES.has(blocked.conclusion) || !sameRun(approval.blockedRun, blocked)) {
    fail('R327_MIGRATION_BLOCKED_RUN_MISMATCH');
  }
  const successIndex = runList.findIndex(run => run.conclusion === 'success');
  if (successIndex < 1) fail('R327_MIGRATION_SOURCE_RUN_MISSING');
  const original = runList[successIndex];
  // Artifact metadata identifies the run but does not prove which rerun produced it.
  if (original.run_attempt !== 1) fail('R327_MIGRATION_SOURCE_ATTEMPT_UNSUPPORTED');
  if (!sameRun(approval.sourceRun, original)) fail('R327_MIGRATION_SOURCE_RUN_MISMATCH');

  const failures = runList.slice(0, successIndex);
  for (const failed of failures) {
    const listed = evidence.artifactsByRun[String(failed.id)];
    if (!RUN_FAILURES.has(failed.conclusion) || listed?.total_count !== 0 ||
        !Array.isArray(listed.artifacts) || listed.artifacts.length !== 0) fail('R327_MIGRATION_FAILURE_EVIDENCE_UNSAFE');
  }
  const listed = evidence.artifactsByRun[String(original.id)];
  if (listed?.total_count !== 1 || !Array.isArray(listed.artifacts) || listed.artifacts.length !== 1) {
    fail('R327_MIGRATION_ARTIFACT_AMBIGUOUS');
  }
  const artifact = listed.artifacts[0];
  if (artifact?.name !== ARTIFACT || artifact.expired !== false || !positive(artifact.id) ||
      artifact.id !== approval.artifactId || artifact.digest !== `sha256:${approval.archiveSha256}` ||
      !positive(artifact.size_in_bytes) || artifact.size_in_bytes > MAX_ARCHIVE_BYTES ||
      artifact.workflow_run?.id !== original.id || artifact.workflow_run.head_sha !== original.head_sha ||
      artifact.workflow_run.head_branch !== 'main' || artifact.workflow_run.repository_id !== original.repository.id ||
      artifact.workflow_run.head_repository_id !== original.head_repository.id ||
      time(artifact.created_at) < time(original.created_at) || time(artifact.created_at) > time(original.updated_at) ||
      time(artifact.expires_at) <= observedAt) fail('R327_MIGRATION_ARTIFACT_MISMATCH');
  return {blocked, original, failures, artifact, approvedAt};
}

function decodeArchive(bytes) {
  const reader = fileURLToPath(new URL('./r327-read-legacy-zip.py', import.meta.url));
  const proc = spawnSync(process.platform === 'win32' ? 'python' : 'python3', [reader], {
    input:bytes, encoding:'utf8', timeout:15000, maxBuffer:16 * 1024 * 1024, windowsHide:true,
  });
  if (proc.error || proc.status !== 0) fail('R327_MIGRATION_ARCHIVE_INVALID');
  return decode(Buffer.from(proc.stdout, 'utf8'));
}

function verifyLegacyReportRows(state, oldRows) {
  const expected = new Map(report(state).map(row => [`${row.date}/${row.roomId}`, row]));
  if (oldRows.length !== expected.size) fail('R327_MIGRATION_LEGACY_ROWS_MISMATCH');
  for (const old of oldRows) {
    if (!record(old) || typeof old.date !== 'string' || typeof old.roomId !== 'string') {
      fail('R327_MIGRATION_LEGACY_ROWS_MISMATCH');
    }
    const key = `${old.date}/${old.roomId}`;
    const row = expected.get(key);
    if (!row || old.totalDayMinutes !== row.totalDayMinutes || old.soFarMinutes !== row.soFarMinutes) {
      fail('R327_MIGRATION_LEGACY_ROWS_MISMATCH');
    }
    expected.delete(key);
  }
}

function historyProjection(legacy, oldReport, original) {
  if (!record(legacy) || !record(oldReport) || Object.hasOwn(legacy,'_historyCommit') ||
      Object.hasOwn(oldReport,'_historyCommitId') || legacy.window !== '08:00-24:00 Asia/Shanghai' ||
      !record(legacy.rooms) || !record(legacy.days) || !Array.isArray(oldReport.rows) ||
      !oldReport.rows.length || oldReport.rows.length > 4000 || !Object.keys(legacy.days).length ||
      Object.keys(legacy.days).length > 36 || !Object.keys(legacy.rooms).length || Object.keys(legacy.rooms).length > 100) {
    fail('R327_MIGRATION_NOT_LEGACY_PAIR');
  }
  validateState(legacy);
  if (oldReport.window !== legacy.window || oldReport.generatedAt !== legacy.lastRunAt ||
      time(legacy.lastRunAt) < time(original.created_at) || time(legacy.lastRunAt) > time(original.updated_at)) {
    fail('R327_MIGRATION_LEGACY_TIME_MISMATCH');
  }
  // Old artifacts lack a transaction ID. Check basic consistency, then ignore the
  // prior estimates and compute a new report solely from the projected state.
  verifyLegacyReportRows(legacy, oldReport.rows);
  let ambiguousZeroReadingsOmitted = 0;
  const projectReading = reading => {
    if (reading == null) return null;
    // The legacy writer substituted zero for missing days. Without a source
    // timestamp, a legacy zero cannot establish an observed duration.
    if (reading.minuteCount === 0 && reading.latestMinuteAt === null) {
      ambiguousZeroReadingsOmitted++;
      return null;
    }
    return {at:reading.at, minuteCount:reading.minuteCount, latestMinuteAt:reading.latestMinuteAt};
  };
  const days = Object.fromEntries(Object.entries(legacy.days).map(([date, rooms]) =>
    [date, Object.fromEntries(Object.entries(rooms).map(([id, slot]) => [id, {
      morning:projectReading(slot.morning), final:projectReading(slot.final), latest:projectReading(slot.latest),
    }]))]));
  const rooms = Object.fromEntries(Object.entries(legacy.rooms).map(([id, room]) => [id, {
    category:typeof room.category === 'string' ? room.category.slice(0,48) : '',
    captureBound:false, sourceStatus:'UNKNOWN', lastAttemptedAt:null, lastObservedAt:null,
  }]));
  const state = {
    schemaVersion:327, platform:'jd', window:legacy.window, rooms, days,
    lastRunAt:legacy.lastRunAt, lastAttemptedAt:null, lastSuccessfulSourceAt:null,
    sourceStatus:'UNKNOWN', formalAttendanceReady:false,
  };
  validateState(state);
  const rows = report(state);
  if (!rows.some(row => row.observedAt !== null)) fail('R327_MIGRATION_NO_HISTORICAL_READINGS');
  return {state, rows, ambiguousZeroReadingsOmitted};
}

export async function stageLegacyHistory({evidenceFile, approvalFile, archiveFile, outputDirectory, now=Date.now()}) {
  const approval = decode(readRegular(approvalFile, 64 * 1024));
  const evidenceBytes = readRegular(evidenceFile, 8 * 1024 * 1024);
  if (!digest(approval?.evidenceSha256) || sha256(evidenceBytes) !== approval.evidenceSha256 ||
      !digest(approval?.archiveSha256)) fail('R327_MIGRATION_DIGEST_MISMATCH');
  const evidence = decode(evidenceBytes);
  const {blocked, original, failures, artifact, approvedAt} = verifyEvidence(evidence, approval, now);
  const archive = readRegular(archiveFile, MAX_ARCHIVE_BYTES);
  if (archive.length !== artifact.size_in_bytes || sha256(archive) !== approval.archiveSha256) {
    fail('R327_MIGRATION_ARCHIVE_DIGEST_MISMATCH');
  }
  const pair = decodeArchive(archive);
  const {state, rows, ambiguousZeroReadingsOmitted} = historyProjection(pair['state.json'], pair['report.json'], original);

  const migration = {
    schemaVersion:1, stage:'OFFLINE_HISTORICAL_ONLY', approvalReference:approval.approvalReference,
    approvedAt:new Date(approvedAt).toISOString(), stagedAt:new Date(now).toISOString(),
    repository:REPOSITORY, workflow:WORKFLOW, sourceRun:runRef(original), artifactId:artifact.id,
    archiveSha256:approval.archiveSha256, evidenceSha256:approval.evidenceSha256,
    legacyReportCheck:'ROOM_DATE_AND_BASE_MINUTES_MATCH', legacyGenerationVerified:false, ambiguousZeroReadingsOmitted,
    blockedRun:runRef(blocked), failedRuns:failures.map(run => ({...runRef(run), conclusion:run.conclusion})),
  };
  const base = safeDirectory(outputDirectory);
  const target = path.join(base, `r327-migration-${blocked.id}-${blocked.run_attempt}`);
  // The same recovery workspace and blocked attempt can stage only once.
  // Leave the exclusive directory in place even on an interrupted publication.
  try { fs.mkdirSync(target, {mode:0o700}); }
  catch { fail('R327_MIGRATION_OUTPUT_ALREADY_RESERVED'); }
  await withHistoryTransaction({
    stateOutput:path.join(target,'historical-state.json'), summaryOutput:path.join(target,'historical-report.json'),
  }, () => ({
    state:{...state, historicalMigration:migration},
    summary:{
      generatedAt:state.lastRunAt, dataClassification:'HISTORICAL_ONLY', sourceStatus:'UNKNOWN',
      formalAttendanceReady:false, historicalMigration:migration, rows,
    },
  }));
  return {stage:migration.stage, blockedRun:runRef(blocked), historicalRun:runRef(original), stagedFiles:2};
}

async function main() {
  const [mode, evidenceFile, approvalFile, archiveFile, outputDirectory, ...extra] = process.argv.slice(2);
  if (mode !== 'stage' || !evidenceFile || !approvalFile || !archiveFile || !outputDirectory || extra.length) {
    console.error('Usage: node scripts/r327-legacy-migration.mjs stage EVIDENCE APPROVAL ARCHIVE OUTPUT_DIRECTORY');
    process.exitCode=2;
    return;
  }
  try { console.log(JSON.stringify(await stageLegacyHistory({evidenceFile, approvalFile, archiveFile, outputDirectory}))); }
  catch { console.error('R327_LEGACY_MIGRATION_BLOCKED'); process.exitCode=1; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
