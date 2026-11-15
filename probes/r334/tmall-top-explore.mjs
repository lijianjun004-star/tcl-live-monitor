// Manual, structure-only probes of two official TOP discovery candidates:
//   venue    alibaba.taobao.live.recommend.alipay.query (70809): can registered accounts be mapped to live IDs?
//   contents taobao.live.contents.query (69002): can one day's sessions be listed, and what do they contain?
// Each run sends at most one signed read request through the same transport as the batch client (fixed host,
// no retry, no redirect, size cap). The receipt records the response's STRUCTURE (sanitized key names and value
// forms) and where the registered accounts appear. It never stores a response, title, cover, stream URL, product,
// price, name, or any value belonging to an unregistered account, and a registered account that is not returned
// is UNKNOWN, never offline. Results are not wired into the production ledger.
import { enumToken, fieldShape, isPlainObject as object, sendTopRequest, topCredentials, topDecimalId as decimalId,
  topTargetMap, beijingTimestamp } from './tmall-top.mjs';

export const VENUE_METHOD = 'alibaba.taobao.live.recommend.alipay.query';
export const CONTENTS_METHOD = 'taobao.live.contents.query';
const MODES = { venue: VENUE_METHOD, contents: CONTENTS_METHOD };

const KEY_OK = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const LIMITS = { nodes: 40_000, depth: 12, keys: 60, items: 100, hits: 100, others: 5_000, jsonDepth: 3, path: 240, fields: 40, shapeNodes: 5_000 };
const norm = key => key.toLowerCase().replace(/[^a-z0-9]/g, '');
const ACCOUNT_FIELDS = new Set(['accountid', 'anchorid', 'broadcasterid', 'authorid', 'hostid', 'streamerid', 'anchoraccountid']);
const LIVE_ID_FIELDS = new Set(['liveid', 'roomid', 'roomnumber', 'roomno', 'liveroomid', 'topicid', 'contentid', 'feedid']);
const ENUM_FIELDS = new Set(['roomstatus', 'streamstatus', 'livestatus', 'livestate', 'pushstatus', 'pushstreamstatus',
  'status', 'state', 'type', 'livetype', 'source', 'livesource']);
const ENVELOPE_FIELDS = new Set(['success', 'msgcode', 'errorcode', 'errcode', 'resultcode', 'code', 'totalcount',
  'total', 'count', 'size', 'hasmore', 'hasnext', 'pagesize', 'pageno', 'start', 'nextstart']);
const TIME_FIELD = /time|date|duration/;

const TRUNCATED = Symbol('truncated');
class Embedded { constructor(value) { this.value = value; } }
// A plain JSON object in an expanded tree (an Embedded wrapper is an object too, so it must be excluded).
const record = value => object(value) && !(value instanceof Embedded);
const scalarId = value => (typeof value === 'number' || typeof value === 'string') ? decimalId(value) : null;

// ---- Expansion: parse JSON carried inside strings (data_json_str) so its structure is visible too.
function expand(value, depth, ctx) {
  if (++ctx.nodes > LIMITS.nodes || depth > LIMITS.depth) { ctx.truncated = true; return TRUNCATED; }
  if (Array.isArray(value)) return value.map(item => expand(item, depth + 1, ctx));
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, expand(child, depth + 1, ctx)]));
  if (typeof value === 'string' && ctx.jsonDepth < LIMITS.jsonDepth) {
    const text = value.trim();
    if (text.length > 1 && (text[0] === '{' || text[0] === '[')) {
      let parsed;
      try { parsed = JSON.parse(text); } catch { return value; }
      if (parsed !== null && typeof parsed === 'object') {
        ctx.jsonDepth++;
        const inner = expand(parsed, depth + 1, ctx);
        ctx.jsonDepth--;
        return new Embedded(inner);
      }
    }
  }
  return value;
}

// ---- Shape: merged, value-free description of the whole tree.
const kindOf = value => value === TRUNCATED ? 'truncated' : value === null ? 'null' : typeof value === 'boolean' ? 'boolean'
  : typeof value === 'number' ? (Number.isInteger(value) ? 'integer' : 'number') : typeof value === 'string' ? 'string'
  : Array.isArray(value) ? 'array' : value instanceof Embedded ? 'json' : 'object';
const STRUCTURAL = new Set(['object', 'array', 'json']);
const blank = () => ({ kinds: new Set(), keys: null, otherKeys: 0, omitted: 0, items: null, min: null, max: null, inner: null });

