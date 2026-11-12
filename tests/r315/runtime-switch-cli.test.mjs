import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const cli = path.resolve('probes/r315/runtime-switch-cli.mjs');
const initial = {
  schemaVersion: 1,
  autoEnabled: { jd: false, douyin: false },
  sourceAccessApproved: { jd: false, douyin: false },
  adapterReady: { jd: false, douyin: false },
  updatedAt: '2026-11-12T00:00:00.000Z',
  updatedBy: 'bootstrap',
  updatedByRunId: null
};

test('CLI persists enable/disable switch changes but never starts a scan for control actions',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'r315-switch-'));
 try {
  const statePath=path.join(dir,'state.json'),summaryPath=path.join(dir,'summary.json');
  fs.writeFileSync(statePath,JSON.stringify(initial));
  const env={...process.env,GITHUB_EVENT_NAME:'workflow_dispatch',INPUT_ACTION:'enable_auto',
    INPUT_PLATFORM:'jd',GITHUB_ACTOR:'qa',GITHUB_RUN_ID:'700'};
  const enabled=spawnSync(process.execPath,[cli,statePath,summaryPath],{env,encoding:'utf8'});
  assert.equal(enabled.status,0,enabled.stderr);
  const state=JSON.parse(fs.readFileSync(statePath,'utf8'));
  const summary=JSON.parse(fs.readFileSync(summaryPath,'utf8'));
  assert.deepEqual(state.autoEnabled,{jd:true,douyin:false});
  assert.deepEqual(state.sourceAccessApproved,{jd:false,douyin:false});
  assert.equal(summary.decision,'CONTROL_UPDATE');
  assert.equal(summary.sourceAccess,false);
  assert.equal(summary.processModel,'ONE_SHOT_THEN_EXIT');
 } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('CLI manual run-once reports source gate and leaves automatic switch unchanged',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'r315-run-once-'));
 try {
  const statePath=path.join(dir,'state.json'),summaryPath=path.join(dir,'summary.json');
  fs.writeFileSync(statePath,JSON.stringify(initial));
  const env={...process.env,GITHUB_EVENT_NAME:'workflow_dispatch',INPUT_ACTION:'run_once',
    INPUT_PLATFORM:'both',GITHUB_ACTOR:'qa',GITHUB_RUN_ID:'701'};
  const result=spawnSync(process.execPath,[cli,statePath,summaryPath],{env,encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  const after=JSON.parse(fs.readFileSync(statePath,'utf8'));
  const summary=JSON.parse(fs.readFileSync(summaryPath,'utf8'));
  assert.deepEqual(after.autoEnabled,{jd:false,douyin:false});
  assert.equal(summary.decision,'BLOCKED');
  assert.equal(summary.sourceAccess,false);
  assert.ok(summary.targets.every(x=>x.reason==='SOURCE_ACCESS_NOT_APPROVED'));
 } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
