/**
 * R3.16 one-shot runner that the R3.15 switch plan hands READY targets to.
 * Start -> read the source once -> evaluate -> build ONE result -> exit. No timers, no polling.
 *
 * Fail-closed rules enforced here (on top of the existing JD / Douyin scanners):
 * - HTTP 401/403/429 on any request stops every further request of the run (ACCESS_LIMIT_*).
 * - Rooms seen before but missing now are kept as UNKNOWN (NOT_IN_CURRENT_SOURCE), never deleted/OFFLINE.
 * - Rooms not in the reviewed baseline are reported as NEW_ROOM_PENDING_IDENTITY_REVIEW and are
 *   excluded from formal counts until a human reviews them.
 * - No OFFLINE is produced: the R3.16 real counter-example (minute feed stopped while the visual
 *   capture kept reporting) shows minute staleness is not a stop signal. offlineRuleValidated=false.
 * - A run key already processed is skipped (idempotent re-delivery).
 * - Whole run has a deadline; on timeout the platform result is UNKNOWN, not partial success.
 */
import { scanJdSource, networkReader, SOURCE_ROUTES } from '../lib/tcl-jd-all.mjs';
import { scanDouyinOps } from '../r36/douyin-ops-parity.mjs';
import { reconcileDouyinCatalog } from '../r311/douyin-catalog-reconcile.mjs';

export const RUNNER_READY = Object.freeze({ jd: true, douyin: true });
// Reviewed internal JD rooms (R0.7–R3.15 evidence). A room outside this set is new and needs review.
export const JD_REVIEWED_BASELINE = Object.freeze(['1', '14', '15', '16', '17', '18']);
export const DOUYIN_HISTORICAL_MINIMUM = 10;
const ACCESS_LIMIT = new Set([401, 403, 429]);
const safeId = v => /^[1-9]\d{0,15}$/.test(String(v ?? '')) ? String(v) : null;

/** All remote access errors latch a global stop; no further source requests are permitted. */
export function guardedFetch(fetchFn, guard) {
  if (typeof fetchFn !== 'function' || !guard || typeof guard !== 'object') throw Error('GUARD_INPUT_INVALID');
  guard.requests = 0;
  return async (url, init = {}) => {
    if (guard.stopped) throw Error('ACCESS_STOPPED_' + (guard.stopped.reason || 'SOURCE_ERROR'));
    if (String(init.method || 'GET').toUpperCase() !== 'GET') throw Error('ONLY_GET_ALLOWED');
    const path = new URL(String(url)).pathname;
    const stop = (reason, status = null) => {
      guard.stopped ||= { reason, status, path };
      if (guard.controller && !guard.controller.signal.aborted) guard.controller.abort();
      throw Error(reason);
    };
    guard.requests++;
    let r;
    try {
      const signal = guard.controller ? AbortSignal.any([init.signal, guard.controller.signal].filter(Boolean)) : init.signal;
      r = await fetchFn(url, { ...init, redirect: 'error', signal });
    } catch (e) {
      const reason = e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'SOURCE_TIMEOUT_OR_ABORT' : 'SOURCE_NETWORK_OR_REDIRECT_ERROR';
      stop(reason);
    }
    if (ACCESS_LIMIT.has(r?.status)) stop('ACCESS_LIMIT_' + r.status, r.status);
    if (r?.status !== 200) stop(r?.status >= 300 && r?.status < 400 ? 'SOURCE_REDIRECT' : 'SOURCE_HTTP_' + (r?.status ?? 'UNKNOWN'), r?.status);
    if (!/json/i.test(r.headers?.get?.('content-type') || '')) stop('SOURCE_NON_JSON_RESPONSE');
    return r;
  };
}