function describe(node, value) {
  const kind = kindOf(value);
  node.kinds.add(kind);
  if (kind === 'array') {
    node.min = node.min === null ? value.length : Math.min(node.min, value.length);
    node.max = node.max === null ? value.length : Math.max(node.max, value.length);
    node.items ||= blank();
    for (const item of value.slice(0, LIMITS.items)) describe(node.items, item);
  } else if (kind === 'object') {
    node.keys ||= new Map();
    let other = 0;
    for (const [key, child] of Object.entries(value)) {
      if (!KEY_OK.test(key)) { other++; continue; }
      let slot = node.keys.get(key);
      if (!slot) {
        if (node.keys.size >= LIMITS.keys) { node.omitted++; continue; }
        slot = blank(); node.keys.set(key, slot);
      }
      describe(slot, child);
    }
    node.otherKeys = Math.max(node.otherKeys, other);
  } else if (kind === 'json') {
    node.inner ||= blank();
    describe(node.inner, value.value);
  }
}

function render(node, budget) {
  if (--budget.left < 0) { budget.truncated = true; return '$truncated'; }
  const scalars = [...node.kinds].filter(kind => !STRUCTURAL.has(kind)).sort();
  if (!node.keys && !node.items && !node.inner) return scalars.join('|') || 'empty';
  const entries = [];
  if (node.keys) {
    for (const [key, child] of node.keys) entries.push([key, render(child, budget)]);
    if (node.otherKeys) entries.push(['$otherKeys', node.otherKeys]);
    if (node.omitted) entries.push(['$omittedKeys', node.omitted]);
  }
  if (node.items) {
    entries.push(['$array', node.min === node.max ? node.min : { min: node.min, max: node.max }]);
    if (node.items.kinds.size) entries.push(['$items', render(node.items, budget)]);
  }
  if (node.inner) entries.push(['$json', render(node.inner, budget)]);
  if (scalars.length) entries.push(['$also', scalars.join('|')]);
  return Object.fromEntries(entries);
}

// ---- Registered-account hits: matched by value wherever an object field equals a registered account ID.
const pathText = segments => segments.reduce((text, part) => part === '[]' ? text + '[]' : text ? `${text}.${part}` : part, '').slice(0, LIMITS.path);
const safeName = name => KEY_OK.test(name) ? name : '?';
const idToken = (value, registered) => {
  const id = scalarId(value);
  return id === null ? fieldShape(value).form : registered.has(id) ? id : 'OTHER_ACCOUNT';
};

// The session record is the array element that holds the matched field. Only that record is summarized, and only
// through allow-listed field names, so neighbouring sessions (other accounts) can never leak into a hit.
function summarize(holder, registered) {
  const out = { ids: {}, enums: {}, times: {} };
  const put = (bucket, path, value) => { if (Object.keys(out[bucket]).length < LIMITS.fields) out[bucket][path] = value; };
  const walk = (node, rel, depth) => {
    for (const [name, child] of Object.entries(node)) {
      if (!KEY_OK.test(name)) continue;
      const path = rel ? `${rel}.${name}` : name, field = norm(name);
      if (child instanceof Embedded) { if (record(child.value) && depth < 3) walk(child.value, `${path}.$json`, depth + 1); continue; }
      if (record(child)) { if (depth < 3) walk(child, path, depth + 1); continue; }
      if (Array.isArray(child) || child === TRUNCATED) continue;
      if (ACCOUNT_FIELDS.has(field)) put('ids', path, idToken(child, registered));
      else if (LIVE_ID_FIELDS.has(field) || (field === 'id' && depth === 0)) put('ids', path, scalarId(child) ?? fieldShape(child).form);
      if (ENUM_FIELDS.has(field)) put('enums', path, enumToken(child, true));
      if (TIME_FIELD.test(field)) put('times', path, fieldShape(child));
    }
  };
  walk(holder, '', 0);
  return out;
}

function scan(tree, registered) {
  const found = [], others = new Set(), matched = new Set();
  let omitted = 0, othersCapped = false;
  const visit = (value, segments, chain, depth, element) => {
    if (depth > LIMITS.depth) return;
    if (value instanceof Embedded) return visit(value.value, [...segments, '$json'], chain, depth + 1, element);
    if (Array.isArray(value)) { for (const item of value) visit(item, [...segments, '[]'], chain, depth + 1, true); return; }
    if (!record(value)) return;
    const frame = { node: value, segments, element }, next = [...chain, frame];
    for (const [name, child] of Object.entries(value)) {
      const id = scalarId(child);
      if (id !== null) {
        const target = registered.get(id);
        if (target) {
          matched.add(target.key);
          const holder = [...next].reverse().slice(0, 4).find(item => item.element) || frame;
          const field = pathText([...segments.slice(holder.segments.length), safeName(name)]);
          const prior = found.find(hit => hit.holder === holder.node && hit.target === target);
          if (prior) prior.fields.add(field);
          else if (found.length >= LIMITS.hits) omitted++;
          else found.push({ target, holder: holder.node, segments: holder.segments, fields: new Set([field]) });
        } else if (ACCOUNT_FIELDS.has(norm(name))) {
          if (others.size < LIMITS.others) others.add(id); else othersCapped = true;
        }
      }
      visit(child, [...segments, safeName(name)], next, depth + 1, false);
    }
  };
  visit(tree, [], [], 0, false);
  return { found, omitted, matched, others: others.size, othersCapped };
}

