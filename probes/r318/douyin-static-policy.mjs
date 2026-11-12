/**
 * R3.18 PUBLIC resource-policy review. No network I/O.
 * Default policy is deliberately unchanged: read-only Douyin HTTPS only.
 * The candidate CDN mode is testable OFFLINE, but is NEVER activated by this RPA.
 * A subsequent explicitly approved PR and controlled run are required to activate it.
 */
export const CORE_STATIC_CANDIDATES = Object.freeze([
  'lf-douyin-pc-web.douyinstatic.com',
  'lf-douyin-pc-web-back.douyinstatic.com',
]);
export const UNKNOWN_STATIC_CANDIDATES = Object.freeze([
  'lf3-cdn-tos.bytegoofy.com',
]);
const CORE = new Set(CORE_STATIC_CANDIDATES);
const SAFE_STATIC_TYPES = new Set(['script', 'stylesheet']);
const FORBIDDEN_TYPES = new Set(['media', 'websocket', 'eventsource']);
const ALLOWED_METHODS = new Set(['GET', 'HEAD']);

const result = (allow, reason, candidateForApproval = false) =>
  Object.freeze({ allow, reason, candidateForApproval });

/**
 * @param {object} req - { url, method, resourceType }
 * @param {object} opts - { approvedCoreStatic } only accepted for offline tests.
 */
export function classifyDouyinResource(req, { approvedCoreStatic = false } = {}) {
  let u;
  try { u = new URL(req?.url); } catch { return result(false, 'INVALID_URL'); }
  const method = String(req?.method || '').toUpperCase();
  const type = String(req?.resourceType || '');
  if (u.protocol !== 'https:' || u.username || u.password) return result(false, 'NON_HTTPS_OR_CREDENTIAL_URL');
  if (!ALLOWED_METHODS.has(method)) return result(false, 'NON_READONLY_METHOD');
  if (FORBIDDEN_TYPES.has(type)) return result(false, 'MEDIA_OR_DUPLEX_BLOCKED');
  if (u.hostname === 'douyin.com' || u.hostname.endsWith('.douyin.com'))
    return result(true, 'APPROVED_DOUYIN_HOST');
  const candidate = CORE.has(u.hostname) && SAFE_STATIC_TYPES.has(type) && method === 'GET';
  if (candidate) return approvedCoreStatic
    ? result(true, 'EXPLICITLY_APPROVED_CORE_STATIC')
    : result(false, 'CORE_STATIC_NEEDS_APPROVAL', true);
  // Third-party CDN hosts often mix assets, tracking and dynamic endpoints:
  // no host-wide permits, including *.bytegoofy.com, bytetos.com, or sijieapi.
  if (UNKNOWN_STATIC_CANDIDATES.includes(u.hostname))
    return result(false, 'THIRD_PARTY_CDN_NOT_REVIEWED', SAFE_STATIC_TYPES.has(type));
  return result(false, 'THIRD_PARTY_BLOCKED');
}

/** Public aggregates; never store URLs, paths, cookies or user IDs. */
export function tallyBlocked(items) {
  if (!Array.isArray(items)) throw Error('RESOURCE_AUDIT_INPUT_INVALID');
  const out = {};
  for (const i of items) {
    const v = classifyDouyinResource(i);
    if (v.allow) continue;
    const host = (() => { try { return new URL(i.url).hostname; } catch { return 'invalid'; } })();
    // Aggregating all host names is safe but may contain a user-generated subdomain.
    // Use known fixed host labels only, otherwise a generic "OTHER".
    const fixed = CORE.has(host) || UNKNOWN_STATIC_CANDIDATES.includes(host) ? host : 'OTHER';
    const key = fixed + ':' + String(i.resourceType || 'unknown').replace(/[^a-z]/g,'').slice(0,15);
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}
