import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {spawnSync} from 'node:child_process';

const workflow=fs.readFileSync(new URL('../.github/workflows/jd-r23-scheduled.yml',import.meta.url),'utf8');

function scriptOf(name){
 const start=workflow.indexOf('      - name: '+name+'\n');
 assert.ok(start>=0,'Missing step: '+name);
 const mark='        run: |\n';
 const begin=workflow.indexOf(mark,start);
 assert.ok(begin>=0,'Step has no inline run: '+name);
 const finish=workflow.indexOf('      - name:',begin+mark.length);
 return workflow.slice(begin+mark.length,finish<0?workflow.length:finish)
  .split('\n').map(l=>l.startsWith('          ')?l.slice(10):l).join('\n');
}
const summaryScript=scriptOf('Write safe run proof to Actions job summary');
const nodeSource=summaryScript.match(/node --input-type=module <<'JS'\n([\s\S]*?)\nJS(?:\n|$)/)?.[1]||'';
function countSlots(startIso,endIso){
 const begin=nodeSource.indexOf('const minuteSlots=');
 const end=nodeSource.indexOf('const gapMinutes=',begin);
 assert.ok(begin>=0&&end>begin,'Gap audit calculation missing');
 const code='const priorAt='+JSON.stringify(Date.parse(startIso))+';\nconst nowMs='+JSON.stringify(Date.parse(endIso))+';\n'+nodeSource.slice(begin,end)+'\nexpectedOpportunities;';
 return vm.runInNewContext(code,{Date,Math,Number});
}
test('the real GitHub Job Summary scripts pass bash -n and Node ESM --check',()=>{
 assert.ok(nodeSource.includes('expectedOpportunities'));
 const b=spawnSync('bash',['-n'],{input:summaryScript,encoding:'utf8'});
 assert.equal(b.status,0,b.stderr);
 const n=spawnSync('node',['--input-type=module','--check'],{input:nodeSource,encoding:'utf8'});
 assert.equal(n.status,0,n.stderr);
});
test('real Beijing operating window of 06:30 to 02:00 is used',()=>{
 assert.match(nodeSource,/8\*3600000/);
 assert.match(nodeSource,/localMinute>=390\|\|localMinute<=120/);
 assert.match(nodeSource,/minuteSlots=\[2,7,12,17,32,47,57\]/);
});
test('06:30-06:58 BJT yields three expected slots 06:32,06:47,06:57',()=>{
 assert.equal(countSlots('2026-11-10T22:30:00.000Z','2026-11-10T22:58:00.000Z'),3);
});
test('off-hours overnight are excluded from gap warning',()=>{
 assert.equal(countSlots('2026-11-10T18:01:00.000Z','2026-11-10T22:31:00.000Z'),0);
 assert.equal(countSlots('2026-11-10T18:01:00.000Z','2026-11-10T22:34:00.000Z'),1);
});
test('previous observed scan 09:54 to 16:37 has a material visibility gap',()=>{
 assert.ok(countSlots('2026-11-11T01:54:48.890Z','2026-11-11T08:37:03.000Z')>30);
});
test('same-minute recovery does not hallucinate a lost sample',()=>{
 assert.equal(countSlots('2026-11-11T08:37:03.000Z','2026-11-11T08:37:10.000Z'),0);
});
test('invalid old (>7d) data cannot produce an invented schedule gap',()=>{
 assert.equal(countSlots('2026-10-01T00:00:00.000Z','2026-11-11T08:37:03.000Z'),null);
});
test('warning is only audit annotation; it does not alter LIVE/UNKNOWN/OFFLINE',()=>{
 assert.match(nodeSource,/process\.env\.GITHUB_EVENT_NAME==='schedule'/);
 assert.match(nodeSource,/expectedOpportunities>=3/);
 assert.match(nodeSource,/::warning::JD SAMPLING_GAP:/);
 assert.match(nodeSource,/NOT evidence of OFFLINE/);
 assert.doesNotMatch(nodeSource,/r23-state\.json['"],\s*JSON\.stringify|\.state\s*=\s*'OFFLINE'/);
});
test('seven-day rolling Artifact is the only upload and Pages cannot be touched',()=>{
 assert.match(workflow,/retention-days: 7/);
 assert.equal((workflow.match(/uses: actions\/upload-artifact@v4/g)||[]).length,1);
 assert.doesNotMatch(workflow,/retention-days:\s*90|r27-jd-daily-|dailyupload|dailycheck/);
 assert.doesNotMatch(workflow,/deploy-pages|upload-pages-artifact|contents:\s*write|actions:\s*write/);
});
test('original permitted source and verified main-only state remain unchanged',()=>{
 assert.match(workflow,/ref: 267b6709a8563ef779cda6b11c97b9684c4e1c16/);
 assert.match(workflow,/\.workflow_run\.head_branch == "main"/);
 assert.match(workflow,/mark failed\/unknown signals UNKNOWN/);
 assert.match(workflow,/formal opening rate remains NULL/);
 assert.match(workflow,/cron: '2,7,12,17,32,47,57 \* \* \* \*'/);
});
