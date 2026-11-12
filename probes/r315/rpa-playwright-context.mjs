/** R3.15 LOCAL-ONLY browser integration. This is never a live-site crawler.
 * It validates our real Playwright request adapter, main-frame rules, popup
 * behavior and WebRTC disablement without permitting outbound requests.
 */
import {isAllowedRpaDocumentRequest} from './rpa-network-policy.mjs';
export async function installOfflineRpaContextBoundary(context,{fixtureDocuments}={}){
 if(!context||typeof context.route!=='function'||typeof context.addInitScript!=='function'||
    !fixtureDocuments||typeof fixtureDocuments!=='object'||Array.isArray(fixtureDocuments))
   throw Error('R315_BROWSER_CONTEXT_INVALID');
 const urls=Object.keys(fixtureDocuments);
 if(!urls.length||urls.length>4||urls.some(url=>typeof fixtureDocuments[url]!=='string'||
   fixtureDocuments[url].length>50000))throw Error('R315_FIXTURE_INVALID');
 await context.addInitScript(()=>{
  // Belt-and-suspenders ONLY. Browser-internal transports still need OS-level
  // UDP/network sandbox before any genuine third-party site is visited.
  for(const prop of ['RTCPeerConnection','webkitRTCPeerConnection','mozRTCPeerConnection']){
   try{Object.defineProperty(window,prop,{value:undefined,writable:false,configurable:false})}catch{}
  }
 });
 const rejected=[];
 await context.route('**/*',async route=>{
  const request=route.request();
  if(isAllowedRpaDocumentRequest(request,urls)){
   return route.fulfill({status:200,contentType:'text/html; charset=utf-8',
     body:fixtureDocuments[request.url()]});
  }
  // No redirect, subframe, pop-up remote resource, XHR, websocket, media or DNS
  // prefetch is allowed by this harness. It *never* calls route.continue().
  rejected.push({method:request.method(),type:request.resourceType()});
  await route.abort('blockedbyclient');
 });
 return {rejectedRequests:rejected,mode:'OFFLINE_FIXTURE_ONLY',outboundAllowed:false};
}
