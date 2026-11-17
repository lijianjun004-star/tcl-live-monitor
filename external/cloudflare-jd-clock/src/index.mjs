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
  if (!Number.isFinite(ms) || !Number.isFinite(new Date(ms + OFFSET_MS).getTime())) throw new Error('INVALID_CLOCK');
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
export async function dispatchBackup({token, request = fetch, timeoutMs = 10_000} = {}) {
  if (typeof token !== 'string' || token.length < 20 || /\s/.test(token)) {
    throw new Error('GITHUB_ACTIONS_TOKEN_MISSING_OR_INVALID');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) {
    throw new Error('INVALID_REQUEST_TIMEOUT');
  }
  const uri = 'https://api.github.com/repos/' + TARGET.owner + '/' + TARGET.repo +
    '/actions/workflows/' + TARGET.workflow + '/dispatches';
  const controller = new AbortController();
  let timer;
  let timedOut = false;
  try {
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new Error('GITHUB_DISPATCH_TIMEOUT_OUTCOME_UNKNOWN'));
      }, timeoutMs);
    });
    let response;
    try {
      response = await Promise.race([deadline, Promise.resolve().then(() => request(uri, {
        method: 'POST', redirect: 'manual', signal: controller.signal,
        headers: {
          Authorization: 'Bearer ' + token,
          Accept: 'application/vnd.github+json', 'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2026-03-10', 'User-Agent': 'tcl-jd-cron-relay-r35',
        },
        body: JSON.stringify({ref: TARGET.ref}),
      }))]);
    } catch {
      throw new Error(timedOut ? 'GITHUB_DISPATCH_TIMEOUT_OUTCOME_UNKNOWN' :
        'GITHUB_DISPATCH_TRANSPORT_OUTCOME_UNKNOWN');
    }
    if (response?.redirected || response?.type === 'opaqueredirect' ||
        (response?.url && response.url !== uri) ||
        (response?.status >= 300 && response.status < 400)) {
      throw new Error('GITHUB_DISPATCH_REDIRECT_REJECTED');
    }
    if (!Number.isInteger(response?.status) || response.status < 100 || response.status > 599) {
      throw new Error('GITHUB_DISPATCH_INVALID_RESPONSE');
    }
    if (response.status !== 200 && response.status !== 204) {
      throw new Error('GITHUB_DISPATCH_HTTP_' + response.status);
    }
    // Acceptance is not a workflow run ID, completion, or source success.
    return {accepted: true, status: response.status, workflowRunId: null,
      sourceOutcome: 'UNVERIFIED'};
  } finally {
    clearTimeout(timer);
  }
}

export async function runScheduled({
  scheduledMs,
  nowMs = Date.now(),
  token,
  request = fetch,
} = {}) {
  const decision = decideRelay({scheduledMs, nowMs});
  if (!decision.dispatch) return {...decision, accepted: false};
  // No durable reservation / trusted run-result feedback exists in this candidate.
  // Do not mistake GitHub acceptance or an isolate-local variable for either.
  return {dispatch: false, accepted: false,
    reason: 'PERSISTENCE_AND_SOURCE_FEEDBACK_UNCONFIGURED',
    opportunityId: 'jd-clock-' + scheduledMs, workflowRunId: null,
    sourceOutcome: 'UNVERIFIED'};
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
      opportunityId: result.opportunityId ?? null,
    }));
  },
};
