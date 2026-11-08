import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalizeObservation } from '../probes/r18/schema.mjs';
import { buildReport, renderReport } from '../probes/r18/report.mjs';
import { resolveSessionEvidence } from '../probes/r18/browser/tmall-session.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
function setup(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'r18-cli-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
function run(dir,args=[]){const r=spawnSync(process.execPath,['probes/r18/cli.mjs','--out-dir',dir,...args],{cwd:root,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return JSON.parse(fs.readFileSync(path.join(dir,'report.json'),'utf8'));}
test('R18 CLI no-source writes UNKNOWN report and no invented sessions',t=>{const dir=setup(t);const r=run(dir);assert.equal(r.observations.length,1);assert.equal(r.observations[0].state,'UNKNOWN');assert.equal(r.sessions.length,0);assert.equal(r.observations[0].failure_code,'NO_VALID_TARGET_EVIDENCE');assert.ok(fs.readFileSync(path.join(dir,'report.html'),'utf8').includes('是否为精确上下播时间：否'));});
test('R18 CLI manual fixed request retry dedupes disk state',t=>{const dir=setup(t);run(dir,['--request-id','fixed']);const r=run(dir,['--request-id','fixed']);assert.equal(r.duplicate,true);assert.equal(r.observations.length,1);});
test('R18 CLI hourly same planned slot dedupes different actual time',t=>{const dir=setup(t);run(dir,['--mode','hourly','--planned-at','2026-11-08T08:00:00Z','--actual-at','2026-11-08T08:04:00Z']);const r=run(dir,['--mode','hourly','--planned-at','2026-11-08T08:00:00Z','--actual-at','2026-11-08T08:15:00Z']);assert.equal(r.duplicate,true);assert.equal(r.observations.length,1);assert.equal(r.observations[0].actual_check_at,'2026-11-08T08:04:00.000Z');});
test('R18 report escapes source/evidence content and distinguishes session status',()=>{const r=buildReport({observations:[{state:'UNKNOWN',source_type:'<script>alert(1)</script>',evidence_ref:'" onload="evil'}],sessions:[{status:'OPEN'},{status:'CLOSED'},{status:'REPLACED_BY_NEW_LIVE_ID'}]});assert.equal(r.current_sessions.length,1);const html=renderReport(r);assert.ok(!html.includes('<script>'));assert.ok(html.includes('&lt;script&gt;'));assert.ok(html.includes('&quot; onload=&quot;'));});
test('R18 UNKNOWN fault reasons survive schema normalization',()=>{for(const failure_code of ['AUTH_REQUIRED','TIMEOUT','NETWORK_ERROR','COOLDOWN_ACTIVE']){const o=normalizeObservation({platform:'tmall',account_id:'2050532947',actual_check_at:'2026-11-08T08:00:00Z',planned_check_at:'2026-11-08T08:00:00Z',state:'UNKNOWN',source_attested:false,failure_code});assert.equal(o.failure_code,failure_code);assert.equal(o.state,'UNKNOWN');}});
test('R18 browser evidence conflict and auth override candidate LIVE',()=>{const fallback={state:'UNKNOWN',source_attested:false,failure_code:'NO_VALID_TARGET_EVIDENCE'};const a={account_id:'2050532947',state:'LIVE',live_id:'111111',source_attested:true};assert.equal(resolveSessionEvidence([a,{...a,live_id:'222222'}],fallback).failure_code,'CONFLICTING_EVIDENCE');assert.equal(resolveSessionEvidence([a,{state:'UNKNOWN',failure_code:'AUTH_REQUIRED'}],fallback).state,'UNKNOWN');assert.equal(resolveSessionEvidence([a,{...a,room_id:'999'}],fallback).state,'LIVE');});
test('R18 runtime code contains no embedded private keys or provider tokens',()=>{const files=fs.readdirSync(path.join(root,'probes/r18'),{recursive:true}).filter(f=>f.endsWith('.mjs'));const pattern=/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-proj-[A-Za-z0-9_-]{30,}/;for(const f of files)assert.equal(pattern.test(fs.readFileSync(path.join(root,'probes/r18',f),'utf8')),false,f);});
