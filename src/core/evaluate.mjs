// Per-slot evaluation: lateness, interruptions, live-time estimate, coverage, scoring status.
// Every number here is an ESTIMATE from discrete samples, never the platform's exact duration.
import { MINUTE } from './time.mjs';
import { LIVE, OFFLINE, UNKNOWN, combineRoomState } from './states.mjs';

export const DEFAULT_RULES = Object.freeze({
  pollMinutes: 5,          // in-schedule sampling interval
  lateGraceMinutes: 5,     // late only if > 5 min after planned start AND evidenced
  interruptMinutes: 10,    // interruption needs >= 10 min continuous OFFLINE evidence
  minCoverage: 0.9,        // reliable-sample ratio required for FINAL
});
export const MISSING = 'MISSING';

/** Build the expected sampling grid and the combined room state at each grid point. */
export function sampleGrid(slot, observations, now, rules) {
  const step = rules.pollMinutes * MINUTE;
  const effEnd = Math.min(slot.end, now);
  const byAccount = new Map(slot.accountIds.map(id => [id, []]));
  for (const o of observations) byAccount.get(o.accountId)?.push(o);
  const points = [];
  for (let t = slot.start; t < effEnd; t += step) {
    const states = [];
    let any = false;
    for (const list of byAccount.values()) {
      // latest observation within +/- half a step of the grid point
      let best = null;
      for (const o of list) if (Math.abs(o.at - t) <= step / 2 && (!best || o.at > best.at)) best = o;
      if (best) { any = true; states.push(best.state); }
    }
    points.push({ t, state: any ? combineRoomState(states, slot.accountIds.length) : MISSING });
  }
  return points;
}

function judgeLateness(slot, pts, ended, rules) {
  const grace = slot.start + rules.lateGraceMinutes * MINUTE;
  const f = pts.findIndex(p => p.state === LIVE);
  if (f === -1) {
    const after = pts.filter(p => p.t > grace);
    if (ended && after.length && after.every(p => p.state === OFFLINE))
      return { verdict: 'NOT_STARTED', evidence: 'ALL_POST_GRACE_SAMPLES_OFFLINE', confidence: 'HIGH' };
    return { verdict: 'UNDETERMINED', evidence: 'NO_LIVE_SAMPLE_AND_GAPS_OR_IN_PROGRESS', confidence: 'NONE' };
  }
  const firstLive = pts[f].t;
  if (firstLive <= grace) return { verdict: 'ON_TIME', firstLiveAt: firstLive, confidence: 'HIGH' };
  let lastOffIdx = -1;
  for (let i = f - 1; i >= 0; i--) if (pts[i].state === OFFLINE) { lastOffIdx = i; break; }
  const lastOff = lastOffIdx >= 0 ? pts[lastOffIdx].t : null;
  const gapClean = lastOffIdx === f - 1; // adjacent samples: start pinned within one interval
  if (lastOff !== null && lastOff > grace) {
    return {
      verdict: 'LATE', firstLiveAt: firstLive,
      startedBetween: [lastOff, firstLive],
      lateMinutesRange: [(lastOff - slot.start) / MINUTE, (firstLive - slot.start) / MINUTE],
      confidence: gapClean ? 'HIGH' : 'MEDIUM',
    };
  }
  return {
    verdict: 'UNDETERMINED', firstLiveAt: firstLive,
    evidence: 'NO_OFFLINE_EVIDENCE_AFTER_GRACE_BEFORE_FIRST_LIVE', confidence: 'NONE',
  };
}

function findInterruptions(pts, ended, rules) {
  const need = rules.interruptMinutes * MINUTE;
  const f = pts.findIndex(p => p.state === LIVE);
  if (f === -1) return [];
  const out = [];
  let i = f + 1;
  while (i < pts.length) {
    if (pts[i].state === LIVE) { i++; continue; }
    let j = i;
    while (j < pts.length && pts[j].state !== LIVE) j++;
    const run = pts.slice(i, j);
    const prevLive = pts[i - 1].t;
    const nextLive = j < pts.length ? pts[j].t : null;
    const trailing = nextLive === null;
    if (trailing && !ended) break; // still in progress: no judgement yet
    // longest strictly-consecutive OFFLINE sub-run is the only admissible stop evidence
    let best = null, cur = null;
    for (const p of run) {
      if (p.state === OFFLINE) { cur = cur ? { ...cur, to: p.t } : { from: p.t, to: p.t }; if (!best || cur.to - cur.from > best.to - best.from) best = cur; }
      else cur = null;
    }
    const evidencedMs = best ? best.to - best.from : 0;
    const maxPossibleMs = (nextLive ?? (run.at(-1).t + rules.pollMinutes * MINUTE)) - prevLive;
    const type = trailing ? 'EARLY_END' : 'INTERRUPTION';
    if (evidencedMs >= need) {
      out.push({ type, verdict: 'CONFIRMED', offlineEvidenceFrom: best.from, offlineEvidenceTo: best.to,
        evidencedMinutes: evidencedMs / MINUTE, maxPossibleMinutes: maxPossibleMs / MINUTE });
    } else if (maxPossibleMs > need && run.some(p => p.state !== OFFLINE)) {
      out.push({ type, verdict: 'UNDETERMINED', from: run[0].t, to: run.at(-1).t,
        evidencedMinutes: evidencedMs / MINUTE, maxPossibleMinutes: maxPossibleMs / MINUTE,
        reason: 'GAP_CONTAINS_UNKNOWN_OR_MISSING' });
    }
    i = j;
  }
  return out;
}