/** Keep every previously seen room; flag new ones. Pure. */
export function protectCatalog({ currentRooms, previousRoomIds = [], reviewedBaseline = [], minimum = 0 }) {
  if (!Array.isArray(currentRooms) || !Array.isArray(previousRoomIds) || !Array.isArray(reviewedBaseline)) throw Error('CATALOG_INPUT_INVALID');
  const seen = new Map();
  for (const r of currentRooms) {
    const id = safeId(r?.roomId);
    if (!id) throw Error('CURRENT_ROOM_ID_INVALID');
    if (seen.has(id)) throw Error('CURRENT_ROOM_DUPLICATE');
    seen.set(id, { ...r, roomId: id, seenInCurrentSource: true });
  }
  const reviewed = new Set(reviewedBaseline.map(String));
  const rows = [...seen.values()].map(r => ({ ...r, newRoomPendingReview: reviewed.size > 0 && !reviewed.has(r.roomId),
    formalEligible: reviewed.size === 0 ? false : reviewed.has(r.roomId) }));
  const missing = [];
  for (const raw of new Set([...previousRoomIds.map(String), ...reviewed])) {
    const id = safeId(raw);
    if (!id || seen.has(id)) continue;
    missing.push(id);
    rows.push({ roomId: id, status: 'UNKNOWN', reason: 'NOT_IN_CURRENT_SOURCE', seenInCurrentSource: false, newRoomPendingReview: false, formalEligible: reviewed.has(id) });
  }
  rows.sort((a, b) => a.roomId.localeCompare(b.roomId, 'en', { numeric: true }));
  const warnings = [];
  if (missing.length) warnings.push('PREVIOUS_ROOMS_MISSING_KEPT_UNKNOWN');
  if (seen.size < minimum) warnings.push('BELOW_HISTORICAL_MINIMUM_NOT_PROOF_OF_DELETION');
  if (rows.some(r => r.newRoomPendingReview)) warnings.push('NEW_ROOM_PENDING_IDENTITY_REVIEW');
  return { rows, missingCount: missing.length, newCount: rows.filter(r => r.newRoomPendingReview).length, warnings };
}

/** Sampling-based session evidence. Never claims exact start/end; no platform liveId exists in the source. */
export function sessionEvidence(prev, cur, at) {
  const iso = new Date(at).toISOString();
  const sameDay = prev && prev.date === cur.date;
  const out = { date: cur.date, sessionCountToday: Number.isInteger(cur.sessionCount) ? cur.sessionCount : null,
    firstSeenLiveAt: sameDay ? prev.firstSeenLiveAt ?? null : null, lastSeenLiveAt: sameDay ? prev.lastSeenLiveAt ?? null : null,
    platformLiveId: null, exactStartAt: null, exactEndAt: null, event: null };
  if (cur.status === 'LIVE') { out.firstSeenLiveAt ??= iso; out.lastSeenLiveAt = iso; }
  if (sameDay && Number.isInteger(prev.sessionCountToday) && Number.isInteger(out.sessionCountToday) && out.sessionCountToday > prev.sessionCountToday)
    out.event = 'PLATFORM_SESSION_COUNT_INCREASED';
  return out;
}

/**
 * Stable delivery key for one requested scan. A retry of the same manual dispatch
 * must not create a second source read. The scheduled key uses the Beijing slot.
 * A delay of 60+ minutes is not provably attributable from wall clock alone.
 */
export const SCHEDULE_SLOT_MINUTE = 35;
export function deliveryKey({ eventName, runId, now }) {
  const t = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(t)) throw Error('DELIVERY_CLOCK_INVALID');
  if (eventName === 'schedule') return 'sched.' + new Date(t - SCHEDULE_SLOT_MINUTE * 60000 + 8 * 3600000).toISOString().slice(0,13).replace('T','.');
  if (!/^[0-9]{1,20}$/.test(String(runId ?? ''))) throw Error('DELIVERY_RUN_ID_INVALID');
  return 'run.' + runId;
}

