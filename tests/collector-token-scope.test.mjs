import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
test('collector jobs expose GitHub CLI token only to artifact restore steps',()=>{
 for(const name of ['douyin-daily-broadcast.yml','tmall-daily-broadcast.yml','jd-fullday-rate.yml']){
  const wf=fs.readFileSync('.github/workflows/'+name,'utf8');
  assert.doesNotMatch(wf,/^      GH_TOKEN:/m,name+' job token must not reach collector');
  assert.match(wf,/id: (?:restore|gate)\n        env:\n          GH_TOKEN: \$\{\{ github.token \}\}/,name);
  assert.equal((wf.match(/GH_TOKEN:/g)||[]).length,1,name);
 }
});
