import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {beijingDate} from '../probes/lib/tcl-jd-all.mjs';

test('same numeric room IDs on different platforms cannot open each other’s session gaps', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tcl-platform-isolation-'));
  t.after(() => fs.rm(dir, {recursive:true, force:true}));
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const now = new Date();
    let body;
    if (url.pathname === '/api/capture/rooms') body = {rooms:[{id:1,platform:'jd',category:'test'},{id:1,platform:'douyin',category:'test'}]};
    else if (url.pathname === '/api/assistant/active-rooms') body = {rooms:['jd','douyin'].map(platform => ({id:1,platform,last_heartbeat_at:now.toISOString()}))};
    else body = {days:[{date:beijingDate(now),latest_minute_ts:new Date(+now - (url.searchParams.get('platform') === 'jd' ? 0 : 600000)).toISOString(),latest:{status:1},minute_count:5,session_count:1}]};
    res.writeHead(200, {'content-type':'application/json'}); res.end(JSON.stringify(body));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../probes/tcl-ops-status.mjs', import.meta.url)), '--rounds','1'], {cwd:dir, env:{...process.env,BASE:`http://127.0.0.1:${server.address().port}`}});
  let stdout='', stderr=''; child.stdout.on('data', b => stdout+=b); child.stderr.on('data', b => stderr+=b);
  const timeout = setTimeout(() => child.kill(), 10000); t.after(() => clearTimeout(timeout));
  const code = await new Promise((resolve,reject) => {child.on('close',resolve); child.on('error',reject);});
  assert.equal(code,0,stderr);
  assert.match(stdout,/jd-1\(test\)=LIVE/);
  assert.match(stdout,/douyin-1\(test\)=UNKNOWN/);
  assert.doesNotMatch(stdout,/event .*GAP_OPENED/);
});