function liveMinutes(slot, pts, now, rules) {
  const step = rules.pollMinutes * MINUTE;
  const effEnd = Math.min(slot.end, now);
  let estimate = 0;
  for (const p of pts) if (p.state === LIVE) estimate += Math.max(0, Math.min(p.t + step, effEnd) - p.t);
  // lower bound: only time strictly between consecutive LIVE samples counts
  let lower = 0;
  for (let i = 1; i < pts.length; i++) if (pts[i].state === LIVE && pts[i - 1].state === LIVE) lower += pts[i].t - pts[i - 1].t;
  return { estimate: estimate / MINUTE, lowerBound: lower / MINUTE };
}

/**
 * Evaluate one scheduled slot of one physical room.
 * slot: { id, roomId, accountIds: string[], start, end (epoch ms), platformSourceValidated: boolean }
 */
export function evaluateSlot(slot, observations, now, rulesIn = {}) {
  const rules = { ...DEFAULT_RULES, ...rulesIn };
  if (!(slot.end > slot.start)) throw new RangeError(`slot ${slot.id} end must be after start`);
  const ended = now >= slot.end;
  const relevant = observations.filter(o => slot.accountIds.includes(o.accountId));
  const pts = sampleGrid(slot, relevant, now, rules);
  const count = s => pts.filter(p => p.state === s).length;
  const coverage = {
    expected: pts.length, live: count(LIVE), offline: count(OFFLINE), unknown: count(UNKNOWN), missing: count(MISSING),
  };
  coverage.reliable = coverage.live + coverage.offline;
  coverage.ratio = coverage.expected ? coverage.reliable / coverage.expected : null;

  const lateness = judgeLateness(slot, pts, ended, rules);
  const interruptions = findInterruptions(pts, ended, rules);
  const live = liveMinutes(slot, pts, now, rules);
  const plannedMinutes = (slot.end - slot.start) / MINUTE;

  const reasons = [];
  let status;
  if (!ended) { status = 'PROVISIONAL'; reasons.push('IN_PROGRESS'); }
  else if (coverage.expected > 0 && coverage.reliable === 0) { status = 'BLOCKED'; reasons.push('NO_RELIABLE_SAMPLES'); }
  else {
    if (slot.platformSourceValidated !== true) reasons.push('SOURCE_NOT_VALIDATED');
    if (coverage.ratio !== null && coverage.ratio < rules.minCoverage) reasons.push('INSUFFICIENT_COVERAGE');
    if (lateness.verdict === 'UNDETERMINED') reasons.push('LATENESS_UNDETERMINED');
    if (interruptions.some(x => x.verdict === 'UNDETERMINED')) reasons.push('INTERRUPTION_UNDETERMINED');
    status = reasons.length ? 'PROVISIONAL' : 'FINAL';
  }
  return {
    slotId: slot.id, roomId: slot.roomId, status, reasons,
    plannedMinutes,
    started: pts.some(p => p.state === LIVE),
    liveMinutesEstimate: Math.min(live.estimate, plannedMinutes),
    liveMinutesLowerBound: Math.min(live.lowerBound, plannedMinutes),
    lateness, interruptions, coverage,
    // Penalties may be applied ONLY when status === 'FINAL'.
    penaltyEligible: status === 'FINAL',
  };
}

/** LIVE observations of a room that fall outside every slot: recorded, never scored. */
export function offScheduleLive(roomAccountIds, slots, observations) {
  return observations.filter(o => o.state === LIVE && roomAccountIds.includes(o.accountId)
    && !slots.some(s => o.at >= s.start && o.at < s.end));
}
