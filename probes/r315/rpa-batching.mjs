/** Build a stable plan of approved keys; execution still requires frequency and browser guards. */
const PROFILE = /^\/user\/MS4wLjABAAAA[A-Za-z0-9_-]{20,150}$/;
function validProfile(raw) {
  if (typeof raw !== 'string') return false;
  let url;
  try { url = new URL(raw); } catch { return false; }
  return url.href === raw && url.protocol === 'https:' && url.hostname === 'www.douyin.com' &&
    !url.port && !url.username && !url.password && !url.search && !url.hash && PROFILE.test(url.pathname);
}
export function planApprovedDouyinBatches(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config) || !Array.isArray(config.douyin)) {
    throw new Error('RPA_BATCH_INVALID_CONFIG');
  }
  const seen = new Set(), approvedProfiles = new Set();
  const approved = [];
  for (const target of config.douyin) {
    if (!target || typeof target !== 'object' || Array.isArray(target) ||
        typeof target.key !== 'string' || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(target.key) ||
        typeof target.scopeApproved !== 'boolean' || seen.has(target.key)) {
      throw new Error('RPA_BATCH_INVALID_TARGET');
    }
    seen.add(target.key);
    if (target.scopeApproved === true) {
      if (!validProfile(target.profileUrl) || approvedProfiles.has(target.profileUrl)) {
        throw new Error('RPA_BATCH_INVALID_OR_DUPLICATE_PROFILE');
      }
      approvedProfiles.add(target.profileUrl);
      approved.push(target.key);
    }
  }
  if (!approved.length) throw new Error('RPA_BATCH_NO_APPROVED_TARGETS');
  approved.sort();
  const batches = [];
  for (let i = 0; i < approved.length; i += 2) batches.push(approved.slice(i, i + 2));
  return batches;
}
