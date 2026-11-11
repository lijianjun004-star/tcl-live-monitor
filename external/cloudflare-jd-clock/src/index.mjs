/**
 * TCL JD R3.5 | independent Cloudflare Workers Cron relay.
 *
 * Dispatches existing MAIN backup workflow. This Worker never reads a live
 * room, stores credentials in source, or writes JD state. Existing R3.4
 * same-repository MAIN-only 7-day serialized recheck remains authoritative.
 */
const TARGET = Object.freeze({
  owner: 'lijianjun004-star',
  repo: 'tcl-live-monitor',
  workflow: 'jd-r33-backup.yml',
  ref: 'main',
});
export const CRON = '4,9,14,19,34,49,59 * * * *';
export const CRON_MINUTES = Object.freeze([4, 9, 14, 19, 34, 49, 59]);
export const MAX_CRON_LATENESS_MS = 4 * 60_000;
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

/**
 * Verify intended cron slot and reject events delivered too late.
 * Beijing operating window is 06:30 through next-day 02:00 inclusive.
 * Not an SLA: missing cron events are still missing.
 */
export function decideRelay({nowMs, scheduledMs} = {}) {
  if (!Number.isFinite(nowMs) || !Number.isFinite(scheduledMs)) {
    throw new Error('INVALID_SCHEDULE_TIME');
  }
  const ageMs = nowMs - scheduledMs;
  if (ageMs < -60_000 || ageMs > MAX_CRON_LATENESS_MS) {
    return {dispatch: false, reason: 'STALE_OR_FUTURE_CRON'};
  }
  const scheduled = beijingClock(scheduledMs);
  const current = beijingClock(nowMs);
  const inside = clock => clock.minuteOfDay >= 390 || clock.minuteOfDay <= 120;
  if (!inside(scheduled) || !inside(current)) {
    return {dispatch: false, reason: 'OUTSIDE_BEIJING_OPERATING_WINDOW'};
  }
  if (!CRON_MINUTES.includes(scheduled.minute)) {
    return {dispatch: false, reason: 'NOT_AN_AUTHORIZED_CRON_SLOT'};
  }
  return {dispatch: true, reason: 'VALID_INDEPENDENT_CRON_OPPORTUNITY'};
}

/** Sealed API target; optional request injection is for offline tests only. */
export async function dispatchBackup({token, request = fetch} = {}) {
  if (typeof token !== 'string' || token.length < 20 || /\s/.test(token)) {
    throw new Error('GITHUB_ACTIONS_TOKEN_MISSING_OR_INVALID');
  }
  const uri =
    'https://api.github.com/repos/' +
    TARGET.owner + '/' + TARGET.repo +
    '/actions/workflows/' + TARGET.workflow + '/dispatches';
  const response = await request(uri, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2026-03-10',
      'User-Agent': 'tcl-jd-cron-relay-r35',
    },
    body: JSON.stringify({ref: TARGET.ref}),
  });
  if (response.status !== 200 && response.status !== 204) {
    // No response body or credentials in errors / telemetry.
    throw new Error('GITHUB_DISPATCH_HTTP_' + response.status);
  }
  return {accepted: true, status: response.status};
}

export async function runScheduled({
  scheduledMs,
  nowMs = Date.now(),
  token,
  request = fetch,
} = {}) {
  const decision = decideRelay({scheduledMs, nowMs});
  if (!decision.dispatch) return {...decision, accepted: false};
  const result = await dispatchBackup({token, request});
  return {...decision, ...result};
}

export default {
  async scheduled(controller, env) {
    const result = await runScheduled({
      scheduledMs: controller.scheduledTime,
      token: env.GH_ACTIONS_TOKEN,
    });
    // Never log secret, raw HTTP response or user data.
    console.log(JSON.stringify({
      component: 'tcl-jd-r35-clock',
      accepted: result.accepted,
      reason: result.reason,
      status: result.status ?? null,
    }));
  },
};