// A single bounded deadline (not a poll): cleared as soon as the read settles.
const deadline = (p, ms, stop) => { let t; return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => { stop(); rej(Error('RUN_DEADLINE_EXCEEDED')); }, ms); })]).finally(() => clearTimeout(t)); };

export async function runJdOnce({ reader, at, date, previous = null, reviewedBaseline = JD_REVIEWED_BASELINE }) {
  const report = await scanJdSource({ reader, at, date, previous: previous?.minuteSnapshot ?? null });
  if (report.catalogStatus === 'UNAVAILABLE') return { platform: 'jd', status: 'SOURCE_UNAVAILABLE', warnings: report.warnings, rows: [], summary: { LIVE: 0, OFFLINE: 0, UNKNOWN: 0 } };
  const prot = protectCatalog({ currentRooms: report.rooms, previousRoomIds: previous?.roomIds ?? [], reviewedBaseline });
  const prevSess = new Map((previous?.sessions ?? []).map(s => [s.roomId, s]));
  const rows = prot.rows.map(r => {
    const status = r.status === 'OFFLINE' ? 'UNKNOWN' : r.status; // belt and braces
    return { ...r, status, sessions: sessionEvidence(prevSess.get(r.roomId), { date: report.date, status, sessionCount: r.sessionCount ?? null }, at) };
  });
  const summary = rows.reduce((s, r) => (s[r.status] = (s[r.status] || 0) + 1, s), { LIVE: 0, OFFLINE: 0, UNKNOWN: 0 });
  return { platform: 'jd', status: 'READ_ONCE', checkedAt: report.checkedAt, date: report.date, catalogStatus: report.catalogStatus,
    shopJoinStatus: report.shopJoinStatus, warnings: [...report.warnings, ...prot.warnings], rows, summary,
    formalSummary: rows.filter(r => r.formalEligible).reduce((s, r) => (s[r.status] = (s[r.status] || 0) + 1, s), { LIVE: 0, OFFLINE: 0, UNKNOWN: 0 }),
    newRooms: prot.newCount, missingRooms: prot.missingCount, offlineRuleValidated: false,
    formalOpeningRatePercent: null, formalFullDurationRatePercent: null };
}

export async function runDouyinOnce({ reader, config, at, previous = null, rpaObservations = [], bridgeEvidence = [] }) {
  const source = await scanDouyinOps({ reader, config, at, maxRooms: 60 });
  const inv = reconcileDouyinCatalog({ sourceReport: source, previousInventory: previous?.inventory ?? null,
    approvedAccounts: config.douyin, rpaObservations, bridgeEvidence, historicalConfirmedMinimum: DOUYIN_HISTORICAL_MINIMUM, now: at });
  const byId = new Map((source.rooms || []).map(r => [r.roomId, r]));
  const rows = inv.rooms.map(r => ({ roomId: r.roomId, shopId: r.shopId, captureBound: r.captureBound,
    opsShopIdentityMatched: r.opsShopIdentityMatched, seenInCurrentSource: r.seenInCurrentResponse,
    status: 'UNKNOWN', // internal Douyin source never proves public LIVE; four-layer bridge is required
    reason: byId.get(r.roomId)?.reason ?? r.opsSourceReason, internalSourceLiveCandidate: r.opsSourceState === 'LIVE',
    bridge: r.bridgeStatus || 'NO_EVIDENCE' }));
  const baselineMissing = !previous?.inventory && inv.inventoryRows < DOUYIN_HISTORICAL_MINIMUM;
  return { platform: 'douyin', status: source.sourceAccess !== 'ROOM_CATALOG_RECEIVED' ? 'SOURCE_UNAVAILABLE' :
    baselineMissing ? 'BLOCKED_BASELINE_NOT_RESTORED' : 'READ_ONCE',
    checkedAt: source.checkedAt, date: source.date, warnings: [...(source.warnings || []), ...inv.warnings, ...(baselineMissing ? ['DONT_DROP_HISTORICAL_ROOMS_WITHOUT_ENCRYPTED_BASELINE'] : [])], rows,
    summary: { LIVE: 0, OFFLINE: 0, UNKNOWN: rows.length }, inventory: { platform: 'douyin', rooms: inv.rooms },
    counts: { observed: inv.observedSourceRoomsThisRun, inventoryRows: inv.inventoryRows, shopJoined: inv.sourceShopJoined,
      captureBound: inv.sourceCaptureBound, verifiedBridges: inv.verifiedFourLayerBridges, bridgeStates: inv.bridgeStates,
      missingPrior: inv.missingPriorRoomCount },
    formalOpeningRatePercent: null, formalFullDurationRatePercent: null };
}

