import test from 'node:test';
import assert from 'node:assert/strict';
import { bjTs, bjDate, MINUTE } from '../src/core/time.mjs';
import { normalizeObservation, combineRoomState, LIVE, OFFLINE, UNKNOWN } from '../src/core/states.mjs';
import { evaluateSlot, offScheduleLive } from '../src/core/evaluate.mjs';
import { aggregate } from '../src/core/kpi.mjs';
import { parseScheduleCsv, planImport, splitByStatDay } from '../src/core/schedule.mjs';
import { buildRegistry } from '../src/core/rooms.mjs';

const D = '2026-11-05';
const T = h => bjTs(D, h);
const slot = (extra = {}) => ({ id: 's1', roomId: 'r1', accountIds: ['a1'], start: T('10:00'), end: T('11:00'), platformSourceValidated: true, ...extra });
// series('10:00', ['L','L','O',...]) -> observations every 5 min
function series(from, codes, accountId = 'a1') {
  const map = { L: 'LIVE', O: 'OFFLINE', U: 'UNKNOWN' };
  return codes.map((c, i) => c === '-' ? null : normalizeObservation({ accountId, at: T(from) + i * 5 * MINUTE, state: map[c], offlineEvidence: c === 'O' })).filter(Boolean);
}
const AFTER = T('12:00');

test('time: Beijing conversion and 24:00', () => {
  assert.equal(bjDate(T('23:59')), D);
  assert.equal(bjTs(D, '24:00'), bjTs('2026-11-06', '00:00'));
  assert.throws(() => bjTs('2026-02-30', '10:00'));
});

test('states: OFFLINE without evidence is downgraded to UNKNOWN', () => {
  const o = normalizeObservation({ accountId: 'a', at: 1, state: 'OFFLINE' });
  assert.equal(o.state, UNKNOWN);
  assert.equal(o.reason, 'OFFLINE_WITHOUT_EVIDENCE_DOWNGRADED');
  assert.equal(normalizeObservation({ accountId: 'a', at: 1, state: 'weird' }).state, UNKNOWN);
});

test('states: simulcast room combination', () => {
  assert.equal(combineRoomState([OFFLINE, LIVE], 2), LIVE);
  assert.equal(combineRoomState([OFFLINE, OFFLINE], 2), OFFLINE);
  assert.equal(combineRoomState([OFFLINE], 2), UNKNOWN, 'one account unobserved -> cannot prove offline');
  assert.equal(combineRoomState([OFFLINE, UNKNOWN], 2), UNKNOWN);
});

test('full clean live slot -> FINAL, on time, 60 min', () => {
  const r = evaluateSlot(slot(), series('10:00', Array(12).fill('L')), AFTER);
  assert.equal(r.status, 'FINAL');
  assert.equal(r.lateness.verdict, 'ON_TIME');
  assert.equal(r.liveMinutesEstimate, 60);
  assert.equal(r.liveMinutesLowerBound, 55);
  assert.equal(r.coverage.ratio, 1);
  assert.equal(r.penaltyEligible, true);
});

test('start within 5-min grace is on time', () => {
  const r = evaluateSlot(slot(), series('10:00', ['O', 'L', ...Array(10).fill('L')]), AFTER);
  assert.equal(r.lateness.verdict, 'ON_TIME');
});

test('late requires OFFLINE evidence after grace', () => {
  const r = evaluateSlot(slot(), series('10:00', ['O', 'O', 'O', 'L', ...Array(8).fill('L')]), AFTER);
  assert.equal(r.lateness.verdict, 'LATE');
  assert.deepEqual(r.lateness.lateMinutesRange, [10, 15]);
  assert.equal(r.lateness.confidence, 'HIGH');
  assert.equal(r.status, 'FINAL');
});

