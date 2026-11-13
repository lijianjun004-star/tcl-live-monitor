// R3.27 JD fixed-window (08:00-24:00 Beijing) full-broadcast rate: pure logic, synthetic numbers only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { computeDay, update, report, reading, isMorningSnapshot, isFinalReading, validateState, WINDOW } from '../../probes/r327/jd-fullday.mjs';
const D = '2026-11-13', bj = (d, hm) => `${d}T${hm}:00+08:00`;
const snap = (at, count, latest) => ({ at: new Date(at).toISOString(), minuteCount: count, latestMinuteAt: latest ? new Date(latest).toISOString() : null });
const fin = (count, latest) => snap(bj('2026-11-14', '00:34'), count, latest);

test('window is 08:00-24:00 = 960 minutes; snapshot and final timing rules', () => {
  assert.equal(WINDOW.requiredMinutes, 960);
  assert.equal(isMorningSnapshot(D, snap(bj(D, '08:04'), 60, null)), true);
  for (const t of ['07:59', '09:00', '12:00']) assert.equal(isMorningSnapshot(D, snap(bj(D, t), 60, null)), false);
  assert.equal(isFinalReading(D, snap(bj('2026-11-14', '00:04'), 10, null)), false);
  assert.equal(isFinalReading(D, snap(bj('2026-11-14', '00:06'), 10, null)), true);
  assert.equal(isFinalReading(D, snap(bj(D, '23:59'), 10, null)), false);
});

test('full day: started 07:30, ran to 23:59 (+ 00:00-00:40 from the night before) -> 100%', () => {
  // day total = 40 (00:00-00:39) + 30 (07:30-07:59) + 960 = 1030; at 08:04 snapshot: 40 + 30 + 4 = 74, latest 08:03
  const r = computeDay(D, { morning: snap(bj(D, '08:04'), 74, bj(D, '08:03')), final: fin(1030, bj(D, '23:59')) });
  assert.deepEqual([r.method, r.inWindowMinutes, r.ratePercent, r.liveByWindowStart, r.reachedWindowEnd, r.lastMinuteBeijing, r.assumedContinuousMinutes],
    ['FROM_0800_SNAPSHOT', 960, 100, true, true, '23:59', 4]);
});

test('late start and early end are both counted against the rate', () => {
  // started 09:00 (not live at 08:04; 40 pre-window minutes), ended 22:00: 780 in-window minutes
  const r = computeDay(D, { morning: snap(bj(D, '08:04'), 40, bj(D, '00:39')), final: fin(820, bj(D, '21:59')) });
  assert.deepEqual([r.inWindowMinutes, r.ratePercent, r.liveByWindowStart, r.reachedWindowEnd, r.lastMinuteBeijing], [780, 81.3, false, false, '21:59']);
  // no broadcast at all
  const z = computeDay(D, { morning: snap(bj(D, '08:04'), 0, null), final: fin(0, null) });
  assert.deepEqual([z.inWindowMinutes, z.ratePercent, z.liveByWindowStart, z.reachedWindowEnd], [0, 0, false, false]);
});

test('without a valid 08:00 snapshot only a range is reported, never a single rate', () => {
  const r = computeDay(D, { morning: snap(bj(D, '10:30'), 200, bj(D, '10:29')), final: fin(1030, bj(D, '23:59')) });
  assert.deepEqual([r.method, r.ratePercent, r.rangePercent, r.liveByWindowStart], ['RANGE_ONLY_NO_0800_SNAPSHOT', null, [57.3, 100], null]);
  const n = computeDay(D, { morning: snap(bj(D, '08:04'), 74, bj(D, '08:03')), final: null });
  assert.deepEqual([n.method, n.ratePercent, n.rangePercent, n.liveByWindowStart], ['NO_FINAL_READING', null, null, true]);
  // inconsistent numbers (morning count above the final count) fall back to the range
  assert.equal(computeDay(D, { morning: snap(bj(D, '08:04'), 900, bj(D, '08:03')), final: fin(800, bj(D, '20:00')) }).method, 'RANGE_ONLY_NO_0800_SNAPSHOT');
  assert.throws(() => computeDay('2026-13-45', {}), /DATE_INVALID/);
});

test('state update: first morning snapshot wins, final only after the day ended, business fields never stored', () => {
  const row = (count, latest, extra = {}) => ({ roomId: '15', category: 'SYNTH', captureBound: true, dailyOk: true,
    days: [{ date: D, minute_count: count, latest_minute_ts: latest, latest: { gmv: 123, anchor: 'SECRET_NAME' }, ...extra }] });
  let s = update(null, [row(74, bj(D, '08:03'))], bj(D, '08:04'));
  s = update(s, [row(89, bj(D, '08:18'))], bj(D, '08:19'));                 // later snapshot does not replace the first
  assert.equal(s.days[D]['15'].morning.minuteCount, 74);
  assert.equal(s.days[D]['15'].latest.minuteCount, 89);
  assert.equal(s.days[D]['15'].final, null);
  s = update(s, [row(1030, bj(D, '23:59'))], bj('2026-11-14', '00:34'));
  const r = report(s).find(x => x.date === D && x.roomId === '15');
  assert.deepEqual([r.ratePercent, r.method, r.category, r.captureBound], [100, 'FROM_0800_SNAPSHOT', 'SYNTH', true]);
  assert.doesNotMatch(JSON.stringify(s), /SECRET_NAME|gmv|123/);
  // failed daily call: no reading, nothing invented; succeeded call with no row for a past day: zero minutes
  const failed = update(null, [{ roomId: '16', category: 'X', captureBound: false, dailyOk: false, days: [] }], bj('2026-11-14', '00:34'));
  assert.equal(failed.days[D]['16'].final, null);
  const none = update(null, [{ roomId: '16', category: 'X', captureBound: false, dailyOk: true, days: [] }], bj('2026-11-14', '00:34'));
  assert.equal(none.days[D]['16'].final.minuteCount, 0);
  assert.throws(() => validateState({ schemaVersion: 1 }), /BAD_STATE/);
  assert.throws(() => update(null, [{ roomId: 'abc' }], bj(D, '08:04')), /ROOM_INVALID/);
  assert.equal(reading({ minute_count: 99999 }, bj(D, '08:04')).minuteCount, null);
});

test('workflow: schedule + manual only, read-only token, GET-only CLI on allow-listed routes', { skip: !fs.existsSync('.github/workflows/jd-fullday-rate.yml') }, () => {
  const wf = fs.readFileSync('.github/workflows/jd-fullday-rate.yml', 'utf8');
  assert.match(wf, /\non:\n  schedule:\n/); assert.match(wf, /\n  workflow_dispatch:\npermissions:\n  contents: read\n  actions: read\n/);
  assert.doesNotMatch(wf, /pull_request|\n  push:|contents: write/);
  assert.match(wf, /if: github\.ref == 'refs\/heads\/main'/);
  const cli = fs.readFileSync('probes/r327/jd-fullday-cli.mjs', 'utf8');
  assert.match(cli, /networkReader\(process\.env\.TCL_OPS_BASE_URL\)/);
  assert.doesNotMatch(cli, /\bfetch\(|\bPOST\b|\bPUT\b|\bPATCH\b|\bDELETE\b|anchor_name|gmv/);
});