/**
 * Execute exactly the READY targets of a switch plan, once each.
 * @param plan  summary produced by runtime-switch-cli (decision/targets)
 * @param runKey stable key of this delivery (e.g. `${GITHUB_RUN_ID}.${GITHUB_RUN_ATTEMPT}`)
 */
export async function executePlan({ plan, runKey, origin, fetchFn = globalThis.fetch, config, previous = {}, at = Date.now(), deadlineMs = 150000, jdReviewedBaseline = JD_REVIEWED_BASELINE }) {
  if (!plan || !Array.isArray(plan.targets)) throw Error('PLAN_INVALID');
  if (typeof runKey !== 'string' || !/^[\w.-]{1,80}$/.test(runKey)) throw Error('RUN_KEY_INVALID');
  const out = { schemaVersion: 316, runKey, startedAt: new Date(at).toISOString(), decision: plan.decision, results: [], processModel: 'ONE_SHOT_THEN_EXIT', continuousPolling: false };
  if (plan.decision !== 'ONE_SHOT') { out.results = plan.targets.map(t => ({ platform: t.platform, status: t.status || 'NOT_RUN', reason: t.reason || plan.reason || null, sourceAccess: false })); return out; }
  for (const t of plan.targets) {
    if (t.status !== 'READY_FOR_SINGLE_SCAN' || RUNNER_READY[t.platform] !== true) { out.results.push({ platform: t.platform, status: t.status || 'BLOCKED', reason: t.reason || 'RUNNER_NOT_READY', sourceAccess: false }); continue; }
    const prev = previous?.[t.platform] ?? null;
    if (prev?.lastRunKey === runKey) { out.results.push({ platform: t.platform, status: 'SKIPPED_DUPLICATE_RUN', reason: 'RUN_KEY_ALREADY_PROCESSED', sourceAccess: false }); continue; }
    const controller = new AbortController();
    const guard = { controller };
    const rawReader = networkReader(origin, guardedFetch(fetchFn, guard), 15000);
    // Network readers can reject malformed JSON after fetch succeeds. Treat that as a
    // run-level source failure, not as a per-room absence or an OFFLINE signal.
    const reader = async (...args) => {
      if (guard.stopped) throw Error(guard.stopped.reason || 'SOURCE_STOPPED');
      try {
        const doc=await rawReader(...args);
        const [path]=args;
        const arrays={
          [SOURCE_ROUTES.rooms]: [doc?.rooms, doc?.data?.rooms, doc?.data?.list, doc?.list],
          [SOURCE_ROUTES.shops]: [doc, doc?.shops, doc?.data?.shops, doc?.data?.list, doc?.list],
          [SOURCE_ROUTES.heartbeats]: [doc?.rooms, doc?.data?.rooms, doc?.data?.list, doc?.list],
          [SOURCE_ROUTES.daily]: [doc?.days, doc?.data?.days],
        };
        if (!arrays[path]?.some(Array.isArray)) throw Error('SOURCE_SCHEMA_MISMATCH');
        return doc;
      }
      catch (e) {
        guard.stopped ||= { reason: 'SOURCE_READ_OR_SCHEMA_ERROR' };
        if (!controller.signal.aborted) controller.abort();
        throw e;
      }
    };
    try {
      const r = t.platform === 'jd'
        ? await deadline(runJdOnce({ reader, at, previous: prev, reviewedBaseline: jdReviewedBaseline }), deadlineMs,
          () => { guard.stopped ||= { reason: 'RUN_DEADLINE_EXCEEDED' }; controller.abort(); })
        : await deadline(runDouyinOnce({ reader, config, at, previous: prev }), deadlineMs,
          () => { guard.stopped ||= { reason: 'RUN_DEADLINE_EXCEEDED' }; controller.abort(); });
      if (guard.stopped) { out.results.push({ platform: t.platform, status: 'BLOCKED', reason: guard.stopped.reason || 'SOURCE_STOPPED', sourceAccess: true, requests: guard.requests, summary: { LIVE: 0, OFFLINE: 0, UNKNOWN: 0 } }); continue; }
      out.results.push({ ...r, sourceAccess: true, requests: guard.requests, lastRunKey: runKey });
    } catch (e) {
      const reason = String(e?.message) === 'RUN_DEADLINE_EXCEEDED' ? 'RUN_DEADLINE_EXCEEDED' : (guard.stopped?.reason || String(e?.message || 'RUN_ERROR').slice(0, 60));
      out.results.push({ platform: t.platform, status: 'BLOCKED', reason, sourceAccess: true, requests: guard.requests, summary: { LIVE: 0, OFFLINE: 0, UNKNOWN: 0 } });
    }
  }
  return out;
}

