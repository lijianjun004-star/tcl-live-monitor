// Exercise the actual shell helper with synthetic credentials and a local curl stub.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const TOKEN = 'ghp_' + 'synthetic_not_a_real_token_12345';
function run(t, { token = TOKEN, status = '204', failure = false, collector = '', dispatcher = '' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-test-'));
  t.after(() => fs.rmSync(dir, { recursive:true, force:true }));
  const callFile = path.join(dir, 'calls.json');
  fs.writeFileSync(path.join(dir, 'curl'), '#!/usr/bin/env node\n' +
    'require("fs").writeFileSync(process.env.TEST_CALL_FILE,JSON.stringify(process.argv.slice(2)));\n' +
    'process.stdout.write(process.env.TEST_HTTP_STATUS);process.exit(Number(process.env.TEST_CURL_EXIT));\n', { mode:0o755 });
  const summary = path.join(dir, 'summary.md'), output = path.join(dir,'output.txt');
  const p = spawnSync('bash', [path.join(ROOT,'scripts/dispatch-results.sh')], { encoding:'utf8',
    env:{ ...process.env, PATH:dir+path.delimiter+process.env.PATH, RESULTS_DISPATCH_TOKEN:token,
      GITHUB_STEP_SUMMARY:summary, GITHUB_OUTPUT:output, TEST_CALL_FILE:callFile,
      RESULTS_COLLECTOR_RUN_ID:collector, RESULTS_DISPATCH_RUN_ID:dispatcher,
      TEST_HTTP_STATUS:status, TEST_CURL_EXIT:failure?'28':'0' } });
  const result = JSON.parse(p.stdout.split('\n').find(l=>l.startsWith('R334_RESULTS_REFRESH ')).slice('R334_RESULTS_REFRESH '.length));
  const text = fs.readFileSync(summary,'utf8'), outputs = fs.readFileSync(output,'utf8');
  assert.ok(!p.stdout.includes(TOKEN) && !p.stderr.includes(TOKEN) && !text.includes(TOKEN) && !outputs.includes(TOKEN), 'credential must never appear in logs, outputs or summaries');
  return { ...p,result,text,outputs,calls:fs.existsSync(callFile)?JSON.parse(fs.readFileSync(callFile)):null };
}

test('missing or invalid credentials cause zero requests and explicit NOT_DISPATCHED', t => {
  for (const token of ['', '  \n', 'not-a-credential']) {
    const r=run(t,{token});
    assert.equal(r.status,0); // Preserve the existing non-fatal credential policy.
    assert.equal(r.result.status,'NOT_DISPATCHED');
    assert.equal(r.result.dispatched,false);
    assert.equal(r.calls,null);
    assert.match(r.text,/本次没有成功派发/);
  }
});

test('204 reports acceptance only, exactly one main dispatch and bounded timeouts', t => {
  const r=run(t,{token:' \n'+TOKEN+'\n '});
  assert.equal(r.status,0);
  assert.equal(r.result.status,'DISPATCHED');
  assert.equal(r.result.dispatched,true);
  assert.match(r.outputs,/status=DISPATCHED/);
  assert.match(r.text,/尚未确认发布完成/);
  assert.equal(r.calls.filter(x=>x.startsWith('https://')).length,1);
  assert.ok(r.calls.includes('https://api.github.com/repos/lijianjun004-star/tcl-live-results/actions/workflows/publish.yml/dispatches'));
  assert.ok(r.calls.includes('{"ref":"main"}'));
  assert.ok(r.calls.includes('Authorization: Bearer '+TOKEN));
  assert.ok(r.calls.includes('--max-time') && r.calls.includes('45'));
  assert.ok(!r.calls.includes('--retry') && !r.calls.includes('-L'));
});

test('401 and 403 remain non-fatal but cannot report a successful dispatch', t => {
  for (const status of ['401','403']) {
    const r=run(t,{status});
    assert.equal(r.status,0);
    assert.equal(r.result.status,'NOT_DISPATCHED');
    assert.equal(r.result.reason,'CREDENTIAL_REJECTED');
    assert.equal(r.result.dispatched,false);
    assert.equal(r.result.httpStatus,Number(status));
  }
});

test('unexpected HTTP responses fail without pretending a deployment completed', t => {
  for (const status of ['200','404','429','500','000','001']) {
    const r=run(t,{status});
    assert.equal(r.status,1);
    assert.equal(r.result.status,'FAILED');
    assert.equal(r.result.dispatched,false);
  }
});

test('network timeout fails once and records REQUEST_FAILED', t => {
  const r=run(t,{status:'000',failure:true});
  assert.equal(r.status,1);
  assert.equal(r.result.reason,'REQUEST_FAILED');
  assert.equal(r.result.dispatched,false);
  assert.match(r.text,/是否已被接受未知/);
  assert.match(r.text,/旧快照不能当作本轮新数据/);
});

test('numeric run IDs correlate one dispatch with the publisher without changing its target', t => {
  const r=run(t,{collector:'12345',dispatcher:'67890'});
  assert.equal(r.status,0);
  const data=JSON.parse(r.calls[r.calls.indexOf('-d')+1]);
  assert.deepEqual(data,{ref:'main',inputs:{collector_run_id:'12345',dispatcher_run_id:'67890'}});
});

test('untrusted run IDs cannot enter JSON or issue a request', t => {
  const r=run(t,{collector:'123\n"unsafe"'});
  assert.equal(r.status,1);
  assert.equal(r.result.reason,'INVALID_RUN_CONTEXT');
  assert.equal(r.calls,null);
  assert.doesNotMatch(r.stdout,/unsafe/);
});

test('workflow preserves completion triggers, escaped plus and trust boundaries', () => {
  const wf=fs.readFileSync(path.join(ROOT,'.github/workflows/refresh-results-site.yml'),'utf8');
  assert.match(wf,/4 scoring \\\+ 3 monitor-only/);
  assert.match(wf,/types: \[completed\]/);
  assert.match(wf,/head_branch == 'main'/);
  assert.match(wf,/github\.event_name != 'pull_request'/);
  assert.match(wf,/ref: main\n\s+persist-credentials: false/);
  assert.match(wf,/run: bash scripts\/dispatch-results.sh/);
  assert.doesNotMatch(wf,/schedule:|contents: write/);
});
