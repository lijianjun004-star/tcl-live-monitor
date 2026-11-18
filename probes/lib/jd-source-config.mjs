const fail = code => { throw new Error(code); };

/** Parse an explicit HTTP(S) origin without URL repair or sensitive diagnostics. */
export function parseJdSourceOrigin(value) {
  if (value == null || value === '') fail('BASE_NOT_SET');
  if (typeof value !== 'string' || /[\\\s\u0000-\u001f\u007f]/u.test(value)) fail('BASE_URL_INVALID');

  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value)?.[1].toLowerCase();
  if (scheme && scheme !== 'http' && scheme !== 'https') fail('BASE_PROTOCOL_INVALID');
  const parsed = /^https?:\/\/([^/?#]+)(.*)$/i.exec(value);
  if (!parsed) fail('BASE_URL_INVALID');
  const [, authority, suffix] = parsed;
  if (authority.includes('@') || (suffix && suffix !== '/')) fail('BASE_MUST_BE_ORIGIN');
  if (authority.endsWith(':') || authority.includes('%')) fail('BASE_URL_INVALID');

  let url;
  try { url = new URL(value); }
  catch { return fail('BASE_URL_INVALID'); }
  // WHATWG accepts shorthand and alternate numeral formats for IPv4. The
  // operator must enter the four decimal octets used by the actual request.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) && authority.split(':')[0] !== url.hostname) {
    fail('BASE_URL_INVALID');
  }
  return url;
}

function readOrigin(value) {
  try { return {origin: parseJdSourceOrigin(value).origin}; }
  catch (error) { return {code: error.message}; }
}

/** Offline preflight. The approved and legacy origins are operator-supplied references. */
export function checkJdSourceConfiguration({configured, approved, legacy} = {}) {
  const outcome = (status, code) => ({
    status,
    code,
    reachability: 'NOT_TESTED',
    networkRequests: 0,
  });
  const effective = readOrigin(configured);
  if (effective.code === 'BASE_NOT_SET') return outcome('BLOCKED', 'SOURCE_CONFIG_MISSING');
  if (effective.code) return outcome('BLOCKED', effective.code);

  if (legacy != null && legacy !== '') {
    const old = readOrigin(legacy);
    if (old.code) return outcome('BLOCKED', 'LEGACY_ORIGIN_REFERENCE_INVALID');
    if (effective.origin === old.origin) return outcome('BLOCKED', 'LEGACY_ORIGIN_REQUIRES_REVIEW');
  }

  const expected = readOrigin(approved);
  if (expected.code === 'BASE_NOT_SET') return outcome('BLOCKED', 'APPROVED_ORIGIN_REQUIRED');
  if (expected.code) return outcome('BLOCKED', 'APPROVED_ORIGIN_INVALID');
  if (effective.origin !== expected.origin) return outcome('BLOCKED', 'APPROVED_ORIGIN_MISMATCH');

  return outcome('CONFIG_MATCH', 'APPROVED_ORIGIN_MATCH');
}
