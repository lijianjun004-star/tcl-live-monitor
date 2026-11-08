import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { normalizeObservation } from '../schema.mjs';
import { rebuildSessions } from '../core/sessions.mjs';
import { nextEligibleAt } from '../core/scheduler.mjs';

export const STORE_SCHEMA_VERSION = 2;
export class StoreConflict extends Error {}
export class StoreCorruption extends Error {}
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const empty = () => ({ schema_version: STORE_SCHEMA_VERSION, revision: 0, observations: [], sessions: [], evidence: [], checks: {}, cooldowns: {} });
const encode = data => JSON.stringify({ checksum: hash(data), data });
function decode(content) {
  let envelope;
  try { envelope = JSON.parse(content); } catch { throw new StoreCorruption('Invalid store JSON; explicit backup recovery required'); }
  const { data, checksum } = envelope;
  if (!data || checksum !== hash(data)) throw new StoreCorruption('Store checksum mismatch');
  if (![1, 2].includes(data.schema_version)) throw new StoreCorruption('Unsupported schema version');
  if (!Array.isArray(data.observations) || !Number.isSafeInteger(data.revision)) throw new StoreCorruption('Invalid store shape');
  if (data.schema_version === 1) {
    // v1 has the same normalized observations, but no persisted derived indexes.
    const observations = data.observations.map(row => ({ ...row, observation_id: row.observation_id ?? hash(row) }));
    return { ...empty(), ...data, observations, schema_version: 2, sessions: rebuildSessions(observations), checks: data.checks ?? Object.fromEntries(observations.map(row => [row.observation_id, row.observation_id])), cooldowns: data.cooldowns ?? {}, evidence: data.evidence ?? [] };
  }
  if (!Array.isArray(data.sessions) || !Array.isArray(data.evidence) || !data.checks || !data.cooldowns) throw new StoreCorruption('Invalid store indexes');
  return data;
}

