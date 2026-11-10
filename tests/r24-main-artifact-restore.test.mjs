import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';

const workflow=fs.readFileSync(new URL('../.github/workflows/jd-r23-scheduled.yml',import.meta.url),'utf8');
const match=workflow.match(/--jq '([^']+)'/);
assert.ok(match,'GitHub CLI restore command must have an auditable jq filter');
const policy=match[1];
function artifact(id,branch,created_at,extra={}){
 return {id,name:'r24-jd-main-state',expired:false,created_at,
  workflow_run:{head_branch:branch,repository_id:1444644666,head_repository_id:1444644666},
  ...extra};
}
function select(artifacts){
 const r=spawnSync('jq',['-r',policy],{input:JSON.stringify({artifacts}),encoding:'utf8'});
 assert.equal(r.status,0,r.stderr);
 return r.stdout.trim();
}
test('does not recover a newer experiment artifact in preference to MAIN',()=>{
 const candidates=[artifact(100,'main','2026-11-10T15:00:00Z'),
  artifact(200,'experiment/r23-jd-unattended-monitor','2026-11-10T15:10:00Z')];
 assert.equal(select(candidates),'100');
});
test('rejects expired artifacts, forks and absent workflow provenance',()=>{
 const candidates=[
  artifact(1,'main','2026-11-10T15:01:00Z',{expired:true}),
  artifact(2,'main','2026-11-10T15:02:00Z',{workflow_run:{head_branch:'main',repository_id:1,head_repository_id:2}}),
  {id:3,expired:false,created_at:'2026-11-10T15:03:00Z'},
  artifact(4,'experiment/r23-jd-unattended-monitor','2026-11-10T15:04:00Z')
 ];
 assert.equal(select(candidates),'');
});
test('selects newest valid MAIN artifact even when unordered',()=>{
 const candidates=[artifact(1,'main','2026-11-10T15:01:00Z'),
 artifact(3,'main','2026-11-10T15:03:00Z'),artifact(2,'main','2026-11-10T15:02:00Z')];
 assert.equal(select(candidates),'3');
});
test('bootstrap is safe when no matching MAIN artifact exists',()=>{
 assert.equal(select([artifact(99,'experiment/r23-jd-unattended-monitor','2026-11-10T15:00:00Z')]),'');
});
test('restore and upload use the same release-specific artifact namespace',()=>{
 assert.match(workflow,/artifacts\?name=r24-jd-main-state&per_page=100/);
 assert.match(workflow,/^\s+name: r24-jd-main-state$/m);
 assert.doesNotMatch(workflow,/artifacts\?name=r23-jd-state&/);
});
test('normal schedule is confined to main and never writes Pages',()=>{
 assert.match(workflow,/267b6709a8563ef779cda6b11c97b9684c4e1c16/);
 assert.match(workflow,/if: github\.event_name == 'schedule' \|\| github\.event_name == 'workflow_dispatch'/);
 assert.match(workflow,/permissions:\s*\n\s+contents: read\s*\n\s+actions: read/);
 assert.doesNotMatch(workflow,/contents:\s*write/);
 assert.doesNotMatch(workflow,/deploy-pages|upload-pages-artifact|gh-pages/);
});
