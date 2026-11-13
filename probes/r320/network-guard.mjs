/**
 * R3.20 fail-closed browser network guard.
 * The route handler MUST NOT call route.continue(): Chromium follows its 3xx
 * redirects without re-entering Playwright routing.
 * route.fetch({ maxRedirects: 0 }) obtains only the first HTTP response;
 * a redirect is aborted BEFORE its headers ever reach the browser.
 *
 * This module has no network I/O except guardedRoute's explicit route.fetch().
 */
import { classifyDouyinResource } from '../r318/douyin-static-policy.mjs';

const AUTH_PART = /(?:^|[./?&=_-])(login|logout|passport|verify|verification|captcha|sso|challenge|security-check)(?:$|[./?&=_-])/i;

export function isAccessGate(url) {
  try {
    const u = new URL(url);
    return AUTH_PART.test(u.hostname) || AUTH_PART.test(u.pathname) || AUTH_PART.test(u.search);
  } catch { return true; }
}

export function denyGateResource(info, opt={}) {
  if(isAccessGate(info?.url)) return {allow:false,reason:'ACCESS_GATE_PATH_OR_HOST'};
  return classifyDouyinResource(info,opt);
}

export function inspectHttpResponse(status, headers={}) {
  if(!Number.isInteger(status) || status<100 || status>599) return 'HTTP_STATUS_INVALID';
  if([401,403,429].includes(status)) return 'HTTP_'+status;
  if(status>=300 && status<400) {
    // Even same-origin/canonical redirects are deliberately stopped. A 304
    // with no cache is non-actionable. Never deliver 3xx to route.fulfill.
    if(status===304) return 'HTTP_NOT_MODIFIED_UNEXPECTED';
    const loc=headers.location ?? headers.Location;
    return typeof loc==='string' && loc.trim() ? 'HTTP_REDIRECT_BLOCKED' : 'REDIRECT_LOCATION_INVALID';
  }
  // Other statuses including 404 and 5xx mean the page was not verified.
  if(status<200 || status>=300) return 'HTTP_'+status+'_NOT_VERIFIED';
  return null;
}

/**
 * Mockable for loopback tests, with a default fail-closed production policy.
 * The caller's stop() sets a shared permanent stop condition for all pages.
 * No paths, redirects or account identifiers enter diagnostic labels.
 */
export async function guardedRoute(route,{
  approvedCoreStatic=false,
  isStopped=()=>false,
  stop=()=>{},
  tallyAllowed=()=>{},
  tallyBlocked=()=>{},
  policy=denyGateResource,
}={}) {
  const request=route.request();
  const info={url:request.url(),method:request.method(),resourceType:request.resourceType()};
  const forbidden=policy(info,{approvedCoreStatic});
  const safeAbort=async()=>{
    try { await route.abort('blockedbyclient'); } catch { /* page already closed */ }
  };
  if(isStopped()) { await safeAbort(); return {decision:'STOPPED'}; }
  if(!forbidden?.allow) {
    tallyBlocked(info, forbidden?.reason || 'DENIED');
    await safeAbort();
    return {decision:'DENIED',reason:forbidden?.reason || 'DENIED'};
  }
  try {
    // The Playwright API fetch performs only the approved first hop.
    // Never use route.continue/fallback or route.fulfill with a 3xx.
    const response=await route.fetch({maxRedirects:0,maxRetries:0,timeout:12000});
    const status=response.status();
    const reason=inspectHttpResponse(status,response.headers());
    if(reason) {
      stop(reason);
      await safeAbort();
      return {decision:'STOP',reason};
    }
    if(isStopped()) { await safeAbort(); return {decision:'STOPPED'}; }
    await route.fulfill({response});
    tallyAllowed(info,forbidden.reason);
    return {decision:'FULFILLED',status};
  } catch {
    stop('ROUTED_FETCH_FAILED');
    await safeAbort();
    return {decision:'STOP',reason:'ROUTED_FETCH_FAILED'};
  }
}

/** Prevent browser-side UDP WebRTC, workers and unrouteable beacons before any page scripts run. */
export function disableUnroutedChannels() {
  const blocked=()=>{ throw new Error('R320_PUBLIC_GUEST_CHANNEL_DISABLED'); };
  for(const key of ['RTCPeerConnection','webkitRTCPeerConnection','Worker','SharedWorker','EventSource','WebSocket']) {
    try { Object.defineProperty(window,key,{value:blocked,configurable:false,writable:false}); } catch {}
  }
  try { Object.defineProperty(navigator,'sendBeacon',{value:()=>false,configurable:false,writable:false}); } catch {}
  try {
    if('serviceWorker' in navigator) {
      Object.defineProperty(navigator.serviceWorker,'register',{value:blocked,configurable:false,writable:false});
    }
  } catch {}
}
