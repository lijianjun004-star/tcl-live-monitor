import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {beijingDate} from '../probes/lib/tcl-jd-all.mjs';

const date=beijingDate(new Date());
test('end-to-end local fixture: read-only HTTP scan, safe JSON, zero POST, no raw business fields', async(t)=>{
  const now=new Date().toISOString();
  const calls=[];
  const server=http.createServer((req,res)=>{
    calls.push({method:req.method,path:new URL(req.url,'http://localhost').pathname});
    res.setHeader('content-type','application/json');
    if(req.url.startsWith('/api/capture/rooms')) return res.end(JSON.stringify({rooms:[{id:17,platform:'jd',category:'电视',shop_id:100,bound_session_key:'SENSITIVE_CAPTURE_KEY'}],total:1}));
    if(req.url.startsWith('/api/shops')) return res.end(JSON.stringify({shops:[{id:100,platform:'jd',owner:'PRIVATE_PERSON',revenue:999999}]}));
    if(req.url.startsWith('/api/assistant/active-rooms')) return res.end(JSON.stringify({rooms:[{id:17,last_heartbeat_at:now,employee_name:'PRIVATE_PERSON'}]}));
    if(req.url.startsWith('/api/capture/room-overview/daily')) return res.end(JSON.stringify({days:[{date,minute_count:1,latest_minute_ts:now,latest:{status:1},gross_merchandise_value:999999}]}));
    res.statusCode=404;res.end('{}');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const dir=await mkdtemp(join(tmpdir(),'tcl-jd-fixture-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const output=join(dir,'safe.json');
  const result=await new Promise((resolve,reject)=>{
    const proc=spawn(process.execPath,['probes/tcl-jd-all.mjs','--output',output],{
      cwd:new URL('..',import.meta.url),
      env:{...process.env,TCL_OPS_BASE_URL:`http://127.0.0.1:${server.address().port}/`},
      stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';proc.stdout.on('data',x=>stdout+=x);proc.stderr.on('data',x=>stderr+=x);
    proc.on('close',code=>resolve({code,stdout,stderr}));proc.on('error',reject);
  });
  assert.equal(result.code,0, result.stderr);
  assert.match(result.stdout,/LIVE=1/);
  assert.ok(calls.length===4, JSON.stringify(calls));
  assert.ok(calls.every(x=>x.method==='GET'));
  const text=await readFile(output,'utf8');
  for(const secret of ['SENSITIVE_CAPTURE_KEY','PRIVATE_PERSON','999999','gross_merchandise_value','revenue']) assert.ok(!text.includes(secret),secret);
  const report=JSON.parse(text);
  assert.equal(report.rooms.length,1);assert.equal(report.rooms[0].roomId,'17');assert.equal(report.rooms[0].shopId,'100');
  assert.equal(report.summary.LIVE,1);
});
