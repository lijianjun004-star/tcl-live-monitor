/**
 * TCL V2 monitor | independent Cloudflare Workers Cron relay.
 *
 * GitHub Actions `schedule` on this repository fires only a few times a day
 * (designed every 30 minutes). This Worker presses the existing
 * workflow_dispatch button of .github/workflows/v2-monitor.yml instead.
 * It never opens a live room, stores credentials in source, or writes state.
 *
 * Self-contained single file: it can be pasted into the Cloudflare dashboard
 * editor as is, or deployed with `npx wrangler deploy`.
 * Required secret: GH_ACTIONS_TOKEN (fine-grained token, this repository only,
 * Actions: read and write).
 */
export const TARGET = Object.freeze({
  owner: 'lijianjun004-star',
  repo: 'tcl-live-monitor',
  workflow: 'v2-monitor.yml',
  ref: 'main',
});
// Cloudflare cron runs in UTC; minute 7/37 is also Beijing :07/:37 and
// avoids the busy top and bottom of the hour.
export const CRON = '7,37 * * * *';
export const CRON_MINUTES = Object.freeze([7, 37]);
// Beijing 08:00 through next-day 00:10, matching the V2 08:00-24:00 window.
export const WINDOW_START_MINUTE = 8 * 60;
export const WINDOW_END_MINUTE = 10;
export const MAX_CRON_LATENESS_MS = 10 * 60_000;
export const DISPATCH_INPUTS = Object.freeze({
  engine: 'live',
  fail_on_canary: 'false',
  continue_main_state: 'true',
});
const OFFSET_MS = 8 * 3_600_000;

export function beijingClock(value) {
  const ms = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(ms)) throw new Error('INVALID_CLOCK');
  const d = new Date(ms + OFFSET_MS);
  return {
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    minuteOfDay: d.getUTCHours() * 60 + d.getUTCMinutes(),
  };
}

function insideWindow(clock) {
  return clock.minuteOfDay >= WINDOW_START_MINUTE || clock.minuteOfDay <= WINDOW_END_MINUTE;
}

/** Decide whether one cron event may press the button. Not an SLA. */
export function decideRelay({nowMs, scheduledMs} = {}) {
  if (!Number.isFinite(nowMs) || !Number.isFinite(scheduledMs)) {
    throw new Error('INVALID_SCHEDULE_TIME');
  }
  const ageMs = nowMs - scheduledMs;
  if (ageMs < -60_000 || ageMs > MAX_CRON_LATENESS_MS) {
    return {dispatch: false, reason: 'STALE_OR_FUTURE_CRON'};
  }
  const scheduled = beijingClock(scheduledMs);
  if (!insideWindow(scheduled) || !insideWindow(beijingClock(nowMs))) {
    return {dispatch: false, reason: 'OUTSIDE_BEIJING_WINDOW'};
  }
  if (!CRON_MINUTES.includes(scheduled.minute)) {
    return {dispatch: false, reason: 'NOT_AN_AUTHORIZED_CRON_SLOT'};
  }
  return {dispatch: true, reason: 'VALID_CRON_SLOT'};
}

/** Sealed API target; the request parameter exists for offline tests only. */
export async function dispatchV2({token, request = fetch} = {}) {
  if (typeof token !== 'string' || token.length < 20 || /\s/.test(token)) {
    throw new Error('GITHUB_ACTIONS_TOKEN_MISSING_OR_INVALID');
  }
  const uri = 'https://api.github.com/repos/' + TARGET.owner + '/' + TARGET.repo +
    '/actions/workflows/' + TARGET.workflow + '/dispatches';
  const response = await request(uri, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2026-03-10',
      'User-Agent': 'tcl-v2-cron-relay',
    },
    body: JSON.stringify({ref: TARGET.ref, inputs: DISPATCH_INPUTS}),
  });
  if (response.status !== 200 && response.status !== 204) {
    // No response body or credentials in errors or logs.
    throw new Error('GITHUB_DISPATCH_HTTP_' + response.status);
  }
  return {accepted: true, status: response.status};
}

export async function runScheduled({scheduledMs, nowMs = Date.now(), token, request = fetch} = {}) {
  const decision = decideRelay({scheduledMs, nowMs});
  if (!decision.dispatch) return {...decision, accepted: false};
  return {...decision, ...(await dispatchV2({token, request}))};
}

export default {
  async scheduled(controller, env) {
    let result, failure = null;
    try {
      result = await runScheduled({scheduledMs: controller.scheduledTime, token: env.GH_ACTIONS_TOKEN});
    } catch (error) {
      failure = String(error && error.message || 'ERROR').slice(0, 60);
      result = {accepted: false, reason: failure};
    }
    // Never log the secret, raw HTTP responses or user data.
    console.log(JSON.stringify({
      component: 'tcl-v2-clock',
      accepted: result.accepted,
      reason: result.reason,
      status: result.status ?? null,
    }));
    // Surface a failed press (for example an expired token) as a failed cron event.
    if (failure) throw new Error(failure);
  },
};
