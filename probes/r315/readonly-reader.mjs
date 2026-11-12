/**
 * Explicitly approved, HTTPS-only read-only transport. No logging/persistence.
 * fetchImpl MUST actually honor AbortSignal: the deadline can stop this caller
 * waiting but cannot terminate an underlying transport that ignores abort.
 * Approved origins, exact platform values, dates and per-platform room IDs must
 * be injected from an independent authorization review. Validator functions are caller-supplied;
 * this reader alone cannot establish their correctness or live-source safety.
 */
const PATHS = new Set(['/api/shops', '/api/capture/rooms', '/api/assistant/active-rooms', '/api/capture/room-overview/daily']);
const DAILY = '/api/capture/room-overview/daily';
const QUERY_KEYS = ['start_date', 'end_date', 'platform', 'live_room_id'];
const CHALLENGE = /验证码|安全验证|人机验证|滑块|扫码登录|登录后观看|captcha|verify\s+you\s+are\s+human|access\s+challenge/i;
const fail = code => { throw new Error(code); };
const validDate = s => {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T12:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0,10) === s;
};
const validList = (x, check) => Array.isArray(x) && x.length > 0 && x.length <= 100 && x.every(check) && new Set(x).size === x.length;
const publicErrors = new Set(['READER_NETWORK_ERROR','READER_ACCESS_BLOCKED','READER_REDIRECT_REJECTED',
  'READER_STREAM_REQUIRED','READER_TOO_LARGE','READER_INVALID_STREAM','READER_HTTP_ERROR',
  'READER_CONTENT_TYPE','READER_INVALID_UTF8','READER_INVALID_JSON','READER_SCHEMA_UNVERIFIED','READER_SCHEMA_REJECTED','READER_TIMEOUT']);