test('UNKNOWN before first live -> lateness UNDETERMINED, not penalized', () => {
  const r = evaluateSlot(slot(), series('10:00', ['U', 'U', 'U', 'L', ...Array(8).fill('L')]), AFTER);
  assert.equal(r.lateness.verdict, 'UNDETERMINED');
  assert.equal(r.status, 'PROVISIONAL');
  assert.ok(r.reasons.includes('LATENESS_UNDETERMINED'));
  assert.equal(r.penaltyEligible, false);
});

test('interruption needs >=10 min continuous OFFLINE (3 samples at 5 min)', () => {
  const two = evaluateSlot(slot(), series('10:00', ['L', 'L', 'L', 'O', 'O', 'L', 'L', 'L', 'L', 'L', 'L', 'L']), AFTER);
  assert.equal(two.interruptions.length, 0, '5 min of evidence is not an interruption');
  const three = evaluateSlot(slot(), series('10:00', ['L', 'L', 'L', 'O', 'O', 'O', 'L', 'L', 'L', 'L', 'L', 'L']), AFTER);
  assert.equal(three.interruptions.length, 1);
  assert.equal(three.interruptions[0].verdict, 'CONFIRMED');
  assert.equal(three.interruptions[0].evidencedMinutes, 10);
});

test('gap with UNKNOWN is never a confirmed interruption', () => {
  const r = evaluateSlot(slot(), series('10:00', ['L', 'L', 'O', 'U', 'O', 'O', 'L', 'L', 'L', 'L', 'L', 'L']), AFTER);
  assert.equal(r.interruptions[0].verdict, 'UNDETERMINED');
  assert.equal(r.status, 'PROVISIONAL');
});

test('missing samples lower coverage and block FINAL', () => {
  const r = evaluateSlot(slot(), series('10:00', ['L', 'L', '-', '-', 'L', 'L', 'L', 'L', 'L', 'L', 'L', 'L']), AFTER);
  assert.equal(r.coverage.missing, 2);
  assert.ok(r.coverage.ratio < 0.9);
  assert.ok(r.reasons.includes('INSUFFICIENT_COVERAGE'));
});

test('no reliable samples at all -> BLOCKED', () => {
  const r = evaluateSlot(slot(), [], AFTER);
  assert.equal(r.status, 'BLOCKED');
  assert.equal(r.lateness.verdict, 'UNDETERMINED');
});

test('unvalidated platform source can never be FINAL', () => {
  const r = evaluateSlot(slot({ platformSourceValidated: false }), series('10:00', Array(12).fill('L')), AFTER);
  assert.equal(r.status, 'PROVISIONAL');
  assert.ok(r.reasons.includes('SOURCE_NOT_VALIDATED'));
});

test('in-progress slot is PROVISIONAL and trailing offline not judged', () => {
  const r = evaluateSlot(slot(), series('10:00', ['L', 'L', 'O', 'O', 'O']), T('10:25'));
  assert.equal(r.status, 'PROVISIONAL');
  assert.equal(r.interruptions.length, 0);
});

test('proven no-show only when all post-grace samples are OFFLINE', () => {
  assert.equal(evaluateSlot(slot(), series('10:00', Array(12).fill('O')), AFTER).lateness.verdict, 'NOT_STARTED');
  assert.equal(evaluateSlot(slot(), series('10:00', [...Array(11).fill('O'), 'U']), AFTER).lateness.verdict, 'UNDETERMINED');
});

test('simulcast room: two accounts counted once', () => {
  const s = slot({ accountIds: ['a1', 'a2'] });
  const obs = [...series('10:00', Array(12).fill('L'), 'a1'), ...series('10:00', Array(12).fill('L'), 'a2')];
  const r = evaluateSlot(s, obs, AFTER);
  assert.equal(r.liveMinutesEstimate, 60);
});

test('off-schedule live is recorded but separate', () => {
  const obs = series('09:00', ['L', 'L']);
  assert.equal(offScheduleLive(['a1'], [slot()], obs).length, 2);
  const r = evaluateSlot(slot(), obs, AFTER);
  assert.equal(r.liveMinutesEstimate, 0);
});

