/**
 * Offline-testable, aggregate-only source scan. Inject ONLY a separately audited
 * reader that enforces the authorised origin, GET-only routes, content type,
 * bounded bodies, timeouts, and immediate stop on challenge/access failures.
 * This module does not create a network connection, log or persist source data.
 * `platformValue` must be the exact source value already authorised and verified
 * by the caller; `knownPlatformValues` is the reviewed, exact source vocabulary.
 * This function never substitutes or normalises platform aliases.
 * The caller must provide the exact independently reviewed room ID baseline;
 * any missing, new, or replaced room stops the scan before further requests.
 * It does not verify completeness, identity, status,
 * or a scheduler.
 */
const ROUTES = Object.freeze({ rooms: '/api/capture/rooms', shops: '/api/shops',
  heartbeat: '/api/assistant/active-rooms', daily: '/api/capture/room-overview/daily' });
const items = (body, candidates) => {
  for (const path of candidates) {
    let x = body;
    for (const k of path) x = x?.[k];
    if (Array.isArray(x)) return x;
  }
  throw new Error('SOURCE_SHAPE_INVALID');
};
const id = x => {
  if (typeof x === 'number' && (!Number.isSafeInteger(x) || x < 0)) return null;
  return typeof x === 'string' || typeof x === 'number' ?
    (/^[0-9]{1,16}$/.test(String(x)) ? String(x) : null) : null;
};
const validDate = s => {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T12:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s;
};
// Without a validated source schema, contradictory aliases cannot establish
// which value represents the entity. Never pick the first of conflicting IDs.
const ownValues = (record, keys) => keys.filter(k => Object.hasOwn(record, k)).map(k => record[k]);
function consistentId(values, optional = false) {
  if (!values.length) {
    if (optional) return null;
    throw Error();
  }
  if (optional && values.length === 1 && values[0] == null) return null;
  const normalized = values.map(id);
  if (normalized.some(x => x === null) || normalized.some(x => x !== normalized[0])) throw Error();
  return normalized[0];
}
const recordId = r => consistentId(ownValues(r, ['id', 'live_room_id', 'room_id']));
const shopId = r => {
  const values = ownValues(r, ['shop_id', 'shopId']);
  if (r.shop != null) {
    if (typeof r.shop !== 'object' || Array.isArray(r.shop)) throw Error();
    if (Object.hasOwn(r.shop, 'id')) values.push(r.shop.id);
  }
  return consistentId(values, true);
};

export async function scanAggregate({ reader, platformValue, knownPlatformValues, date, baselineRoomIds, minimumObservedRooms, maxRooms = 60 } = {}) {
  if (typeof reader !== 'function' || typeof platformValue !== 'string' || !platformValue ||
      platformValue.length > 32 || !validDate(date) || !Number.isInteger(maxRooms) || maxRooms < 1 || maxRooms > 100 ||
      !Number.isInteger(minimumObservedRooms) || minimumObservedRooms < 1 || minimumObservedRooms > maxRooms ||
      !Array.isArray(knownPlatformValues) || knownPlatformValues.length < 1 || knownPlatformValues.length > 32 ||
      knownPlatformValues.some(x => typeof x !== 'string' || !x || x.length > 32) ||
      new Set(knownPlatformValues).size !== knownPlatformValues.length || !knownPlatformValues.includes(platformValue) ||
      !Array.isArray(baselineRoomIds) || baselineRoomIds.length < minimumObservedRooms || baselineRoomIds.length > maxRooms ||
      baselineRoomIds.some(x => typeof x !== 'string' || id(x) !== x) ||
      new Set(baselineRoomIds).size !== baselineRoomIds.length)
    return { sourceAccess: 'UNKNOWN', reason: 'INVALID_INPUT', catalogComplete: false };
  // Snapshot reviewed inputs before the first asynchronous source read.
  const baseline = new Set(baselineRoomIds), knownPlatforms = new Set(knownPlatformValues);
  try {
    const approvedRow = r => {
      if (!r || typeof r !== 'object' || Array.isArray(r) || !knownPlatforms.has(r.platform)) throw Error();
      return r.platform === platformValue;
    };
    const roomBody = await reader(ROUTES.rooms);
    const rawRooms = items(roomBody, [['rooms'], ['data', 'rooms'], ['data', 'list'], ['list']]);
    if (rawRooms.length > 1000) throw Error();
    const selected = rawRooms.filter(approvedRow);
    // An empty response cannot establish that there are no rooms. Do not
    // proceed with or publish an apparent zero census without more evidence.
    if (selected.length < minimumObservedRooms) throw Error();
    if (selected.length > maxRooms) throw Error();
    const rooms = [], seen = new Set();
    for (const r of selected) {
      const rid = recordId(r);
      if (!rid || seen.has(rid)) throw Error();
      seen.add(rid);
      const sid = shopId(r);
      rooms.push({ roomId: rid, shopId: sid });
    }
    // Equal counts do not rule out room replacement. Refuse both additions and
    // removals until the caller independently reviews a new baseline.
    if (seen.size !== baseline.size || [...seen].some(rid => !baseline.has(rid))) throw Error();
    const shopBody = await reader(ROUTES.shops);
    const rawShops = items(shopBody, [[], ['shops'], ['data', 'shops'], ['data', 'list'], ['list']]);
    if (rawShops.length > 1000) throw Error();
    const shops = new Set();
    for (const s of rawShops.filter(approvedRow)) {
      const sid = consistentId(ownValues(s, ['id', 'shop_id', 'shopId']));
      if (!sid || shops.has(sid)) throw Error();
      shops.add(sid);
    }
    const heartbeatBody = await reader(ROUTES.heartbeat);
    const rawHeartbeat = items(heartbeatBody, [['rooms'], ['data', 'rooms'], ['data', 'list'], ['list']]);
    if (rawHeartbeat.length > 1000) throw Error();
    const heartbeatIds = new Set();
    for (const h of rawHeartbeat.filter(approvedRow)) {
      const rid = recordId(h);
      if (!rid || heartbeatIds.has(rid)) throw Error();
      heartbeatIds.add(rid);
    }
    let dailyDateRows = 0;
    for (const room of rooms) {
      const doc = await reader(ROUTES.daily, { start_date: date, end_date: date,
        platform: platformValue, live_room_id: room.roomId });
      const days = items(doc, [['days'], ['data', 'days']]);
      if (days.length > 1000) throw Error();
      const dates = new Set();
      for (const d of days) {
        if (!d || typeof d !== 'object' || Array.isArray(d) || !validDate(d.date) || dates.has(d.date)) throw Error();
        dates.add(d.date);
      }
      if (days.some(d => d?.date === date)) dailyDateRows++;
    }
    return { sourceAccess: 'PARTIAL', reason: 'IDENTITY_AND_COMPLETENESS_UNVERIFIED',
      catalogComplete: false, roomCount: rooms.length, shopCount: shops.size,
      roomShopJoins: rooms.filter(r => r.shopId && shops.has(r.shopId)).length,
      heartbeatRowsMatched: rooms.filter(r => heartbeatIds.has(r.roomId)).length,
      dailyDateRows, LIVE: 0, OFFLINE: 0, UNKNOWN: rooms.length };
  } catch {
    // A failure of any kind stops the chain; do not leak an exception, URL or ID.
    return { sourceAccess: 'UNKNOWN', reason: 'READ_OR_SCHEMA_FAILURE', catalogComplete: false };
  }
}
