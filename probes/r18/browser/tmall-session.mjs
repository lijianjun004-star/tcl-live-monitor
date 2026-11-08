import { safeBrowserCheck } from './session.mjs';
import { ACCOUNT_ID, PAGE_URL, parsePage, parsePassiveResponse } from '../sources/tmall/index.mjs';

/** Resolve only attested evidence from this navigation. Room changes alone do not imply conflict. */
export function resolveSessionEvidence(observations, fallback) {
  const blocked = observations.find(o => ['CAPTCHA_OR_SECURITY_BLOCK', 'HUMAN_VERIFICATION_REQUIRED', 'AUTH_REQUIRED', 'PLATFORM_THROTTLED'].includes(o.failure_code));
  if (blocked) return { ...fallback, failure_code: blocked.failure_code };
  const candidates = observations.filter(o => o.source_attested === true && (o.state === 'LIVE' || o.state === 'OFFLINE'));
  const distinct = new Set(candidates.map(o => `${o.account_id}|${o.state}|${o.live_id ?? ''}`));
  if (distinct.size > 1) return { ...fallback, failure_code: 'CONFLICTING_EVIDENCE', conflicting_evidence: true };
  if (!candidates.length) return fallback;
  return { ...candidates[candidates.length - 1], actual_check_at: fallback.actual_check_at };
}

/** Explicit user-invoked normal session check; no login, challenge solving, or replay. */
export async function observeTmallSession(options = {}) {
  const observations = [];
  const planned = options.planned_check_at || new Date().toISOString();
  return safeBrowserCheck({
    ...options, url: PAGE_URL, platform: 'tmall', account_id: ACCOUNT_ID, planned_check_at: planned,
    onResponse: ({ data, status, captured_at, response_url, page_url }) => {
      // This attestation flag is set only here, after an actual browser response event.
      observations.push(parsePassiveResponse({ payload: data, status, captured_at, response_url, page_url,
        planned_check_at: planned, actual_check_at: new Date().toISOString(), transport_attested: true }));
    },
    onPage: ({ text, url, status }) => {
      const fallback = parsePage({ html: text, final_url: url, status, planned_check_at: planned, actual_check_at: new Date().toISOString() });
      return resolveSessionEvidence(observations, fallback);
    }
  });
}
