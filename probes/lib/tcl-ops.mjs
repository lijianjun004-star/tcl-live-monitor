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
