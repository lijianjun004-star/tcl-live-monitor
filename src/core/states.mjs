// Tri-state model. UNKNOWN is a first-class state and is NEVER coerced into OFFLINE.
export const LIVE = 'LIVE';
export const OFFLINE = 'OFFLINE';
export const UNKNOWN = 'UNKNOWN';
export const STATES = Object.freeze([LIVE, OFFLINE, UNKNOWN]);

/**
 * Normalize one raw observation from any collector.
 * An OFFLINE without explicit evidence (`offlineEvidence: true`) is downgraded to UNKNOWN,
 * because "live badge not seen", HTTP 200, timeouts or challenge pages are not stop proof.
 */
export function normalizeObservation(raw) {
  if (!raw || typeof raw !== 'object') throw new TypeError('observation must be object');
  const at = Number(raw.at);
  if (!Number.isFinite(at)) throw new TypeError('observation.at must be epoch ms');
  if (typeof raw.accountId !== 'string' || !raw.accountId) throw new TypeError('observation.accountId required');
  const s = String(raw.state || '').toUpperCase();
  let state = UNKNOWN;
  let reason = raw.reason || null;
  if (s === LIVE) state = LIVE;
  else if (s === OFFLINE) {
    if (raw.offlineEvidence === true) state = OFFLINE;
    else reason = 'OFFLINE_WITHOUT_EVIDENCE_DOWNGRADED';
  } else if (s !== UNKNOWN) reason = reason || 'UNRECOGNIZED_STATE';
  return { accountId: raw.accountId, at, state, reason, source: raw.source || 'unspecified' };
}

/**
 * Combine the states of several platform accounts that belong to ONE physical room at one
 * sample point (cross-platform simulcast de-duplication):
 *   any LIVE -> LIVE; all observed accounts OFFLINE (and none missing) -> OFFLINE; else UNKNOWN.
 */
export function combineRoomState(states, expectedAccounts) {
  if (states.includes(LIVE)) return LIVE;
  if (states.length > 0 && states.length >= expectedAccounts && states.every(s => s === OFFLINE)) return OFFLINE;
  return UNKNOWN;
}
