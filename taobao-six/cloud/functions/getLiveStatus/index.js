'use strict';

const http = require('node:http');

function makeHandler(getDb) {
  return async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET, OPTIONS');
      res.writeHead(405).end(JSON.stringify({ error: 'method_not_allowed' }));
      return;
    }
    try {
      const { data } = await getDb().collection('tcl_live_status').where({ _id: 'latest' }).limit(1).get();
      if (!data.length) {
        res.writeHead(404).end(JSON.stringify({ error: 'no_snapshot' }));
        return;
      }
      const { updatedAt, liveCount, totalCount, shops } = data[0];
      res.end(JSON.stringify({ updatedAt, liveCount, totalCount, shops }));
    } catch {
      res.writeHead(503).end(JSON.stringify({ error: 'database_unavailable' }));
    }
  };
}

if (require.main === module) {
  let db;
  http.createServer(makeHandler(() => {
    const { CLOUDBASE_ENV_ID: env, CLOUDBASE_APIKEY: accessKey } = process.env;
    if (!env || !accessKey) throw new Error('missing cloud configuration');
    return db ??= require('@cloudbase/node-sdk').init({ env, accessKey }).database();
  })).listen(9000, '0.0.0.0');
}

module.exports = { makeHandler };
