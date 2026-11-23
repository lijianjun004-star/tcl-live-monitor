'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { makeHandler: writer } = require('../functions/updateLiveStatus');
const { makeHandler: reader } = require('../functions/getLiveStatus');

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
  }};
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

const input = { updatedAt: '2026-01-01T12:00:00.000Z', totalCount: 1, liveCount: 1,
  shops: [{ name: '示例店', isLive: true, liveUrl: 'https://tbzb.taobao.com/live?liveId=123', startTime: '2026-01-01T11:59:00.000Z' }] };

test('collector to dashboard roundtrip, idempotency, conditional write and CORS', async () => {
  const db = memoryDb(), write = writer(() => db, { API_TOKEN: 'test-only' }), read = reader(() => db);
  assert.equal((await invoke(read,'GET')).statusCode,404);
  assert.equal((await invoke(write,'POST',input,'invalid')).statusCode,401);
  assert.equal((await invoke(write,'POST',input,'test-only')).statusCode,200);
  assert.deepEqual((await invoke(read,'GET')).json,input);
  assert.equal((await invoke(write,'POST',input,'test-only')).statusCode,200);
  const later = { ...input, updatedAt:'2026-01-01T12:02:00.000Z',liveCount:0,
    shops:[{name:'示例店',isLive:false,startTime:null,liveUrl:null}] };
  assert.equal((await invoke(write,'POST',later,'test-only')).statusCode,200);
  assert.equal((await invoke(write,'POST',input,'test-only')).statusCode,409);
  assert.equal((await invoke(write,'POST',{...input,updatedAt:later.updatedAt},'test-only')).statusCode,409);
  assert.deepEqual((await invoke(read,'GET')).json,later);
  const cors = await invoke(read,'OPTIONS');
  assert.equal(cors.statusCode,204);
  assert.equal(cors.headers['Access-Control-Allow-Origin'],'*');
});

test('rejects invalid URLs, inconsistent rows and missing writer secret', async () => {
  const db = memoryDb(), write = writer(() => db,{ API_TOKEN:'t' });
  for (const data of [
    {...input,totalCount:0}, {...input,liveCount:0}, {...input,shops:[{...input.shops[0],liveUrl:'javascript:alert(1)'}]},
    {...input,shops:[{...input.shops[0],startTime:null}]},
    {...input,totalCount:2,liveCount:2,shops:[input.shops[0],input.shops[0]]},
    {...input,updatedAt:'2099-01-01T12:02:00.000Z'}
  ]) assert.equal((await invoke(write,'POST',data,'t')).statusCode,400);
  assert.equal((await invoke(writer(()=>db,{}),'POST',input)).statusCode,503);
  assert.equal((await invoke(reader(()=>db),'POST')).statusCode,405);
});

test('racing submissions converge to newest snapshot', async () => {
  const db = memoryDb(), write=writer(()=>db,{API_TOKEN:'t'});
  const scans=Array.from({length:12},(_,index)=>({...input,updatedAt:new Date(Date.parse(input.updatedAt)+index*1000).toISOString()}));
  await Promise.all(scans.map(scan=>invoke(write,'POST',scan,'t')));
  assert.deepEqual((await invoke(reader(()=>db),'GET')).json,scans.at(-1));
});
