// TCL直播运营平台 (management-approved, read-only GET) -> tri-state observation.
// Signals per room: today's room-overview/daily row (minute_count, latest_minute_ts, latest.status)
// and the capture agent heartbeat (assistant/active-rooms.last_heartbeat_at).
export const FRESH_MINUTE_MS = 3 * 60_000;   // live data must be newer than this
export const FRESH_HEARTBEAT_MS = 2 * 60_000; // capture agent considered alive
export const OFFLINE_GAP_MS = 3 * 60_000;     // alive agent + no new minute for this long

const ts = s => { const t = Date.parse(s || ''); return Number.isFinite(t) ? t : null; };

/**
 * @param day   room-overview/daily days[] entry for today (Beijing date) or null
 * @param heartbeatAt ISO string or null
 * @param now   epoch ms
 * @param offlineRuleValidated  promote OFFLINE candidates to OFFLINE only after user-confirmed calibration
 */
export function classifyTclOps({ day, heartbeatAt, now, offlineRuleValidated = false }) {
  const hb = ts(heartbeatAt), lm = ts(day?.latest_minute_ts);
  const agentAlive = hb !== null && now - hb <= FRESH_HEARTBEAT_MS && hb <= now + 60_000;
  const minuteAge = lm === null ? null : now - lm;
  const status = day?.latest?.status ?? null;
  const base = { agentAlive, minuteAgeMin: minuteAge === null ? null : Math.round(minuteAge / 6000) / 10,
    minuteCount: Number.isFinite(day?.minute_count) ? day.minute_count : null, platformStatus: status };
  if (minuteAge !== null && minuteAge >= -60_000 && minuteAge <= FRESH_MINUTE_MS && Number(status) === 1)
    return { ...base, state: 'LIVE', reason: 'FRESH_MINUTE_DATA_STATUS_1' };
  if (agentAlive && (minuteAge === null || minuteAge > OFFLINE_GAP_MS)) {
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
 * The ops platform counts live sessions per Beijing day (`session_count`). When a room that
 * showed an OFFLINE candidate gap comes back LIVE:
 *   - session_count increased  -> the platform itself ended the previous session: gap = real stop
 *   - session_count unchanged  -> same session: gap was a capture stall / short pause (candidate false positive)
 * prev/next: { date, state, offlineCandidate, sessionCount, gapOpenedAt }
 */
export function trackSessionGap(prev, cur) {
  const next = { date: cur.date, state: cur.state, offlineCandidate: !!cur.offlineCandidate,
    sessionCount: Number.isInteger(cur.sessionCount) ? cur.sessionCount : null, gapOpenedAt: null };
  if (!prev || prev.date !== cur.date) return { event: null, next }; // new day: counts reset
  const wasLive = prev.state === 'LIVE', isLive = cur.state === 'LIVE';
  const inGap = !!prev.gapOpenedAt;
  const s0 = prev.sessionCount, s1 = next.sessionCount;
  const sessionKnown = Number.isInteger(s0) && Number.isInteger(s1);
  if ((wasLive || inGap) && cur.offlineCandidate) {
    next.gapOpenedAt = prev.gapOpenedAt || cur.at;
    return { event: inGap ? null : 'GAP_OPENED', next };
  }
  if (inGap && isLive) {
    const event = !sessionKnown ? 'GAP_CLOSED_SESSION_UNKNOWN' : s1 > s0 ? 'GAP_CLOSED_NEW_SESSION' : 'GAP_CLOSED_SAME_SESSION';
    return { event, next, gapOpenedAt: prev.gapOpenedAt };
  }
  if (inGap && !isLive && !cur.offlineCandidate) {
    next.gapOpenedAt = prev.gapOpenedAt; // plain UNKNOWN inside a gap: keep it open, no judgement
    return { event: null, next };
  }
  if (wasLive && isLive && sessionKnown && s1 > s0) return { event: 'SESSION_BREAK_BETWEEN_POLLS', next };
  return { event: null, next };
}
