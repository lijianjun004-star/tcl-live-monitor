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
  // Playwright Request uses methods, not fields. A pre-normalized request must
  // explicitly attest to main-frame and redirect-chain checks as well.
  let u,method,type,navigation,mainFrame,redirected;
  try {
    if (typeof request.url === 'function') {
      u=request.url();method=request.method();type=request.resourceType();
      navigation=request.isNavigationRequest();
      mainFrame=request.frame()?.parentFrame?.() === null;
      redirected=request.redirectedFrom() !== null;
    } else {
      u=request.url;method=request.method;type=request.resourceType;
      navigation=request.isNavigationRequest;
      mainFrame=request.isMainFrame === true;
      redirected=request.redirectedFrom !== null;
    }
  } catch { return false; }
  if (mainFrame !== true || redirected !== false) return false;
  if (!['GET', 'HEAD'].includes(method) || type !== 'document' ||
      navigation !== true || !allowedDocumentUrl(u)) return false;
  return allowedDocumentUrls.includes(u);
}