test('KPI: formal uses FINAL only, numerators/denominators explicit', () => {
  const a = evaluateSlot(slot(), series('10:00', Array(12).fill('L')), AFTER);
  const b = evaluateSlot(slot({ id: 's2', roomId: 'r2', accountIds: ['b1'] }), series('10:00', Array(6).fill('L').concat(Array(6).fill('O')), 'b1'), AFTER);
  const c = evaluateSlot(slot({ id: 's3', roomId: 'r3', accountIds: ['c1'] }), [], AFTER);
  const k = aggregate([a, b, c]);
  assert.deepEqual(k.statusCounts, { FINAL: 2, BLOCKED: 1 });
  assert.equal(k.formal.openingRate.denominator, 2);
  assert.equal(k.formal.durationCompletion.numeratorMinutes, 90);
  assert.equal(k.formal.durationCompletion.denominatorMinutes, 120);
  assert.equal(k.formal.roomAverageCompletion.value, 0.75);
  assert.equal(k.provisional.openingRate.denominator, 3);
  assert.equal(k.interruptionsConfirmed, 1);
});

test('schedule CSV: Chinese headers, cross-midnight, cancel, errors', () => {
  const csv = '﻿日期,实体直播间,开始,结束,账号,状态\n2026-11-05,r1,20:00,02:00,a1;a2,\n2026/11/05,r2,9:00,12:00,,取消\nbad,r3,10:00,11:00,,\n';
  const { slots, errors } = parseScheduleCsv(csv);
  assert.equal(slots.length, 2);
  assert.equal(errors.length, 1);
  assert.equal(slots[0].crossesMidnight, true);
  assert.equal((slots[0].end - slots[0].start) / MINUTE, 360);
  assert.deepEqual(slots[0].accountIds, ['a1', 'a2']);
  assert.equal(slots[1].status, 'cancelled');
  const parts = splitByStatDay(slots[0]);
  assert.deepEqual(parts.map(p => p.statDate), ['2026-11-05', '2026-11-06']);
  assert.equal(parts.every(p => p.scheduleDate === '2026-11-05'), true);
});

test('schedule import preview: started slots are frozen', () => {
  const { slots: old } = parseScheduleCsv('date,room_id,start,end\n2026-11-05,r1,10:00,11:00\n2026-11-05,r2,14:00,15:00\n2026-11-05,r3,16:00,17:00');
  const { slots: neu } = parseScheduleCsv('date,room_id,start,end\n2026-11-05,r1,10:00,12:00\n2026-11-05,r2,14:00,16:00\n2026-11-05,r4,18:00,19:00');
  const p = planImport(old, neu, T('10:30'));
  assert.deepEqual(p.rejectedFrozen.map(x => x.key), ['2026-11-05|r1|10:00']);
  assert.equal(p.update.length, 1);
  assert.equal(p.add.length, 1);
  assert.equal(p.cancel.length, 1);
});

test('registry: duplicate binding rejected, only confirmed accounts monitored', () => {
  const rooms = [{ id: 'r1' }];
  assert.throws(() => buildRegistry({ rooms, accounts: [{ id: 'x', roomId: 'r1', platform: 'tmall' }, { id: 'x', roomId: 'r1', platform: 'tmall' }] }));
  assert.throws(() => buildRegistry({ rooms, accounts: [{ id: 'x', roomId: 'nope', platform: 'tmall' }] }));
  const reg = buildRegistry({ rooms, accounts: [
    { id: 't1', roomId: 'r1', platform: 'tmall', userConfirmed: true },
    { id: 't2', roomId: 'r1', platform: 'douyin', userConfirmed: false },
  ] });
  assert.deepEqual(reg.monitoredAccountIds('r1'), ['t1']);
  assert.equal(reg.sourceValidated('r1', []), false);
  assert.equal(reg.sourceValidated('r1', ['tmall']), true);
});
