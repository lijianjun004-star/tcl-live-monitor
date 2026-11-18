// An allowlist, never a truncated native message (which may contain a URL/token/body).
const fixed=new Set(['BASE_NOT_SET','BASE_URL_INVALID','BASE_PROTOCOL_INVALID','BASE_MUST_BE_ORIGIN','PATH_NOT_ALLOWED',
 'BODY_TOO_LARGE','INVALID_JSON','HTTP_ERROR','HTTP_ACCESS_DENIED','HTTP_RATE_LIMITED',
 'HTTP_SERVER_ERROR','CATALOG_PAGINATED_OR_INCOMPLETE','CATALOG_TOTAL_MISMATCH',
 'ROOM_LIMIT_EXCEEDED','SCHEMA_ROOMS_ARRAY_MISSING','SCHEMA_SHOPS_ARRAY_MISSING',
 'SCHEMA_HEARTBEATS_ARRAY_MISSING','NO_JD_ROOMS_IN_CATALOG','SCHEMA_DAILY_ARRAY_MISSING','SCHEMA_DAILY_INVALID']);
export function sourceError(error) {
 const codes=[error?.code,error?.cause?.code];
 if(codes.includes('UND_ERR_CONNECT_TIMEOUT'))return 'CONNECT_TIMEOUT';
 if(codes.some(x=>['ETIMEDOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT'].includes(x))||error?.name==='TimeoutError')return 'TIMEOUT';
 if(error?.name==='AbortError')return 'ABORTED';
 if(codes.some(x=>['ENOTFOUND','EAI_AGAIN'].includes(x)))return 'DNS_FAILURE';
 if(codes.includes('ECONNREFUSED'))return 'CONNECTION_REFUSED';
 if(codes.includes('ECONNRESET'))return 'CONNECTION_RESET';
 if(codes.some(x=>['ENETUNREACH','EHOSTUNREACH'].includes(x)))return 'NETWORK_UNREACHABLE';
 if(codes.some(x=>['CERT_HAS_EXPIRED','DEPTH_ZERO_SELF_SIGNED_CERT','ERR_TLS_CERT_ALTNAME_INVALID'].includes(x)))return 'TLS_FAILURE';
 if(fixed.has(error?.message))return error.message;
 return 'SOURCE_ERROR';
}
