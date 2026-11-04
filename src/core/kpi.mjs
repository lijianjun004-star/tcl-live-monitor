// KPI aggregation with explicit numerators/denominators.
// "formal" uses FINAL slots only (eligible for scoring); "provisional" includes everything evaluated.

function ratio(num, den) { return den > 0 ? num / den : null; }

function summarize(list) {
  const planned = list.reduce((a, s) => a + s.plannedMinutes, 0);
  const live = list.reduce((a, s) => a + s.liveMinutesEstimate, 0);
  const started = list.filter(s => s.started).length;
  const byRoom = new Map();
  for (const s of list) {
    const r = byRoom.get(s.roomId) || { planned: 0, live: 0, slots: 0 };
    r.planned += s.plannedMinutes; r.live += s.liveMinutesEstimate; r.slots++;
    byRoom.set(s.roomId, r);
  }
  const rooms = [...byRoom.entries()].map(([roomId, r]) => ({ roomId, ...r, completion: ratio(r.live, r.planned) }));
  const roomRates = rooms.map(r => r.completion).filter(x => x !== null);
  return {
    openingRate: { numerator: started, denominator: list.length, value: ratio(started, list.length) },
    durationCompletion: { numeratorMinutes: live, denominatorMinutes: planned, value: ratio(live, planned) },
    roomAverageCompletion: { rooms: roomRates.length, value: roomRates.length ? roomRates.reduce((a, b) => a + b, 0) / roomRates.length : null },
    rooms,
  };
}

export function aggregate(evaluations) {
  const finals = evaluations.filter(e => e.status === 'FINAL');
  const cov = evaluations.reduce((a, e) => ({ expected: a.expected + e.coverage.expected, reliable: a.reliable + e.coverage.reliable,
    unknown: a.unknown + e.coverage.unknown, missing: a.missing + e.coverage.missing }), { expected: 0, reliable: 0, unknown: 0, missing: 0 });
  const statusCounts = {};
  for (const e of evaluations) statusCounts[e.status] = (statusCounts[e.status] || 0) + 1;
  return {
    formal: summarize(finals),
    provisional: summarize(evaluations),
    coverage: { ...cov, ratio: ratio(cov.reliable, cov.expected) },
    statusCounts,
    lateConfirmed: evaluations.filter(e => e.status === 'FINAL' && e.lateness.verdict === 'LATE').length,
    interruptionsConfirmed: evaluations.filter(e => e.status === 'FINAL')
      .reduce((a, e) => a + e.interruptions.filter(i => i.verdict === 'CONFIRMED').length, 0),
    note: 'formal 仅含 FINAL 场次；时长为离散采样估计值，不是平台官方精确时长。',
  };
}
