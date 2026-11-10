import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';

const workflow=fs.readFileSync(new URL('../.github/workflows/jd-r23-scheduled.yml',import.meta.url),'utf8');

function runScript(stepName){
 const lines=workflow.split('\n');
 const index=lines.findIndex(x=>x.trim()==='- name: '+stepName);
 assert.ok(index>=0,'missing step '+stepName);
 const runIndex=lines.findIndex((line,i)=>i>index&&line.trim()==='run: |');
 assert.ok(runIndex>=0,'missing multiline run '+stepName);
 const end=lines.findIndex((line,i)=>i>runIndex&&/^\s{6}- name: /.test(line));
 const body=lines.slice(runIndex+1,end<0?undefined:end).map(line=>{
  if(!line.trim())return '';
  assert.ok(line.startsWith('          '),'bad YAML script indentation');
  return line.slice(10);
 }).join('\n')+'\n';
 return body;
}
test('real MAIN restore shell script passes bash -n (not static token grep)',()=>{
 const script=runScript('Restore latest 7-day rolling state from Actions artifact');
 const p=spawnSync('bash',['-n'],{input:script,encoding:'utf8'});
 assert.equal(p.status,0,p.stderr);
});
test('MAIN source and state gate shells have no syntax errors',()=>{
 const name='Gate true source/persistence success after evidence upload';
 const p=spawnSync('bash',['-n'],{input:runScript(name),encoding:'utf8'});
 assert.equal(p.status,0,name+': '+p.stderr);
});
test('RESTORE requires provenance checked same repository MAIN-only Artifact',()=>{
 const s=runScript('Restore latest 7-day rolling state from Actions artifact');
 assert.match(s,/workflow_run\.head_branch == "main"/);
 assert.match(s,/workflow_run\.repository_id == \.workflow_run\.head_repository_id/);
 assert.match(s,/artifacts\?name=r24-jd-main-state&per_page=100/);
 assert.match(s,/validateState\(JSON\.parse/);
 assert.match(s,/last_processed_run/);
});
test('failed prior state never silently bootstraps as a new observation',()=>{
 const s=runScript('Restore latest 7-day rolling state from Actions artifact');
 assert.match(s,/set -euo pipefail/);
 assert.match(s,/if test -n "\$artifact_id"/);
 assert.match(s,/throw Error\("MAIN_PRIOR_STATE_HAS_NO_RUN"\)/);
 assert.doesNotMatch(s,/rm -rf|curl -L/);
});
test('read-only runner cannot publish or mutate Pages',()=>{
 assert.match(workflow,/permissions:\s*\n\s+contents: read\s*\n\s+actions: read/);
 assert.doesNotMatch(workflow,/contents:\s*write|deploy-pages|gh-pages/);
});