/** Next persisted state. Only successful READ_ONCE results advance it; failures keep the old state. */
export function nextState(previous = {}, run) {
  const next = { ...previous };
  for (const r of run.results) {
    if (r.status !== 'READ_ONCE') continue;
    next[r.platform] = r.platform === 'jd'
      ? { lastRunKey: r.lastRunKey, checkedAt: r.checkedAt, roomIds: r.rows.map(x => x.roomId),
          sessions: r.rows.map(x => ({ roomId: x.roomId, ...x.sessions })),
          minuteSnapshot: { date: r.date, at: Date.parse(r.checkedAt), rooms: r.rows.filter(x => Number.isInteger(x.minuteCount)).map(x => ({ roomId: x.roomId, date: r.date, at: Date.parse(r.checkedAt), minuteCount: x.minuteCount })) } }
      : { lastRunKey: r.lastRunKey, checkedAt: r.checkedAt, inventory: r.inventory };
  }
  return next;
}

/** PUBLIC receipt: counts and reasons only. No room/shop identifiers, names or business fields. */
export function publicReceipt(run) {
  const tally = (rows, key) => rows.reduce((m, r) => (m[r[key]] = (m[r[key]] || 0) + 1, m), {});
  return { schemaVersion: 316, mode: 'PUBLIC_AGGREGATE_NO_IDENTIFIERS', runKey: run.runKey, startedAt: run.startedAt, decision: run.decision,
    processModel: run.processModel, continuousPolling: false,
    results: run.results.map(r => ({ platform: r.platform, status: r.status, reason: r.reason ?? null, sourceAccess: r.sourceAccess === true,
      requests: r.requests ?? 0, checkedAt: r.checkedAt ?? null, summary: r.summary ?? null, formalSummary: r.formalSummary ?? null,
      rooms: Array.isArray(r.rows) ? r.rows.length : 0, reasons: Array.isArray(r.rows) ? tally(r.rows, 'reason') : {},
      newRoomsPendingReview: r.newRooms ?? null, missingRoomsKeptUnknown: r.missingRooms ?? r.counts?.missingPrior ?? null,
      counts: r.counts ?? null, warnings: r.warnings ?? [], offlineRuleValidated: false,
      formalOpeningRatePercent: null, formalFullDurationRatePercent: null })) };
}
export { SOURCE_ROUTES };
