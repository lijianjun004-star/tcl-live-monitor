import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import worker, {
  CRON, CRON_MINUTES, MAX_CRON_LATENESS_MS, DISPATCH_INPUTS, TARGET,
  beijingClock, decideRelay, dispatchV2, runScheduled,
} from '../worker.js';

const ms = t => Date.parse(t);
const decide = (when, delayMs = 500) => decideRelay({scheduledMs: ms(when), nowMs: ms(when) + delayMs});
const token = 'ghp_test_ONLY_NOT_REAL_1234567890';
const workflow = readFileSync(new URL('../../../.github/workflows/v2-monitor.yml', import.meta.url), 'utf8');

test('wrangler config, cron and target agree', () => {
  const c = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  assert.deepEqual(c.triggers.crons, [CRON]);
  assert.equal(c.main, 'worker.js');
  assert.equal(c.workers_dev, false);
  assert.deepEqual(CRON_MINUTES, [7, 37]);
  assert.equal(MAX_CRON_LATENESS_MS, 10 * 60000);
  assert.deepEqual({...TARGET}, {owner: 'lijianjun004-star', repo: 'tcl-live-monitor', workflow: 'v2-monitor.yml', ref: 'main'});
});

test('every dispatched input is declared by v2-monitor.yml workflow_dispatch', () => {
  const dispatch = workflow.slice(workflow.indexOf('workflow_dispatch:'), workflow.indexOf('\npermissions:'));
  for (const name of Object.keys(DISPATCH_INPUTS)) assert.match(dispatch, new RegExp('\\n      ' + name + ':'));
  assert.deepEqual({...DISPATCH_INPUTS}, {engine: 'live', fail_on_canary: 'false', continue_main_state: 'true'});
});

test('Beijing window: 07:37 blocked, 08:07 allowed, 23:37 allowed, 00:07 allowed, 00:37 blocked', () => {
  assert.equal(decide('2026-11-22T23:37:00.000Z').reason, 'OUTSIDE_BEIJING_WINDOW');
  assert.equal(decide('2026-11-23T00:07:00.000Z').dispatch, true);
  assert.equal(decide('2026-11-23T15:37:00.000Z').dispatch, true);
  assert.equal(decide('2026-11-23T16:07:00.000Z').dispatch, true);
  assert.equal(decide('2026-11-23T16:37:00.000Z').reason, 'OUTSIDE_BEIJING_WINDOW');
  assert.equal(beijingClock(ms('2026-11-23T00:07:00.000Z')).hour, 8);
});

test('33 dispatch slots per Beijing day', () => {
  let slots = 0;
  for (let m = 0; m < 24 * 60; m++) {
    const when = ms('2026-11-23T00:00:00.000Z') + m * 60000;
    if (decideRelay({scheduledMs: when, nowMs: when + 1000}).dispatch) slots++;
  }
  assert.equal(slots, 33);
});

test('only the :07 and :37 slots may press the button', () => {
  assert.equal(decide('2026-11-23T04:07:00.000Z').dispatch, true);
  assert.equal(decide('2026-11-23T04:08:00.000Z').reason, 'NOT_AN_AUTHORIZED_CRON_SLOT');
  assert.equal(decide('2026-11-23T04:30:00.000Z').reason, 'NOT_AN_AUTHORIZED_CRON_SLOT');
});

test('late cron events are skipped instead of bunching up', () => {
  assert.equal(decide('2026-11-23T04:07:00.000Z', 11 * 60000).reason, 'STALE_OR_FUTURE_CRON');
  assert.equal(decide('2026-11-23T04:07:00.000Z', 9 * 60000).dispatch, true);
  assert.equal(decide('2026-11-23T04:07:00.000Z', -2 * 60000).reason, 'STALE_OR_FUTURE_CRON');
});

test('invalid clocks fail closed', () => {
  assert.throws(() => decideRelay({scheduledMs: NaN, nowMs: Date.now()}), /INVALID_SCHEDULE_TIME/);
  assert.throws(() => beijingClock('wrong'), /INVALID_CLOCK/);
});

test('outside the window no GitHub request is made and no token is needed', async () => {
  let count = 0;
  const r = await runScheduled({scheduledMs: ms('2026-11-22T20:07:00.000Z'), nowMs: ms('2026-11-22T20:07:01.000Z'),
    request: async () => { count++; return {status: 204}; }});
  assert.equal(r.dispatch, false);
  assert.equal(count, 0);
});

test('a valid slot dispatches v2-monitor.yml on main with the clock inputs', async () => {
  const calls = [];
  const r = await runScheduled({scheduledMs: ms('2026-11-23T04:37:00.000Z'), nowMs: ms('2026-11-23T04:37:20.000Z'), token,
    request: async (url, opts) => { calls.push({url, opts}); return {status: 204}; }});
  assert.equal(r.accepted, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.github.com/repos/lijianjun004-star/tcl-live-monitor/actions/workflows/v2-monitor.yml/dispatches');
  assert.equal(calls[0].opts.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].opts.body),
    {ref: 'main', inputs: {engine: 'live', fail_on_canary: 'false', continue_main_state: 'true'}});
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer ' + token);
});

test('200 and 204 are accepted; errors carry only the status code', async () => {
  assert.equal((await dispatchV2({token, request: async () => ({status: 200})})).accepted, true);
  assert.equal((await dispatchV2({token, request: async () => ({status: 204})})).accepted, true);
  for (const status of [401, 403, 404, 422, 429, 500]) {
    await assert.rejects(dispatchV2({token, request: async () => ({status, body: 'secret'})}),
      error => error.message === 'GITHUB_DISPATCH_HTTP_' + status);
  }
});

test('a missing token is rejected before any request', async () => {
  let count = 0;
  await assert.rejects(dispatchV2({token: '', request: async () => { count++; return {status: 204}; }}),
    /GITHUB_ACTIONS_TOKEN_MISSING_OR_INVALID/);
  assert.equal(count, 0);
});

test('scheduled handler logs without the token and fails the event on a refused press', async () => {
  const logs = [];
  const original = console.log;
  const originalFetch = globalThis.fetch;
  console.log = line => logs.push(String(line));
  globalThis.fetch = async () => ({status: 401});
  try {
    const when = ms('2026-11-23T04:07:00.000Z');
    const realNow = Date.now;
    Date.now = () => when + 1000;
    try {
      await assert.rejects(worker.scheduled({scheduledTime: when}, {GH_ACTIONS_TOKEN: token}), /GITHUB_DISPATCH_HTTP_401/);
    } finally {
      Date.now = realNow;
    }
  } finally {
    console.log = original;
    globalThis.fetch = originalFetch;
  }
  assert.equal(logs.length, 1);
  assert.doesNotMatch(logs[0], /ghp_test|Bearer/);
  assert.equal(JSON.parse(logs[0]).accepted, false);
});
