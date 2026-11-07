// Pure helpers for R0.9.9 field verification (no network).

/** Name the platform shows for a Douyin profile page title ("X的抖音 - 抖音" / "X的主页 - 抖音"). */
export function platformNameFromTitle(title) {
  return /^(.*)的(?:抖音|主页) - 抖音$/.exec(String(title || '').trim())?.[1] || null;
}

// mtop ret codes. Throttle/validation codes mean the platform is pushing back: cool down, never bypass.
export const MTOP_THROTTLE_RE = /^(RGV587_ERROR|FAIL_SYS_USER_VALIDATE|FAIL_SYS_TRAFFIC_LIMIT|FAIL_SYS_ILLEGAL_ACCESS|FAIL_SYS_FLOWLIMIT|FAIL_SYS_SERVICE_BUSY|FAIL_SYS_HSF_THROWN)/;
export const MTOP_TOKEN_RE = /^FAIL_SYS_TOKEN_(EMPTY|EXOIRED|EXPIRED|ILLEGAL)/;

/**
 * Classify the full sequence of live-detail ret codes seen during ONE page load.
 * The H5 page normally retries once by itself after a token error, so TOKEN then SUCCESS is healthy.
 */
export function classifyMtopSequence(retCodes) {
  const codes = (retCodes || []).map(c => String(c || '').split('::')[0]).filter(Boolean);
  if (!codes.length) return { kind: 'NO_RESPONSE', codes };
  if (codes.some(c => c.startsWith('SUCCESS'))) return { kind: codes.some(c => MTOP_TOKEN_RE.test(c)) ? 'SUCCESS_AFTER_TOKEN_REFRESH' : 'SUCCESS', codes };
  if (codes.some(c => MTOP_THROTTLE_RE.test(c))) return { kind: 'THROTTLED_OR_VALIDATION', codes };
  if (codes.every(c => MTOP_TOKEN_RE.test(c))) return { kind: 'TOKEN_ONLY_NO_RETRY', codes };
  return { kind: 'OTHER_ERROR', codes };
}
