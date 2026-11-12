const PLATFORMS = Object.freeze(['jd', 'douyin']);
const ACTIONS = Object.freeze(['status', 'run_once', 'enable_auto', 'disable_auto']);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validIso = value => {
  if (typeof value !== 'string' || !ISO.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
};

export function validateRuntimeSwitch(state) {
  if (!isRecord(state) || state.schemaVersion !== 1 ||
      !isRecord(state.autoEnabled) || !isRecord(state.sourceAccessApproved) ||
      !isRecord(state.adapterReady) ||
      !PLATFORMS.every(p => typeof state.autoEnabled[p] === 'boolean' &&
        typeof state.sourceAccessApproved[p] === 'boolean' &&
        typeof state.adapterReady[p] === 'boolean') ||
      !validIso(state.updatedAt) ||
      typeof state.updatedBy !== 'string' || !state.updatedBy ||
      (state.updatedByRunId !== null && typeof state.updatedByRunId !== 'string'))
    return { valid: false, reason: 'RUNTIME_SWITCH_SCHEMA_INVALID' };
  return { valid: true };
}

export function isBeijingOperatingWindow(date) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return false;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai', hourCycle: 'h23', hour: '2-digit', minute: '2-digit'
  }).formatToParts(date);
  const hour = Number(parts.find(p => p.type === 'hour')?.value);
  const minute = Number(parts.find(p => p.type === 'minute')?.value);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return false;
  const localMinutes = hour * 60 + minute;
  return localMinutes >= 6 * 60 + 30 || localMinutes < 2 * 60;
}

function selectedPlatforms(platform) {
  if (platform === 'both') return [...PLATFORMS];
  if (PLATFORMS.includes(platform)) return [platform];
  return null;
}

/**
 * Plans a bounded one-shot run or a persistent switch update.
 * It never opens a timer, polls, or performs network I/O.
 *
 * Workflow contract:
 * - schedule: run only auto-enabled platforms, once, during the Beijing window.
 * - workflow_dispatch/run_once: one immediate scan, independent of auto switches.
 * - enable_auto/disable_auto: persist selected switch bits only; do not scan now.
 * - source approval and adapter readiness are independent, reviewed gates.
 */
export function planRuntimeAction({
  eventName, action = null, platform = 'both', state, now,
  actor = 'unknown', runId = null
} = {}) {
  const checked = validateRuntimeSwitch(state);
  if (!checked.valid) return { decision: 'BLOCK', reason: checked.reason, sourceAccess: false };
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()))
    return { decision: 'BLOCK', reason: 'RUNTIME_CLOCK_INVALID', sourceAccess: false };

  if (eventName === 'schedule') {
    if (!isBeijingOperatingWindow(now))
      return { decision: 'SKIP', reason: 'OUTSIDE_BEIJING_OPERATING_WINDOW', targets: [], sourceAccess: false };
    const targets = PLATFORMS.filter(p => state.autoEnabled[p]);
    if (!targets.length)
      return { decision: 'SKIP', reason: 'ALL_AUTOMATIC_SWITCHES_OFF', targets: [], sourceAccess: false };
    return buildOneShot(targets, state, 'SCHEDULED_ONE_SHOT');
  }

  if (eventName !== 'workflow_dispatch' || !ACTIONS.includes(action))
    return { decision: 'BLOCK', reason: 'UNSUPPORTED_TRIGGER_OR_ACTION', sourceAccess: false };

  if (action === 'status')
    return { decision: 'STATUS', state, sourceAccess: false };

  const targets = selectedPlatforms(platform);
  if (!targets)
    return { decision: 'BLOCK', reason: 'INVALID_PLATFORM_SELECTION', sourceAccess: false };

  if (action === 'enable_auto' || action === 'disable_auto') {
    const enabled = action === 'enable_auto';
    const nextState = {
      ...state,
      autoEnabled: { ...state.autoEnabled, ...Object.fromEntries(targets.map(p => [p, enabled])) },
      updatedAt: now.toISOString(),
      updatedBy: actor,
      updatedByRunId: runId === null ? null : String(runId)
    };
    return {
      decision: 'CONTROL_UPDATE',
      action,
      targets,
      nextState,
      sourceAccess: false,
      scanNow: false
    };
  }

  return buildOneShot(targets, state, 'MANUAL_ONE_SHOT');
}

function buildOneShot(targets, state, trigger) {
  const results = targets.map(platform => {
    if (state.sourceAccessApproved[platform] !== true)
      return { platform, status: 'BLOCKED', reason: 'SOURCE_ACCESS_NOT_APPROVED', sourceAccess: false };
    if (state.adapterReady[platform] !== true)
      return { platform, status: 'BLOCKED', reason: 'SOURCE_ADAPTER_NOT_READY', sourceAccess: false };
    return { platform, status: 'READY_FOR_SINGLE_SCAN', reason: 'ONE_SHOT_ONLY', sourceAccess: true };
  });
  const ready = results.filter(x => x.status === 'READY_FOR_SINGLE_SCAN');
  const blocked = results.filter(x => x.status === 'BLOCKED');
  return {
    decision: ready.length ? 'ONE_SHOT' : 'BLOCKED',
    trigger,
    targets: results,
    blockedCount: blocked.length,
    readyCount: ready.length,
    sourceAccess: ready.length > 0,
    continuousPolling: false,
    runUntilCompleteThenExit: true
  };
}
