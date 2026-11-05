import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyTclOps, liveMinutesDelta } from '../probes/lib/tcl-ops.mjs';
const now = Date.parse('2026-11-04T12:00:20Z');
const day = (ts, status = 1, mc = 100) => ({ minute_count: mc, latest_minute_ts: ts, latest: { status } });
test('fresh minute + status 1 -> LIVE', () => assert.equal(classifyTclOps({ day: day('2026-11-04T11:59:00Z'), heartbeatAt: '2026-11-04T12:00:01Z', now }).state, 'LIVE'));
test('agent alive, stale minutes -> OFFLINE candidate (UNKNOWN until validated)', () => {
  const c = classifyTclOps({ day: day('2026-11-04T10:54:00Z'), heartbeatAt: '2026-11-04T11:59:56Z', now });
  assert.equal(c.state, 'UNKNOWN'); assert.equal(c.offlineCandidate, true);
  assert.equal(classifyTclOps({ day: day('2026-11-04T10:54:00Z'), heartbeatAt: '2026-11-04T11:59:56Z', now, offlineRuleValidated: true }).state, 'OFFLINE');
});
test('agent dead -> UNKNOWN, never OFFLINE', () => {
  const c = classifyTclOps({ day: day('2026-11-04T10:54:00Z'), heartbeatAt: '2026-11-04T09:00:00Z', now, offlineRuleValidated: true });
  assert.equal(c.state, 'UNKNOWN'); assert.equal(c.reason, 'CAPTURE_AGENT_STALE');
  assert.equal(classifyTclOps({ day: null, heartbeatAt: null, now, offlineRuleValidated: true }).reason, 'NO_CAPTURE_AGENT');
});
test('fresh minute but status present and not 1 -> not LIVE', () => assert.notEqual(classifyTclOps({ day: day('2026-11-04T11:59:00Z', 0), heartbeatAt: '2026-11-04T12:00:01Z', now }).state, 'LIVE'));
test('R0.7.1: fresh minute, status ABSENT, agent alive -> LIVE; agent stale -> not LIVE', () => {
  const noStatus = { minute_count: 100, latest_minute_ts: '2026-11-04T11:59:00Z', latest: { last5m_uv: 3 } };
  const c = classifyTclOps({ day: noStatus, heartbeatAt: '2026-11-04T12:00:01Z', now });
  assert.equal(c.state, 'LIVE'); assert.equal(c.reason, 'FRESH_MINUTE_DATA_STATUS_ABSENT');
  assert.notEqual(classifyTclOps({ day: noStatus, heartbeatAt: '2026-11-04T09:00:00Z', now }).state, 'LIVE');
});
test('minute delta', () => { assert.equal(liveMinutesDelta(100, 105), 5); assert.equal(liveMinutesDelta(null, 5), null); assert.equal(liveMinutesDelta(10, 3), null); });
