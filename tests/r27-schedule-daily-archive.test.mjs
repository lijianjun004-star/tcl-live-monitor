import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';

const s=fs.readFileSync(new URL('../.github/workflows/jd-r23-scheduled.yml',import.meta.url),'utf8');
const cron=/cron:\s*'([^']+)'/.exec(s)?.[1];
const minuteList=cron?.split(' ')[0].split(',').map(Number);
const bjtValid=x=>x>=390||x<=120;

test('cron is deliberately off whole-hour high-load and has distinct minutes',()=>{
 assert.equal(cron,'2,7,12,17,32,47,57 * * * *');
 assert.deepEqual(minuteList,[2,7,12,17,32,47,57]);
 assert.equal(new Set(minuteList).size,7);
 assert.ok(!minuteList.includes(0));
});
test('critical hour-edge sample spacing stays at 5 minutes and regular spacing at 15',()=>{
 const wrap=[...minuteList,minuteList[0]+60];
 const gaps=wrap.slice(1).map((m,i)=>m-wrap[i]);
 assert.deepEqual(gaps,[5,5,5,15,15,10,5]);
});
test('first operating scan is 06:32 and final pre-close scan is 01:57',()=>{
 const today=Array.from({length:24},(_,h)=>minuteList.map(m=>h*60+m)).flat();
 const active=today.filter(bjtValid);
 assert.equal(active[0],2); // 00:02 is in cross-midnight window
 assert.ok(active.includes(6*60+32));
 assert.ok(active.includes(1*60+57));
 assert.ok(!active.includes(2*60+2));
 assert.ok(!active.includes(6*60+17));
});
test('schedule is still on default branch and manual dispatch remains',()=>{
 assert.match(s,/schedule:\s*\n\s+# \+2 minute offset/);
 assert.match(s,/workflow_dispatch:/);
 assert.match(s,/if: github\.event_name == 'schedule' \|\| github\.event_name == 'workflow_dispatch'/);
 assert.match(s,/github\.event\.head_commit\.message, '\[jd-main-smoke\]'/);
});
test('runner reports offset clock accurately rather than treating +2 as missed R2.3 slot',()=>{
 assert.match(s,/import \{isOperatingTime,beijingClock\}/);
 assert.doesNotMatch(s,/const slot=plannedSample\(new Date\(\)\)/);
 assert.match(s,/cron_offset_minutes:2/);
});
test('checkpoint date derives from Beijing timezone not runner local timezone',()=>{
 assert.match(s,/TZ=Asia\/Shanghai date \+%Y-%m-%d/);
 assert.match(s,/checkpoint_name="r27-jd-daily-\$\(/);
});
test('daily checkpoint selection is scoped to main repository branch and unexpired artifacts',()=>{
 assert.match(s,/actions\/artifacts\?name=\$\{checkpoint_name\}&per_page=100/);
 assert.match(s,/\.workflow_run\.head_branch == "main"/);
 assert.match(s,/\.workflow_run\.repository_id == \.workflow_run\.head_repository_id/);
 assert.match(s,/\.expired == false/);
 assert.match(s,/steps\.dailycheck\.outputs\.should_upload == 'true'/);
});
test('archive is once per Beijing day; existing archive does not upload again',()=>{
 assert.match(s,/if test "\$\{count\}" = 0; then/);
 assert.match(s,/echo "should_upload=true"/);
 assert.match(s,/echo "should_upload=false"/);
 assert.match(s,/avoiding duplicate archive/);
});
test('90-day daily archive separate from 7-day rolling state',()=>{
 const rolling=s.match(/name: Upload rolling history and sanitized snapshot[\s\S]*?(?=\n\s+- name:)/)?.[0]??'';
 const daily=s.match(/name: Upload one daily 90-day immutable checkpoint[\s\S]*?(?=\n\s+- name:)/)?.[0]??'';
 assert.match(rolling,/name: r24-jd-main-state/);
 assert.match(rolling,/retention-days: 7/);
 assert.match(daily,/name: \$\{\{ steps\.dailycheck\.outputs\.name \}\}/);
 assert.match(daily,/retention-days: 90/);
 for(const file of ['r23-state.json','r23-summary.json']){
  assert.ok(rolling.includes(file));
  assert.ok(daily.includes(file));
 }
});
test('cannot report success if daily archive listing or first upload fails',()=>{
 const gate=s.match(/name: Gate true source\/persistence success after evidence upload[\s\S]*$/)?.[0]??'';
 assert.match(gate,/steps\.dailycheck\.outcome/);
 assert.match(gate,/steps\.dailyupload\.outcome/);
 assert.match(gate,/steps\.dailycheck\.outputs\.should_upload/);
 assert.match(gate,/exit 1/);
});
test('history remains UNKNOWN on missing source and exact start/end/rate are never fabricated',()=>{
 assert.match(s,/mark failed\/unknown signals UNKNOWN/);
 assert.match(s,/Exact broadcast starts, ends and formal opening rate: NOT VERIFIED/);
 assert.match(s,/formal opening rate remains NULL/);
});
test('all traffic and write permissions remain restricted; Pages not changed by workflow',()=>{
 assert.match(s,/permissions:\s*\n\s+contents: read\s*\n\s+actions: read/);
 assert.match(s,/ref: 267b6709a8563ef779cda6b11c97b9684c4e1c16/);
 assert.doesNotMatch(s,/deploy-pages|upload-pages-artifact|gh-pages\/|contents:\s*write|actions:\s*write/);
});
test('archive date and state are based on successful state output only',()=>{
 assert.match(s,/id: dailycheck\s*\n\s+if: steps\.window\.outputs\.should_run == 'true' && steps\.state\.outcome == 'success' && github\.ref == 'refs\/heads\/main'/);
 assert.match(s,/if-no-files-found: error/);
});
test('jq daily-archive match ignores fork/experiment/expired artifacts',()=>{
 const m=s.match(/count=\$\(gh api .*? --jq '([^']+)'\)/);
 assert.ok(m);
 const input={artifacts:[
  {expired:false,workflow_run:{head_branch:'main',repository_id:100,head_repository_id:100}},
  {expired:false,workflow_run:{head_branch:'experiment',repository_id:100,head_repository_id:100}},
  {expired:true,workflow_run:{head_branch:'main',repository_id:100,head_repository_id:100}},
  {expired:false,workflow_run:{head_branch:'main',repository_id:100,head_repository_id:200}}
 ]};
 const proc=spawnSync('jq',['-r',m[1]],{input:JSON.stringify(input),encoding:'utf8'});
 assert.equal(proc.status,0,proc.stderr);
 assert.equal(proc.stdout.trim(),'1');
});