// ---- Envelope: small status/count scalars on object-only paths near the root (never inside list items).
function envelopeScalar(value) {
  if (typeof value === 'boolean') return value;
  if (value === null) return null;
  if (typeof value === 'number' && Number.isSafeInteger(value) && Math.abs(value) < 1e12) return value;
  if (typeof value === 'string' && /^[A-Za-z0-9_.-]{1,32}$/.test(value)) return value;
  return fieldShape(value).form;
}

function envelope(tree) {
  const out = {};
  const walk = (node, rel, depth) => {
    for (const [name, child] of Object.entries(node)) {
      if (!KEY_OK.test(name)) continue;
      const path = rel ? `${rel}.${name}` : name;
      if (child instanceof Embedded) { if (record(child.value) && depth < 4) walk(child.value, `${path}.$json`, depth + 1); }
      else if (record(child)) { if (depth < 4) walk(child, path, depth + 1); }
      else if (ENVELOPE_FIELDS.has(norm(name)) && !Array.isArray(child) && child !== TRUNCATED && Object.keys(out).length < LIMITS.fields) out[path] = envelopeScalar(child);
    }
  };
  walk(tree, '', 0);
  return out;
}
const hasBusinessError = value => value !== undefined && value !== null && value !== '' && value !== 0 && value !== '0' && value !== false;

export function analyzeStructure(payload, registered) {
  const ctx = { nodes: 0, truncated: false, jsonDepth: 0 };
  const tree = expand(payload, 0, ctx);
  const node = blank(), budget = { left: LIMITS.shapeNodes, truncated: false };
  describe(node, tree);
  const shape = render(node, budget), scanned = scan(tree, registered);
  const hits = scanned.found.map(hit => ({ key: hit.target.key, accountId: hit.target.accountId,
    path: pathText(hit.segments), matchedFields: [...hit.fields].slice(0, 8), ...summarize(hit.holder, registered) }));
  return { shape, shapeTruncated: ctx.truncated || budget.truncated, envelope: envelope(tree), hits, hitsOmitted: scanned.omitted,
    matchedKeys: scanned.matched, otherAccountCount: scanned.others, otherAccountCountCapped: scanned.othersCapped };
}

// ---- Request options (all validated; nothing free-form reaches a request or a receipt).
const beijingDay = (date, daysAgo = 0) => beijingTimestamp(new Date(date.getTime() - daysAgo * 86_400_000)).slice(0, 10).replaceAll('-', '');
const realDay = text => {
  const year = Number(text.slice(0, 4)), month = Number(text.slice(4, 6)), day = Number(text.slice(6, 8));
  const check = new Date(Date.UTC(year, month - 1, day));
  return check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day;
};

function parseOptions(mode, options, date) {
  const raw = key => String(options?.[key] ?? '').trim(), bad = [];
  const word = key => {
    const value = raw(key);
    if (!value) return undefined;
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(value)) { bad.push(key); return undefined; }
    return value;
  };
  const whole = (key, min, max, fallback) => {
    const value = raw(key);
    if (!value) return fallback;
    if (!/^\d{1,7}$/.test(value) || Number(value) < min || Number(value) > max) { bad.push(key); return fallback; }
    return Number(value);
  };
  if (mode === 'venue') {
    return { bad, parsed: { scene: word('scene'), liveSource: word('liveSource'), ruleCode: word('ruleCode'),
      count: whole('count', 1, 100), page: whole('page', 1, 1000) } };
  }
  const supplied = raw('queryDate');
  let queryDate = beijingDay(date, 1);
  if (supplied) {
    if (/^20\d{6}$/.test(supplied) && realDay(supplied) && supplied <= beijingDay(date)) queryDate = supplied; else bad.push('queryDate');
  }
  return { bad, parsed: { queryDate, start: whole('start', 0, 1_000_000, 0), pageSize: whole('pageSize', 1, 100, 20) } };
}

function buildBusiness(mode, parsed, registered) {
  if (mode === 'venue') {
    const param = { anchor_id_list: [...registered.keys()].map(Number) };
    if (parsed.scene) param.scene = parsed.scene;
    if (parsed.liveSource) param.live_source = parsed.liveSource;
    if (parsed.ruleCode) param.recommend_rule_code = parsed.ruleCode;
    if (parsed.count !== undefined) param.n = parsed.count;
    if (parsed.page !== undefined) param.s = parsed.page;
    return { alipay_venue_query_param: JSON.stringify(param) };
  }
  return { query_request: JSON.stringify({ query_date: parsed.queryDate, start: parsed.start, page_size: parsed.pageSize }) };
}

