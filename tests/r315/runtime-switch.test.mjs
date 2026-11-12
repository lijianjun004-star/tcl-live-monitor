import test from 'node:test';
import assert from 'node:assert/strict';
import { planRuntimeAction, isBeijingOperatingWindow } from '../../probes/r315/runtime-switch.mjs';

const stamp = '2026-11-12T00:00:00.000Z';
const base = () => ({
  schemaVersion: 1,
  autoEnabled: { jd: false, douyin: false },
  sourceAccessApproved: { jd: false, douyin: false },
  adapterReady: { jd: false, douyin: false },
  updatedAt: stamp,
  updatedBy: 'bootstrap',
  updatedByRunId: null
});
const ready = () => ({
  ...base(),
  sourceAccessApproved: { jd: true, douyin: true },
  adapterReady: { jd: true, douyin: true }
});
const at = value => new Date(value);

test('automatic mode is OFF by default and scheduled event performs no source access', () => {
  const result = planRuntimeAction({
    eventName: 'schedule', state: base(), now: at('2026-11-12T23:35:00.000Z')
  });
  assert.equal(result.decision, 'SKIP');
  assert.equal(result.reason, 'ALL_AUTOMATIC_SWITCHES_OFF');
  assert.equal(result.sourceAccess, false);
  assert.deepEqual(result.targets, []);
});

test('scheduled mode triggers only enabled platforms and ends after one bounded scan', () => {
  const state = ready();
  state.autoEnabled.jd = true;
  const result = planRuntimeAction({
    eventName: 'schedule', state, now: at('2026-11-12T23:35:00.000Z')
  });
  assert.equal(result.decision, 'ONE_SHOT');
  assert.equal(result.trigger, 'SCHEDULED_ONE_SHOT');
  assert.deepEqual(result.targets.map(x => [x.platform, x.status]), [['jd', 'READY_FOR_SINGLE_SCAN']]);
  assert.equal(result.continuousPolling, false);
  assert.equal(result.runUntilCompleteThenExit, true);
});

test('manual run once works with auto mode OFF and does not mutate switch state', () => {
  const state = ready();
  const result = planRuntimeAction({
    eventName: 'workflow_dispatch', action: 'run_once', platform: 'douyin',
    state, now: at('2026-11-12T03:20:00.000Z'), actor: 'operator', runId: 99
  });
  assert.equal(result.decision, 'ONE_SHOT');
  assert.equal(result.trigger, 'MANUAL_ONE_SHOT');
  assert.deepEqual(result.targets.map(x => x.platform), ['douyin']);
  assert.equal(result.continuousPolling, false);
  assert.deepEqual(state.autoEnabled, { jd: false, douyin: false });
});

test('manual run once is blocked without source approval and never mistakes it for OFFLINE', () => {
  const result = planRuntimeAction({
    eventName: 'workflow_dispatch', action: 'run_once', platform: 'both',
    state: base(), now: at('2026-11-12T03:20:00.000Z')
  });
  assert.equal(result.decision, 'BLOCKED');
  assert.deepEqual(result.targets.map(x => x.reason), [
    'SOURCE_ACCESS_NOT_APPROVED', 'SOURCE_ACCESS_NOT_APPROVED'
  ]);
  assert.equal(result.sourceAccess, false);
  assert.ok(result.targets.every(x => x.status !== 'OFFLINE'));
});

test('enable/disable actions update persistent per-platform switches but do not scan immediately', () => {
  const state = base();
  const enabled = planRuntimeAction({
    eventName: 'workflow_dispatch', action: 'enable_auto', platform: 'jd',
    state, now: at('2026-11-12T03:20:00.000Z'), actor: 'admin', runId: 123
  });
  assert.equal(enabled.decision, 'CONTROL_UPDATE');
  assert.equal(enabled.scanNow, false);
  assert.deepEqual(enabled.nextState.autoEnabled, { jd: true, douyin: false });
  assert.deepEqual(enabled.nextState.sourceAccessApproved, { jd: false, douyin: false });
  assert.equal(enabled.nextState.updatedBy, 'admin');
  assert.equal(enabled.nextState.updatedByRunId, '123');

  const disabled = planRuntimeAction({
    eventName: 'workflow_dispatch', action: 'disable_auto', platform: 'jd',
    state: enabled.nextState, now: at('2026-11-12T04:20:00.000Z'), actor: 'admin', runId: 124
  });
  assert.deepEqual(disabled.nextState.autoEnabled, { jd: false, douyin: false });
  assert.equal(disabled.scanNow, false);
});

test('automatic switch can be enabled independently for both platforms', () => {
  const result = planRuntimeAction({
    eventName: 'workflow_dispatch', action: 'enable_auto', platform: 'both',
    state: base(), now: at('2026-11-12T03:20:00.000Z')
  });
  assert.deepEqual(result.nextState.autoEnabled, { jd: true, douyin: true });
});

test('status action reads switch state only and never accesses sources', () => {
  const state = base();
  const result = planRuntimeAction({
    eventName: 'workflow_dispatch', action: 'status', state,
    now: at('2026-11-12T03:20:00.000Z')
  });
  assert.equal(result.decision, 'STATUS');
  assert.equal(result.sourceAccess, false);
  assert.equal(result.state, state);
});

test('automatic mode observes the Beijing 06:30–02:00 operating window', () => {
  assert.equal(isBeijingOperatingWindow(at('2026-11-12T22:30:00.000Z')), true); // 06:30 BJT
  assert.equal(isBeijingOperatingWindow(at('2026-11-12T18:00:00.000Z')), false); // 02:00 BJT
  assert.equal(isBeijingOperatingWindow(at('2026-11-12T18:35:00.000Z')), false); // 02:35 BJT
  assert.equal(isBeijingOperatingWindow(at('2026-11-12T21:35:00.000Z')), false); // 05:35 BJT
});

test('automatic mode skips outside the Beijing operating window even if enabled', () => {
  const state = ready();
  state.autoEnabled.jd = true;
  const result = planRuntimeAction({
    eventName: 'schedule', state, now: at('2026-11-12T18:35:00.000Z')
  });
  assert.equal(result.decision, 'SKIP');
  assert.equal(result.reason, 'OUTSIDE_BEIJING_OPERATING_WINDOW');
  assert.equal(result.sourceAccess, false);
});

test('automatic mode with an enabled switch but missing adapter remains BLOCKED', () => {
  const state = base();
  state.autoEnabled.jd = true;
  const result = planRuntimeAction({
    eventName: 'schedule', state, now: at('2026-11-12T23:35:00.000Z')
  });
  assert.equal(result.decision, 'BLOCKED');
  assert.equal(result.targets[0].reason, 'SOURCE_ACCESS_NOT_APPROVED');
  assert.equal(result.sourceAccess, false);
});

test('malformed switch state and unsupported triggers fail closed', () => {
  const state = base();
  assert.equal(planRuntimeAction({
    eventName: 'schedule', state: { ...state, autoEnabled: { jd: 'true', douyin: false } },
    now: at('2026-11-12T23:35:00.000Z')
  }).decision, 'BLOCK');
  assert.equal(planRuntimeAction({
    eventName: 'push', state, now: at('2026-11-12T23:35:00.000Z')
  }).decision, 'BLOCK');
  assert.equal(planRuntimeAction({
    eventName: 'workflow_dispatch', action: 'run_once', platform: 'taobao',
    state, now: at('2026-11-12T23:35:00.000Z')
  }).decision, 'BLOCK');
});
