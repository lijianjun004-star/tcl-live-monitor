// Offline regression tests for the Claude independent review of PR #77.
// These are synthetic fixtures: not proof of Douyin/JD site behavior.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { deliveryKey } from '../../probes/r316/one-shot-runner.mjs';
import { reconcileDouyinFourLayers } from '../../probes/r36/douyin-evidence-gate.mjs';

const config = JSON.parse(fs.readFileSync('config/probe-targets.json', 'utf8'));
test('Claude P2-A: duplicate scheduled delivery within one Beijing hour shares a run key', () => {
  const k=deliveryKey({eventName:'schedule',runId:'1',now:Date.parse('2026-11-12T13:35:10Z')});
  assert.equal(k,'sched.2026-11-12.21');
  assert.equal(deliveryKey({eventName:'schedule',runId:'2',now:Date.parse('2026-11-12T14:20:00Z')}),k);
  assert.equal(deliveryKey({eventName:'schedule',runId:'3',now:Date.parse('2026-11-12T14:36:00Z')}),'sched.2026-11-12.22');
});
test('Claude P2-A: manual dispatch attempts share key; distinct dispatches do not', () => {
  assert.equal(deliveryKey({eventName:'workflow_dispatch',runId:'77',now:0}),'run.77');
  assert.equal(deliveryKey({eventName:'workflow_dispatch',runId:'77',now:Date.now()}),'run.77');
  assert.equal(deliveryKey({eventName:'workflow_dispatch',runId:'78',now:0}),'run.78');
  assert.throws(()=>deliveryKey({eventName:'workflow_dispatch',runId:'x;rm',now:0}),/RUN_ID_INVALID/);
});
const acct=config.douyin[0];
const uid=new URL(acct.profileUrl).pathname.split('/').pop();
const T='2026-11-12T13:00:00.000Z';
const proofs=['OPS_ROOM_SHOP','PUBLIC_ACCOUNT_ROOM','CROSS_SYSTEM_BRIDGE'].map((kind,i)=>({kind,observedAt:T,ref:'REVIEWREF0'+i}));
const roomRows=[{roomId:'601',shopId:'1601',platform:'douyin'},{roomId:'602',shopId:'1602',platform:'douyin'}];
const record=(v={})=>({opsRoomId:'601',opsShopId:'1601',accountKey:acct.key,publicSecUid:uid,publicLiveRoomId:'9999999',observedAt:T,reviewApproved:true,proofs,...v});
const classify=ev=>Object.fromEntries(reconcileDouyinFourLayers({opsRooms:roomRows,accounts:config.douyin,evidenceRows:ev}).links.map(r=>[r.opsRoomId,r.bridgeStatus]));
test('Claude P2-B: conflicting room-shop evidence is CONFLICT',()=>{
  assert.equal(classify([record({opsShopId:'1602'})])['601'],'CONFLICT');
});
test('Claude P2-B: one account proposed for multiple rooms is CONFLICT even before verification',()=>{
  const r=classify([record({reviewApproved:false}),record({opsRoomId:'602',opsShopId:'1602',reviewApproved:false})]);
  assert.deepEqual(r,{'601':'CONFLICT','602':'CONFLICT'});
});
test('Claude P2-B: competing candidate revokes a previously VERIFIED link',()=>{
  assert.deepEqual(classify([record(),record({opsRoomId:'602',opsShopId:'1602',reviewApproved:false})]),{'601':'CONFLICT','602':'CONFLICT'});
});
test('Claude P2-B: baseline NO_EVIDENCE/VERIFIED/CANDIDATE still work',()=>{
  assert.equal(classify([])['601'],'NO_EVIDENCE');
  assert.equal(classify([record()])['601'],'VERIFIED');
  assert.equal(classify([record({reviewApproved:false})])['601'],'CANDIDATE');
});
test('Claude P3: Beijing date no longer depends on Intl timezone support',()=>{
  const script="Intl.DateTimeFormat=function(){throw new RangeError('no tz')};const {beijingDate:b}=await import('./probes/lib/tcl-jd-all.mjs');console.log([b(Date.parse('2026-11-11T15:59:59Z')),b(Date.parse('2026-11-11T16:00:00Z')),b(new Date('2026-12-31T16:00:00Z')),b(NaN)].join(','))";
  const r=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8'});
  assert.equal(r.stdout.trim(),'2026-11-11,2026-11-12,2027-01-01,INVALID_DATE',r.stderr);
});
test('Claude P2-D/E: source runner lacks job token, RPA logs blocked hosts and blocks WebSocket',()=>{
  const wf=fs.readFileSync('.github/workflows/r315-switchable-one-shot.yml','utf8');
  const jobEnv=wf.slice(wf.indexOf('\n    env:'),wf.indexOf('\n    steps:'));
  assert.doesNotMatch(jobEnv,/GH_TOKEN/);
  const scanner=wf.slice(wf.indexOf('      - name: Execute READY targets'),wf.indexOf('      - name: Persist authenticated private state'));
  assert.doesNotMatch(scanner,/GH_TOKEN/);
  const rpa=fs.readFileSync('probes/r316/douyin-rpa-two-once.mjs','utf8');
  assert.match(rpa,/ctx\.routeWebSocket\(/);
  assert.match(rpa,/R316_RPA_BLOCKED/);
  assert.match(rpa,/roomId: t\.roomId \|\| undefined/);
});