export function createReadonlyReader({ origin, approvedOrigins, approvedPlatforms, approvedDates, approvedRoomIdsByPlatform, fetchImpl, validators = {}, timeoutMs = 10000, maxBytes = 1048576 } = {}) {
  let base;
  try { base = new URL(origin); } catch { fail('READER_INVALID_ORIGIN'); }
  if (base.protocol !== 'https:' || base.username || base.password || base.pathname !== '/' || base.search || base.hash || base.origin !== origin ||
      !validList(approvedOrigins, x => typeof x === 'string' && /^https:\/\//.test(x)) || !approvedOrigins.includes(origin) ||
      !validList(approvedPlatforms, x => typeof x === 'string' && x.length > 0 && x.length <= 32) ||
      !validList(approvedDates, validDate) || typeof fetchImpl !== 'function' ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000 ||
      !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 1048576) fail('READER_INVALID_CONFIG');
  if (!approvedRoomIdsByPlatform || typeof approvedRoomIdsByPlatform !== 'object' || Array.isArray(approvedRoomIdsByPlatform) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(approvedRoomIdsByPlatform)) ||
      Object.keys(approvedRoomIdsByPlatform).length !== approvedPlatforms.length ||
      approvedPlatforms.some(p => !Object.hasOwn(approvedRoomIdsByPlatform, p) ||
        !Array.isArray(approvedRoomIdsByPlatform[p]) || approvedRoomIdsByPlatform[p].length > 1000 ||
        approvedRoomIdsByPlatform[p].some(id => typeof id !== 'string' || !/^\d{1,16}$/.test(id)) ||
        new Set(approvedRoomIdsByPlatform[p]).size !== approvedRoomIdsByPlatform[p].length)) fail('READER_INVALID_CONFIG');
  // Snapshot the approved scope; changing a caller-owned array cannot widen it.
  const platforms = new Set(approvedPlatforms), dates = new Set(approvedDates);
  const roomsByPlatform = new Map(approvedPlatforms.map(p => [p, new Set(approvedRoomIdsByPlatform[p])]));
  // Schema validators are part of the authorization boundary. Snapshot once:
  // no request may occur before its validator is present and reviewed.
  if (!validators || typeof validators !== 'object' || Array.isArray(validators) ||
      ![Object.prototype,null].includes(Object.getPrototypeOf(validators))) fail('READER_INVALID_CONFIG');
  const validatorSnapshot = new Map();
  for (const [route, validate] of Object.entries(validators)) {
    if (!PATHS.has(route) || typeof validate !== 'function') fail('READER_INVALID_CONFIG');
    validatorSnapshot.set(route, validate);
  }
  let blocked = false, active = false;
  return {
    async read(path, query = {}) {
      if (blocked) fail('READER_ACCESS_BLOCKED');
      if (active) fail('READER_BUSY');
      if (!PATHS.has(path) || !query || typeof query !== 'object' || Array.isArray(query) ||
          Object.getPrototypeOf(query) !== Object.prototype) fail('READER_INVALID_REQUEST');
      const entries = Object.entries(query);
      if (path !== DAILY && entries.length) fail('READER_INVALID_QUERY');
      if (path === DAILY && (entries.length !== QUERY_KEYS.length || QUERY_KEYS.some(k => !Object.hasOwn(query, k)) ||
          !validDate(query.start_date) || query.start_date !== query.end_date || !dates.has(query.start_date) ||
          typeof query.platform !== 'string' || !platforms.has(query.platform) ||
          typeof query.live_room_id !== 'string' || !/^\d{1,16}$/.test(query.live_room_id) ||
          !roomsByPlatform.get(query.platform).has(query.live_room_id))) fail('READER_INVALID_QUERY');
      if (!validatorSnapshot.has(path)) {
        blocked = true;
        fail('READER_SCHEMA_UNVERIFIED');
      }
      const validate = validatorSnapshot.get(path);
      const url = new URL(path, base);
      for (const key of QUERY_KEYS) if (Object.hasOwn(query, key)) url.searchParams.set(key, query[key]);
      active = true;
      const controller = new AbortController();
      let timer;
      const timedOut = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('READER_TIMEOUT')); }, timeoutMs); });
      const operation = async () => {
        let response;
        try { response = await fetchImpl(url.href, { method:'GET', headers:{accept:'application/json'}, redirect:'error', credentials:'omit', signal:controller.signal }); }
        catch { fail('READER_NETWORK_ERROR'); }
        if ([401,403,429].includes(response.status)) fail('READER_ACCESS_BLOCKED');
        if (response.redirected || (response.status >= 300 && response.status < 400) || (response.url && response.url !== url.href)) fail('READER_REDIRECT_REJECTED');
        if (!response.body || typeof response.body.getReader !== 'function') fail('READER_STREAM_REQUIRED');
        const headerLength = response.headers.get('content-length');
        if (headerLength && (!/^\d+$/.test(headerLength) || Number(headerLength) > maxBytes)) fail('READER_TOO_LARGE');
        const reader = response.body.getReader(), chunks = []; let length = 0;
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (!(value instanceof Uint8Array)) fail('READER_INVALID_STREAM');
            length += value.byteLength;
            if (length > maxBytes) fail('READER_TOO_LARGE');
            chunks.push(value);
          }
        } finally { reader.releaseLock(); }
        const bytes = new Uint8Array(length); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        let text;
        try { text = new TextDecoder('utf-8', {fatal:true}).decode(bytes); }
        catch { fail('READER_INVALID_UTF8'); }
        if (CHALLENGE.test(text)) fail('READER_ACCESS_BLOCKED');
        if (!response.ok) fail('READER_HTTP_ERROR');
        const contentType = response.headers.get('content-type') || '';
        // Decoder is strict UTF-8; non-UTF-8 declared charsets cannot be
        // interpreted as UTF-8 and then considered source evidence.
        if (!/^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;\s*charset\s*=\s*"?utf-8"?\s*)?$/i.test(contentType))
          fail('READER_CONTENT_TYPE');
        let data;
        try { data = JSON.parse(text); } catch { fail('READER_INVALID_JSON'); }
        let verified = false;
        try { verified = validate(data) === true; } catch { /* Reject validator failure. */ }
        if (!verified) fail('READER_SCHEMA_REJECTED');
        return data;
      };
      try { return await Promise.race([operation(), timedOut]); }
      catch (error) {
        blocked = true; controller.abort();
        const code = publicErrors.has(error?.message) ? error.message : 'READER_NETWORK_ERROR';
        fail(code);
      } finally { clearTimeout(timer); active = false; }
    },
  };
}
