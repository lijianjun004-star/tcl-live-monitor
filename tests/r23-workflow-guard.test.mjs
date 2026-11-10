import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const wf=fs.readFileSync(new URL('../.github/workflows/r23-jd-unattended.yml',import.meta.url),'utf8');
const state=fs.readFileSync(new URL('../probes/r23/jd-history.mjs',import.meta.url),'utf8');

test('scheduled workflow specifies BJT-compatible 5/15 minute UTC schedule',()=>{
 assert.match(wf,/cron: '0,5,10,15,30,45,55 \* \* \* \*'/);
 assert.match(wf,/Enforce Beijing 06:30 to 02:00 window/);
});
test('schedule is only possible after workflow is present on default branch',()=>{
 assert.match(wf,/GitHub scheduled events run ONLY from the repository default branch/);
 assert.match(wf,/branches:\s*\n\s*- experiment\/r23-jd-unattended-monitor/);
});
test('GitHub token has no main modification permission',()=>{
 assert.match(wf,/permissions:\s*\n\s*contents: read\s*\n\s*actions: read/);
 assert.doesNotMatch(wf,/\bcontents: write/);
 assert.doesNotMatch(wf,/git push|gh pr merge|deploy-pages/i);
});
test('restores state before polling and uploads after transition',()=>{
 assert.ok(wf.indexOf('Restore latest 7-day rolling state')<wf.indexOf('One authorized TCL OPS source scan'));
 assert.ok(wf.indexOf('Carry state forward')<wf.indexOf('Upload rolling history'));
 assert.match(wf,/r23-previous\.json/);
 assert.match(wf,/r23-state\.json/);
 assert.match(wf,/retention-days: 7/);
});
test('real source errors remain red, but state loss is not converted to OFFLINE',()=>{
 assert.match(wf,/continue-on-error: true/);
 assert.match(wf,/Gate true source\/persistence success after evidence upload/);
 assert.match(wf,/exit 1/);
 assert.match(wf,/UNKNOWN retained; NOT OFFLINE/);
});
test('90-day transition log and bounded seven-day rolling checks are separate',()=>{
 assert.match(state,/WINDOW_MS=90\*86400_000,CHECK_WINDOW_MS=7\*86400_000/);
 assert.match(state,/state\.events=trimRows\(state\.events,cutoff/);
 assert.match(state,/state\.checks=trimRows\(state\.checks,t-CHECK_WINDOW_MS/);
});
test('nothing from the source is stored as actual start/end or formal opening rate',()=>{
 assert.match(state,/actual_started_at:null,actual_ended_at:null/);
 assert.match(state,/state\.formal_opening_rate_percent=null/);
 assert.match(state,/verified_offline_counter:0/);
});
