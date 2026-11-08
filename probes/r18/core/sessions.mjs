/** Pure reducer: observation timestamps are sampling bounds, never platform event times. */
export function reduceSessions(sessions = [], observation) {
  const result = structuredClone(sessions);
  const o = observation;
  const current = result.findLast(s => s.store_key === o.store_key && s.status === 'OPEN');
  const valid = o.source_attested === true && !o.failure_code;
  if (!valid || o.state === 'UNKNOWN') {
    if (current) current.offline_streak = 0;
    return result;
  }
  const at = o.actual_check_at;
  if (o.state === 'LIVE' && o.live_id) {
    if (current?.live_id === o.live_id) {
      current.last_seen_live_at = at;
      current.room_id = o.room_id;
      current.offline_streak = 0;
      return result;
    }
    if (current) {
      current.status = 'REPLACED_BY_NEW_LIVE_ID';
      current.end_window = { after: current.last_seen_live_at, on_or_before: at };
      current.offline_streak = 0;
    }
    result.push({ session_id: `${o.store_key}:${o.live_id}:${at}`, store_key: o.store_key, platform: o.platform, account_id: o.account_id, live_id: o.live_id, room_id: o.room_id, status: 'OPEN', first_seen_live_at: at, last_seen_live_at: at, offline_streak: 0, end_window: null, exact_start_end: false, exact_start_end_time: false });
  } else if (o.state === 'OFFLINE' && current) {
    if (current.first_offline_at === at) return result;
    current.offline_streak += 1;
    if (current.offline_streak === 1) current.first_offline_at = at;
    if (current.offline_streak >= 2) {
      current.status = 'CLOSED';
      current.end_window = { after: current.last_seen_live_at, on_or_before: current.first_offline_at };
      current.confirmed_at = at;
    }
  }
  return result;
}

export function rebuildSessions(observations) {
  return [...observations].sort((a, b) => a.actual_check_at.localeCompare(b.actual_check_at)).reduce(reduceSessions, []);
}
