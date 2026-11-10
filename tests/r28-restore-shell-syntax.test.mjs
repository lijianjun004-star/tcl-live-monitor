import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';

const workflow=fs.readFileSync(new URL('../.github/workflows/jd-r23-scheduled.yml',import.meta.url),'utf8');
function stepRun(name){
 const start=workflow.indexOf('      - name: '+name+'\n');
 assert.ok(start>=0,'missing step: '+name);
 const sliced=workflow.slice(start);
 const marker='\n        run: |\n';
 const pos=sliced.indexOf(marker);
 assert.ok(pos>=0,'step is not multiline bash: '+name);
 const block=sliced.slice(pos+marker.length);
 const next=block.search(/\n      - name: /);
 const raw=next<0?block:block.slice(0,next);
 return raw.split('\n').map(line=>line.startsWith('          ')?line.slice(10):line).join('\n')+'\n';
}
test('restore Shell extracted from YAML parses with bash -n',()=>{
 const script=stepRun('Restore latest 7-day rolling state from Actions artifact');
 const r=spawnSync('bash',['-n'],{input:script,encoding:'utf8'});
 assert.equal(r.status,0,r.stderr);
});
test('restore does not use indented nested heredoc inside if block',()=>{
 const script=stepRun('Restore latest 7-day rolling state from Actions artifact');
 assert.match(script,/node --input-type=module -e 'import fs from "node:fs";/);
 assert.doesNotMatch(script,/node --input-type=module <<'JS'/);
});
test('whole restore keeps MAIN-only source, strict saved-state validation and safe bootstrap',()=>{
 const script=stepRun('Restore latest 7-day rolling state from Actions artifact');
 assert.match(script,/\.workflow_run\.head_branch == "main"/);
 assert.match(script,/\.workflow_run\.repository_id == \.workflow_run\.head_repository_id/);
 assert.match(script,/validateState\(/);
 assert.match(script,/MAIN_PRIOR_STATE_HAS_NO_RUN/);
 assert.match(script,/No eligible MAIN-branch state artifact/);
});
test('source scan stays read only and preservation has a stable namespace',()=>{
 assert.match(workflow,/permissions:\s*\n\s+contents: read\s*\n\s+actions: read/);
 assert.match(workflow,/node probes\/tcl-jd-all\.mjs --shard-index 0 --shard-total 1/);
 assert.match(workflow,/name: r24-jd-main-state/);
 assert.doesNotMatch(workflow,/deploy-pages|upload-pages-artifact|contents:\s*write/);
});
test('scheduler cron and manual dispatch are unchanged',()=>{
 assert.match(workflow,/schedule:\s*\n\s+- cron: '0,5,10,15,30,45,55 \* \* \* \*'/);
 assert.match(workflow,/workflow_dispatch:/);
 assert.match(workflow,/contains\(github\.event\.head_commit\.message, '\[jd-main-smoke\]'\)/);
});
