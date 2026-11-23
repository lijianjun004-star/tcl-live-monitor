'use strict';
// The six-shop snapshot built from the measured 2026-11-23 12:41:44 log (tests/fixtures) must pass
// the write function unchanged and come back from the read function the dashboard calls.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { makeHandler: writer } = require('../functions/updateLiveStatus');
const { makeHandler: reader } = require('../functions/getLiveStatus');

const fixture = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', '..', 'tests', 'fixtures', 'six_snapshot_20261123_124144.json'), 'utf8'));

function memoryDb() {
  let doc;
  const col = {
    where(query) {
      return {
        limit() { return this; },
        async get() { return { data: doc ? [structuredClone(doc)] : [] }; },
        async update(value) {
          if (!doc || !(doc.updatedAt < query.updatedAt.lt)) return { updated: 0 };
          doc = { ...doc, ...structuredClone(value) };
          return { updated: 1 };
        }
      };
    },
    async add(input) {
      if (doc) throw new Error('duplicate id');
      doc = structuredClone(input);
    }
  };
  return { command: { lt: x => ({ lt: x }) }, collection(name) {
    assert.equal(name, 'tcl_live_status');
    return col;
  } };
}

async function invoke(handler, method, body, token) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  req.method = method;
  req.headers = { 'content-type': 'application/json', 'x-api-token': token };
  const res = {
    statusCode: 200, headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    writeHead(code) { this.statusCode = code; return this; },
    end(bytes) { this.json = bytes ? JSON.parse(bytes) : undefined; }
  };
  await handler(req, res);
  return res;
}

const byName = shops => [...shops].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

test('measured six-shop snapshot is accepted and read back for the dashboard', async () => {
  assert.equal(fixture.totalCount, 6);
  assert.equal(fixture.liveCount, 6);
  const db = memoryDb(), write = writer(() => db, { API_TOKEN: 'test-only' }), read = reader(() => db);
  const stored = await invoke(write, 'POST', fixture, 'test-only');
  assert.equal(stored.statusCode, 200);
  assert.deepEqual(stored.json, { ok: true, updatedAt: fixture.updatedAt });
  const got = await invoke(read, 'GET');
  assert.equal(got.statusCode, 200);
  assert.deepEqual(got.json, { ...fixture, shops: byName(fixture.shops) });
  assert.equal((await invoke(write, 'POST', fixture, 'test-only')).statusCode, 200);  // retry is idempotent
});

test('a retried older six-shop snapshot cannot replace a newer one', async () => {
  const db = memoryDb(), write = writer(() => db, { API_TOKEN: 't' }), read = reader(() => db);
  const later = { ...fixture, updatedAt: '2026-11-23T04:43:44.000Z', liveCount: 0,
    shops: fixture.shops.map(s => ({ ...s, isLive: false, liveUrl: null, startTime: null })) };
  assert.equal((await invoke(write, 'POST', later, 't')).statusCode, 200);
  assert.equal((await invoke(write, 'POST', fixture, 't')).statusCode, 409);
  assert.deepEqual((await invoke(read, 'GET')).json, { ...later, shops: byName(later.shops) });
});