/** One snapshot transaction commits observations, sessions, evidence and idempotency together. */
export class DurableStore {
  constructor(directory) {
    this.directory = path.resolve(directory);
    this.file = path.join(this.directory, 'state.json');
    this.backup_file = path.join(this.directory, 'state.backup.json');
    this.lock_file = path.join(this.directory, '.write.lock');
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
  }
  snapshot() { return fs.existsSync(this.file) ? decode(fs.readFileSync(this.file, 'utf8')) : empty(); }
  verify() { const s = this.snapshot(); return { valid: true, schema_version: s.schema_version, revision: s.revision, observations: s.observations.length }; }
  acquireTarget(storeKey) {
    const file = path.join(this.directory, `.source-${hash(storeKey)}.lock`);
    let fd;
    try { fd = fs.openSync(file, 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') throw new StoreConflict('Target source check already running; inspect stale source locks manually'); throw error; }
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid }));
    fs.closeSync(fd);
    return () => fs.unlinkSync(file);
  }
  withLock(fn) {
    let fd;
    try { fd = fs.openSync(this.lock_file, 'wx', 0o600); }
    catch (err) {
      if (err.code !== 'EEXIST') throw err;
      // No timer-based lock theft: a live or unidentified owner always blocks.
      let owner;
      try { owner = JSON.parse(fs.readFileSync(this.lock_file, 'utf8')); } catch { throw new StoreConflict('Unidentified writer lock; inspect manually'); }
      if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new StoreConflict('Invalid writer lock');
      try { process.kill(owner.pid, 0); throw new StoreConflict('Concurrent writer'); }
      catch (probe) {
        if (probe.code !== 'ESRCH') throw probe;
        fs.unlinkSync(this.lock_file);
        return this.withLock(fn);
      }
    }
    try {
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid })); fs.fsyncSync(fd);
      // Orphan temp files cannot supersede the last committed snapshot.
      for (const name of fs.readdirSync(this.directory)) if (/^\.txn-[a-f0-9-]+$/.test(name)) fs.unlinkSync(path.join(this.directory, name));
      return fn();
    } finally { fs.closeSync(fd); fs.unlinkSync(this.lock_file); }
  }
  atomicWrite(destination, content) {
    const temporary = path.join(this.directory, `.txn-${randomUUID()}`);
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, destination);
    const dir = fs.openSync(this.directory, 'r');
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  }
  backup() { return this.withLock(() => { const s = this.snapshot(); this.atomicWrite(this.backup_file, encode(s)); return this.backup_file; }); }
  recoverBackup() {
    return this.withLock(() => {
      const s = decode(fs.readFileSync(this.backup_file, 'utf8'));
      if (fs.existsSync(this.file)) fs.renameSync(this.file, path.join(this.directory, `state.corrupt-${randomUUID()}.json`));
      this.atomicWrite(this.file, encode(s));
      return s;
    });
  }
  record(input, { check, evidence, expected_revision, cooldown_ms = 3_600_000 } = {}) {
    return this.withLock(() => {
      const state = this.snapshot();
      if (expected_revision !== undefined && state.revision !== expected_revision) throw new StoreConflict('Revision conflict');
      let o = normalizeObservation(input, { now: input.actual_check_at, expectedAccountId: input.platform === 'tmall' ? '2050532947' : check?.account_id });
      if (!o.actual_check_at || !o.planned_check_at) throw new TypeError('Observation requires valid timestamps');
      if (check && !/^[a-f0-9]{64}$/.test(check.check_id)) throw new TypeError('Invalid check identifier');
      const key = check?.check_id ?? hash(o);
      if (state.checks[key]) return { duplicate: true, observation: state.observations.find(row => row.observation_id === state.checks[key]), snapshot: state };
      if (check && (o.store_key !== check.store_key || o.planned_check_at !== check.planned_check_at || o.actual_check_at !== check.actual_check_at)) throw new StoreConflict('Check/observation mismatch');
      o = { ...o, observation_id: key };
      const simultaneous = state.observations.filter(row => row.store_key === o.store_key && row.actual_check_at === o.actual_check_at);
      const contradiction = simultaneous.some(row => row.failure_code === 'CONFLICTING_EVIDENCE' || (row.source_attested && o.source_attested && (row.state !== o.state || (row.state === 'LIVE' && row.live_id !== o.live_id))));
      if (contradiction) {
        o = { ...o, state: 'UNKNOWN', source_attested: false, failure_code: 'CONFLICTING_EVIDENCE' };
        for (const row of simultaneous) Object.assign(row, { state: 'UNKNOWN', source_attested: false, failure_code: 'CONFLICTING_EVIDENCE' });
      }
      state.observations.push(o);
      state.checks[key] = key;
      state.sessions = rebuildSessions(state.observations);
      if (evidence) {
        // Only explicit safe summary fields are durable. No raw URLs/body/headers/storage.
        const safe = { evidence_id: o.evidence_ref ?? key, observation_id: key, captured_at: o.actual_check_at };
        if (Number.isInteger(evidence.http_status)) safe.http_status = evidence.http_status;
        if (/^[a-f0-9]{64}$/.test(evidence.body_sha256 ?? '')) safe.body_sha256 = evidence.body_sha256;
        if (/^[A-Z0-9_:-]{1,100}$/.test(evidence.reason_code ?? '')) safe.reason_code = evidence.reason_code;
        state.evidence.push(safe);
      }
      if (o.failure_code && o.failure_code !== 'COOLDOWN_ACTIVE') state.cooldowns[o.store_key] = { failure_code: o.failure_code, next_eligible_at: nextEligibleAt(o.actual_check_at, cooldown_ms) };
      else if (o.state !== 'UNKNOWN') delete state.cooldowns[o.store_key];
      state.revision += 1;
      if (fs.existsSync(this.file)) this.atomicWrite(this.backup_file, fs.readFileSync(this.file, 'utf8'));
      this.atomicWrite(this.file, encode(state));
      return { duplicate: false, observation: o, snapshot: state };
    });
  }
}
// All three views deliberately share the same transaction boundary.
export class ObservationStore extends DurableStore { list() { return this.snapshot().observations; } }
export class SessionStore extends DurableStore { list() { return this.snapshot().sessions; } }
export class EvidenceStore extends DurableStore { list() { return this.snapshot().evidence; } }