const NOTES = Object.freeze([
  'Structure only: no response values, titles, covers, stream URLs, products or prices are stored.',
  'A registered account without a record is UNKNOWN. It does not prove the account is offline.',
  'Hits are matched by account ID value. They do not verify the account namespace, filter strictness, scope or freshness.',
  'Times found in recommendation reasons are not broadcast start or end times.',
]);

export async function runTopExplore({ mode, env = {}, options = {}, targets, fetchFn = globalThis.fetch, now = new Date() } = {}) {
  const pair = topCredentials(env), registered = topTargetMap(targets);
  const date = now instanceof Date ? now : new Date(now), validDate = Number.isFinite(date.getTime());
  const method = Object.hasOwn(MODES, mode) ? MODES[mode] : null;
  const result = { schemaVersion: 334, source: 'TAOBAO_TOP', kind: 'STRUCTURE_PROBE', mode: method ? mode : null, method,
    at: validDate ? date.toISOString() : null, status: 'BLOCKED', reason: 'PREREQUISITES_MISSING', blockers: [], requestsSent: 0,
    credentialsConfigured: Boolean(pair), request: null, registeredHits: [], exitCode: 2 };
  if (!method) result.blockers.push('MODE_INVALID');
  if (!pair) result.blockers.push('TOP_CREDENTIALS_MISSING');
  if (!registered) result.blockers.push('APPROVED_TARGETS_INVALID_OR_MISSING');
  if (!validDate) result.blockers.push('INVALID_NOW');
  let parsed = null;
  if (method && validDate) {
    const checked = parseOptions(mode, options, date);
    parsed = checked.parsed;
    if (checked.bad.length) result.blockers.push('OPTIONS_INVALID:' + checked.bad.join(','));
  }
  if (mode === 'venue' && registered && [...registered.keys()].some(id => !Number.isSafeInteger(Number(id)))) result.blockers.push('ACCOUNT_ID_NOT_SAFE_INTEGER');
  if (typeof fetchFn !== 'function') result.blockers.push('FETCH_UNAVAILABLE');
  if (parsed && !result.blockers.some(item => item.startsWith('OPTIONS_INVALID'))) {
    result.request = mode === 'venue'
      ? { registeredAccountCount: registered ? registered.size : 0, scene: parsed.scene ?? null, liveSource: parsed.liveSource ?? null,
        ruleCode: parsed.ruleCode ?? null, count: parsed.count ?? null, page: parsed.page ?? null }
      : { queryDate: parsed.queryDate, start: parsed.start, pageSize: parsed.pageSize };
  }
  if (result.blockers.length) return result;

  const finish = (status, reason, exitCode) => Object.assign(result, { status, reason, exitCode });
  const sent = await sendTopRequest({ method, business: buildBusiness(mode, parsed, registered), pair, fetchFn, date });
  result.requestsSent = 1;
  if (!sent.ok) {
    if (sent.apiErrorCode !== undefined) result.apiErrorCode = sent.apiErrorCode;
    if (sent.apiSubCode !== undefined) result.apiSubCode = sent.apiSubCode;
    return finish(sent.status, sent.reason, sent.exitCode);
  }
  const payload = sent.payload;
  const roots = Object.keys(payload).filter(key => key.endsWith('_response'));
  const analysis = analyzeStructure(payload, registered);
  Object.assign(result, { rootKey: roots.length === 1 ? safeName(roots[0]) : null, shape: analysis.shape, shapeTruncated: analysis.shapeTruncated,
    envelope: analysis.envelope, registeredHits: analysis.hits, registeredHitsOmitted: analysis.hitsOmitted,
    registeredWithoutRecord: [...registered.values()].filter(target => !analysis.matchedKeys.has(target.key)).map(target => target.key),
    otherAccountCount: analysis.otherAccountCount, otherAccountCountCapped: analysis.otherAccountCountCapped, notes: NOTES });
  const entries = Object.entries(analysis.envelope);
  if (entries.some(([path, value]) => /(^|\.)success$/.test(path) && value === false)) return finish('REJECTED', 'TOP_BUSINESS_REJECTED', 3);
  if (entries.some(([path, value]) => /(^|\.)(error_?code|err_?code)$/i.test(path) && hasBusinessError(value))) return finish('REJECTED', 'TOP_BUSINESS_ERROR', 3);
  if (roots.length !== 1) return finish('PARTIAL', 'TOP_RESPONSE_ROOT_UNRECOGNIZED', 4);
  return finish('EXPLORED', 'STRUCTURE_RECORDED', 0);
}
