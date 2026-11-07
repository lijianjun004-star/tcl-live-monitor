// TCL直播运营平台 (management-approved, read-only GET) -> tri-state observation.
// Signals per room: today's room-overview/daily row (minute_count, latest_minute_ts, latest.status)
// and the capture agent heartbeat (assistant/active-rooms.last_heartbeat_at).
export const FRESH_MINUTE_MS = 3 * 60_000;   // live data must be newer than this
export const FRESH_HEARTBEAT_MS = 2 * 60_000; // capture agent considered alive
export const OFFLINE_GAP_MS = 3 * 60_000;     // alive agent + no new minute for this long

const ts = s => { const t = Date.parse(s || ''); return Number.isFinite(t) ? t : null; };

export function classifyTclOps({ day, heartbeatAt, now, offlineRuleValidated = false }) {
  const hb = ts(heartbeatAt), lm = ts(day?.latest_minute_ts);
  const agentAlive = hb !== null && now - hb <= FRESH_HEARTBEAT_MS && hb <= now + 60_000;
  const minuteAge = lm === null ? null : now - lm;
  const status = day?.latest?.status ?? null;
  const base = { agentAlive, minuteAgeMin: minuteAge === null ? null : Math.round(minuteAge / 6000) / 10,
    minuteCount: Number.isFinite(day?.minute_count) ? day.minute_count : null, platformStatus: status };
  const fresh = minuteAge !== null && minuteAge >= -60_000 && minuteAge <= FRESH_MINUTE_MS;
  if (fresh && Number(status) === 1)
    return { ...base, state: 'LIVE', reason: 'FRESH_MINUTE_DATA_STATUS_1' };
  if (fresh && status === null && agentAlive)
    return { ...base, state: 'LIVE', reason: 'FRESH_MINUTE_DATA_STATUS_ABSENT' };
  if (fresh) return { ...base, state: 'UNKNOWN', reason: 'FRESH_MINUTE_DATA_STATUS_' + String(status).slice(0, 12) };
  // R0.9.9 (runs 42354864197 + assistant cards 2026-11-07): room 16 had a live capture agent, 24
  // assistant cards and a fresh link-map all afternoon, but NO minute rows all day — its minute feed
  // is simply missing. "Never had minutes today" is therefore not stop evidence; only minutes that
  // existed and then stopped are an OFFLINE candidate.
  if (agentAlive && minuteAge === null) return { ...base, state: 'UNKNOWN', reason: 'NO_MINUTE_FEED_TODAY' };
  if (agentAlive && minuteAge > OFFLINE_GAP_MS) {
    if (offlineRuleValidated) return { ...base, state: 'OFFLINE', offlineEvidence: true, reason: 'AGENT_ALIVE_NO_NEW_MINUTES' };
    return { ...base, state: 'UNKNOWN', offlineCandidate: true, reason: 'OFFLINE_CANDIDATE_AGENT_ALIVE_NO_NEW_MINUTES' };
  }
  if (!agentAlive) return { ...base, state: 'UNKNOWN', reason: hb === null ? 'NO_CAPTURE_AGENT' : 'CAPTURE_AGENT_STALE' };
  return { ...base, state: 'UNKNOWN', reason: 'AMBIGUOUS' };
}

/** Live minutes between two polls of the same Beijing day (exact per platform capture, not a sample). */
export function liveMinutesDelta(prev, cur) {
  if (!Number.isFinite(prev) || !Number.isFinite(cur) || cur < prev) return null;
  return cur - prev;
}

/**
 * Self-calibration of the OFFLINE candidate rule from the platform's own session split.
 * R0.9.6 hardening:
 *  1) Preserves lastLiveSessionCount and lastLiveState across transient plain UNKNOWN polls (e.g. API_ERROR or CAPTURE_AGENT_STALE)
 *     within the same Beijing day so a subsequent offlineCandidate still triggers GAP_OPENED and a subsequent LIVE with session+1
 *     still triggers SESSION_BREAK_DURING_UNKNOWN;
 *  2) Detects session_count regression (s1 < s0) as GAP_CLOSED_SESSION_REGRESSED instead of falsely claiming GAP_CLOSED_SAME_SESSION.
 */
export function trackSessionGap(prev, cur) {
  const curSession = Number.isInteger(cur.sessionCount) ? cur.sessionCount : null;
  const next = {
    date: cur.date,
    state: cur.state,
    offlineCandidate: !!cur.offlineCandidate,
    sessionCount: curSession,
    gapOpenedAt: null,
    lastLiveSessionCount: cur.state === 'LIVE' && curSession !== null ? curSession : null,
    hadLiveToday: cur.state === 'LIVE',
  };
  if (!prev || prev.date !== cur.date) return { event: null, next }; // new day: counts reset
  const wasLive = prev.state === 'LIVE' || prev.hadLiveToday === true;
  const inGap = !!prev.gapOpenedAt;
  const s0 = Number.isInteger(prev.sessionCount) ? prev.sessionCount : (Number.isInteger(prev.lastLiveSessionCount) ? prev.lastLiveSessionCount : null);
  const s1 = curSession;
  const sessionKnown = Number.isInteger(s0) && Number.isInteger(s1);
  next.lastLiveSessionCount = cur.state === 'LIVE' && curSession !== null ? curSession : s0;
  next.hadLiveToday = wasLive || cur.state === 'LIVE';

  if ((wasLive || inGap) && cur.offlineCandidate) {
    next.gapOpenedAt = prev.gapOpenedAt || cur.at;
    if (s0 !== null && next.sessionCount === null) next.sessionCount = s0;
    return { event: inGap ? null : 'GAP_OPENED', next };
  }
  if (inGap && cur.state === 'LIVE') {
    const event = !sessionKnown ? 'GAP_CLOSED_SESSION_UNKNOWN' : s1 > s0 ? 'GAP_CLOSED_NEW_SESSION' : s1 < s0 ? 'GAP_CLOSED_SESSION_REGRESSED' : 'GAP_CLOSED_SAME_SESSION';
    return { event, next, gapOpenedAt: prev.gapOpenedAt };
  }
  if (inGap && cur.state !== 'LIVE' && !cur.offlineCandidate) {
    next.gapOpenedAt = prev.gapOpenedAt;
    if (s0 !== null && next.sessionCount === null) next.sessionCount = s0;
    return { event: null, next };
  }
  if (prev.state === 'LIVE' && cur.state === 'LIVE' && sessionKnown && s1 > s0) {
    return { event: 'SESSION_BREAK_BETWEEN_POLLS', next };
  }
  if (prev.state !== 'LIVE' && !inGap && wasLive && cur.state === 'LIVE' && sessionKnown && s1 > s0) {
    return { event: 'SESSION_BREAK_DURING_UNKNOWN', next };
  }
  return { event: null, next };
}
