/**
 * Fail-closed decision for a minimal public document request.
 * This pure policy neither installs browser interception nor proves isolation.
 * Only exact, explicitly supplied profile/room URLs can pass. All subresources,
 * including scripts, styles, XHR, fetch, media and sockets, are rejected.
 */
const PROFILE = /^\/user\/MS4wLjABAAAA[A-Za-z0-9_-]{20,150}$/;
const ROOM = /^\/\d{5,24}$/;

function allowedDocumentUrl(value) {
  if (typeof value !== 'string') return false;
  let parsed;
  try { parsed = new URL(value); } catch { return false; }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port ||
      parsed.search || parsed.hash || parsed.href !== value) return false;
  return (parsed.hostname === 'www.douyin.com' && PROFILE.test(parsed.pathname)) ||
    (parsed.hostname === 'live.douyin.com' && ROOM.test(parsed.pathname));
}

export function isAllowedRpaDocumentRequest(request, allowedDocumentUrls) {
  if (!Array.isArray(allowedDocumentUrls) || allowedDocumentUrls.length < 1 ||
      allowedDocumentUrls.length > 4 || new Set(allowedDocumentUrls).size !== allowedDocumentUrls.length ||
      !allowedDocumentUrls.every(allowedDocumentUrl)) return false;
  if (!request || typeof request !== 'object' || Array.isArray(request)) return false;
  if (!['GET', 'HEAD'].includes(request.method) || request.resourceType !== 'document' ||
      request.isNavigationRequest !== true || !allowedDocumentUrl(request.url)) return false;
  return allowedDocumentUrls.includes(request.url);
}
