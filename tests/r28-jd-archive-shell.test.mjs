import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';

const file=fs.readFileSync(new URL('../.github/workflows/jd-r23-scheduled.yml',import.meta.url),'utf8');
function bashStep(name){
 const i=file.indexOf('      - name: '+name+'\n');
 assert.ok(i>=0,'missing workflow step '+name);
 const after=file.slice(i), m='\n        run: |\n';
 const j=after.indexOf(m);assert.ok(j>=0,'missing bash multiline run for '+name);
 const rest=after.slice(j+m.length), end=rest.search(/\n      - name: /);
 const content=end<0?rest:rest.slice(0,end);
 return content.split('\n').map(s=>s.startsWith('          ')?s.slice(10):s).join('\n')+'\n';
}
for(const name of [
 'Restore latest 7-day rolling state from Actions artifact',
 "Check if today's 90-day history checkpoint already exists",
 'Write safe run proof to Actions job summary',
 'Gate true source/persistence success after evidence upload'
]){
 test('bash -n parses '+name,()=>{
  const r=spawnSync('bash',['-n'],{input:bashStep(name),encoding:'utf8'});
  assert.equal(r.status,0,'BASH_SYNTAX_REGRESSION '+name+'\n'+r.stderr);
 });
}
test('archive is daily-only; restore proof from PR45 still uses non-heredoc Node -e',()=>{
 const restore=bashStep('Restore latest 7-day rolling state from Actions artifact');
 assert.match(restore,/node --input-type=module -e "/);
 assert.doesNotMatch(restore,/node --input-type=module <<'JS'/);
 assert.match(restore,/MAIN_PRIOR_STATE_HAS_NO_RUN/);
 assert.match(file,/retention-days: 7/);
 assert.match(file,/retention-days: 90/);
 assert.match(file,/\.workflow_run\.head_branch == "main"/);
});
