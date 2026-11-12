/** Approved single HTTPS transport check: no credentials, no body logging, no redirects. */
const EXPECTED='R315_APPROVED_TLS_HANDSHAKE_ONCE';
if (process.env.R315_TLS_PROBE !== EXPECTED) throw Error('TLS_PROBE_EXPLICIT_GUARD_REQUIRED');
const url='https://101.96.215.251/api/shops'; // Previously user-supplied TCL reference origin, HTTPS candidate only.
let status='TLS_UNVERIFIED',httpStatus=null,contentTypeSupported=false,reason='NOT_REACHED';
try {
 const response=await fetch(url,{method:'GET',redirect:'error',credentials:'omit',
   headers:{accept:'application/json'},signal:AbortSignal.timeout(8000)});
 httpStatus=response.status;
 const mime=response.headers.get('content-type')||'';
 contentTypeSupported=/^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|\s*$)/i.test(mime);
 status=response.status===200&&contentTypeSupported?'HTTPS_TRANSPORT_OK':'HTTPS_CONTRACT_BLOCKED';
 reason=response.status===200?(contentTypeSupported?'TLS_AND_JSON_HEADER_OK':'NON_JSON_RESPONSE'):
   ([401,403,429].includes(response.status)?'ACCESS_BLOCKED':'NON_200');
 await response.body?.cancel().catch(()=>{});
} catch {
 status='HTTPS_UNAVAILABLE_OR_CERT_UNVERIFIED';
 reason='NO_VALID_TLS_AND_READONLY_HTTP_RESPONSE';
}
console.log('R315_TLS_SOURCE_SAFE_SUMMARY '+JSON.stringify({
  checkedAt:new Date().toISOString(),platform:'multi',approvedRouteCount:1,
  tlsStatus:status,httpStatus,contentTypeSupported,reason,
  sentCredentials:false,followedRedirects:false,rawBodyStored:false,
  sourceSchemaVerified:false,actualLiveStatusVerified:false
}));
