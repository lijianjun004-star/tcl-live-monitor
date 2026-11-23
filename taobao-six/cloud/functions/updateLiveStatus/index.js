'use strict';

const http = require('node:http');
const { createHash, timingSafeEqual } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');

class ApiError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
  }
}

function timestamp(value) {
  if (typeof value !== 'string' ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/.test(value) ||
      !Number.isFinite(Date.parse(value))) {
    throw new ApiError(400, 'invalid_timestamp');
  }
  return new Date(value).toISOString();
}

function normalize(input, now) {
  if (!input || !Array.isArray(input.shops) || !input.shops.length ||
      input.shops.length > 500 || input.totalCount !== input.shops.length) {
    throw new ApiError(400, 'invalid_total');
  }
  const updatedAt = timestamp(input.updatedAt);
  if (Date.parse(updatedAt) > now + 120000) throw new ApiError(400, 'clock_ahead');
  const seen = new Set();
  const shops = input.shops.map(shop => {
    if (!shop || typeof shop.name !== 'string' || typeof shop.isLive !== 'boolean' ||
        !shop.name.trim() || shop.name.length > 128 || /[\u0000-\u001f\u007f]/u.test(shop.name)) {
      throw new ApiError(400, 'invalid_shop');
    }
    const name = shop.name.trim();
    if (seen.has(name)) throw new ApiError(400, 'duplicate_shop');
    seen.add(name);
    const { isLive, liveUrl } = shop;
    if (liveUrl !== null && (typeof liveUrl !== 'string' ||
        !/^https:\/\/tbzb\.taobao\.com\/live\?liveId=[1-9]\d{0,23}$/.test(liveUrl))) {
      throw new ApiError(400, 'invalid_live_url');
    }
    const startTime = isLive ? timestamp(shop.startTime) : null;
    if ((!isLive && (liveUrl !== null || shop.startTime !== null)) || (isLive && startTime > updatedAt)) {
      throw new ApiError(400, 'invalid_session');
    }
    return { name, isLive, liveUrl, startTime };
  });
  shops.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const liveCount = shops.filter(shop => shop.isLive).length;
  if (input.liveCount !== liveCount) throw new ApiError(400, 'invalid_live_count');
  return { updatedAt, totalCount: shops.length, liveCount, shops };
}

async function latest(collection) {
  return (await collection.where({ _id: 'latest' }).limit(1).get()).data[0];
}

// The timestamp comparison is part of the DB write, so slow/parallel retries
// cannot overwrite a newer scan. Fixed _id makes simultaneous first inserts safe.
async function writeLatest(db, snapshot) {
  const col = db.collection('tcl_live_status');
  const writeNewer = () => col.where({
    _id: 'latest', updatedAt: db.command.lt(snapshot.updatedAt)
  }).update(snapshot);
  if ((await writeNewer()).updated === 1) return;
  let current = await latest(col);
  if (!current) {
    try {
      await col.add({ _id: 'latest', ...snapshot });
      return;
    } catch (err) {
      current = await latest(col);
      if (!current) throw err;
    }
  }
  if (current.updatedAt < snapshot.updatedAt) {
    if ((await writeNewer()).updated === 1) return;
    current = await latest(col);
  }
  if (!current || current.updatedAt !== snapshot.updatedAt) throw new ApiError(409, 'stale_snapshot');
  const { updatedAt, liveCount, totalCount, shops } = current;
  if (!isDeepStrictEqual({ updatedAt, liveCount, totalCount, shops }, snapshot)) {
    throw new ApiError(409, 'timestamp_conflict');
  }
}

function hasToken(given, expected) {
  if (typeof given !== 'string' || !expected) return false;
  const digest = value => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

async function readJson(req) {
  const parts = [];
  let length = 0;
  for await (const part of req) {
    length += part.length;
    if (length > 256 * 1024) throw new ApiError(413, 'too_large');
    parts.push(part);
  }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')); }
  catch { throw new ApiError(400, 'invalid_json'); }
}

function makeHandler(getDb, env) {
  return async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        throw new ApiError(405, 'method_not_allowed');
      }
      if (!env.API_TOKEN) throw new ApiError(503, 'write_token_not_configured');
      if (!hasToken(req.headers['x-api-token'], env.API_TOKEN)) throw new ApiError(401, 'unauthorized');
      if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
        throw new ApiError(415, 'json_required');
      }
      const snapshot = normalize(await readJson(req), Date.now());
      await writeLatest(getDb(), snapshot);
      res.end(JSON.stringify({ ok: true, updatedAt: snapshot.updatedAt }));
    } catch (err) {
      res.statusCode = err instanceof ApiError ? err.status : 503;
      res.end(JSON.stringify({ error: err instanceof ApiError ? err.message : 'database_unavailable' }));
    }
  };
}

if (require.main === module) {
  let db;
  http.createServer(makeHandler(() => {
    const { CLOUDBASE_ENV_ID: env, CLOUDBASE_APIKEY: accessKey } = process.env;
    if (!env || !accessKey) throw new Error('missing cloud configuration');
    return db ??= require('@cloudbase/node-sdk').init({ env, accessKey }).database();
  }, process.env)).listen(9000, '0.0.0.0');
}

module.exports = { makeHandler, normalize, writeLatest };
