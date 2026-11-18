import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {update} from '../../probes/r327/jd-fullday.mjs';
import {withHistoryTransaction} from '../../probes/lib/history-files.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const guard=path.join(root,'scripts/offline-test-guard.cjs').replaceAll('\\','/');
const run=(id,conclusion)=>({id,conclusion,run_attempt:1,status:'completed',head_branch:'main',event:'schedule',path:'.github/workflows/jd-fullday-rate.yml',repository:{id:1,full_name:'lijianjun004-star/tcl-live-monitor'},head_repository:{id:1,full_name:'lijianjun004-star/tcl-live-monitor'},created_at:`2026-11-18T00:0${id}:00.000Z`});
async function fixture(mode){
  const d=fs.mkdtempSync(path.join(os.tmpdir(),'jd-restore-shell-'));
  for(const file of ['scripts/restore-jd-fullday-state.sh','scripts/restore-jd-fullday-state.mjs','probes/r327/jd-fullday.mjs','probes/lib/history-files.mjs']){
    fs.mkdirSync(path.dirname(path.join(d,file)),{recursive:true});fs.copyFileSync(path.join(root,file),path.join(d,file));
  }
  fs.mkdirSync(path.join(d,'bin'));fs.mkdirSync(path.join(d,'fixture'));
  fs.writeFileSync(path.join(d,'fixture/runs.json'),JSON.stringify({total_count:2,workflow_runs:[run(1,'success'),run(2,'failure')]}));
  const state=update(null,[],'2026-11-18T00:02:00.000Z');
  await withHistoryTransaction({stateOutput:path.join(d,'fixture/artifact/state.json'),summaryOutput:path.join(d,'fixture/artifact/report.json')},()=>({state,summary:{generatedAt:state.lastRunAt,sourceStatus:'FAILED',rows:[]}}));
  if(mode==='interrupted')fs.writeFileSync(path.join(d,'fixture/artifact/state.json.lock'),'INTERRUPTED');
  if(mode==='directory-interrupted')fs.writeFileSync(path.join(d,'fixture/artifact/.jd-history.lock'),'INTERRUPTED_BEFORE_STATE_LOCK');
  fs.writeFileSync(path.join(d,'bin/gh'),`#!/bin/bash\nset -euo pipefail\nif [[ "$1" == api ]]; then cat fixture/runs.json; elif [[ "$1 $2" == 'run download' ]]; then printf '%s' "$3" > downloaded-id; ${mode==='missing'?'exit 1':'mkdir -p prev/download; cp -R fixture/artifact/. prev/download/'}; else exit 99; fi\n`,{mode:0o755});
  return {d,exec:()=>spawnSync('bash',['scripts/restore-jd-fullday-state.sh'],{cwd:d,encoding:'utf8',env:{...process.env,
    PATH:path.join(d,'bin')+path.delimiter+process.env.PATH,NODE_OPTIONS:`--require="${guard}"`,
    GITHUB_REPOSITORY:'lijianjun004-star/tcl-live-monitor',GITHUB_RUN_ID:'3',GITHUB_OUTPUT:path.join(d,'outputs'),
    HTTP_PROXY:'http://127.0.0.1:9',HTTPS_PROXY:'http://127.0.0.1:9',ALL_PROXY:'http://127.0.0.1:9',NO_PROXY:'127.0.0.1,localhost,::1'}})};
}
test('actual restore shell carries the most recent failed run instead of earlier success',async()=>{
  const f=await fixture('valid');try{
    const r=f.exec();assert.equal(r.status,0,r.stderr);
    assert.equal(fs.readFileSync(path.join(f.d,'downloaded-id'),'utf8'),'2');
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.d,'out/previous.json'))).sourceStatus,'FAILED');
    assert.match(fs.readFileSync(path.join(f.d,'outputs'),'utf8'),/previous=out\/previous.json/);
  }finally{fs.rmSync(f.d,{recursive:true,force:true});}
});
for(const mode of ['missing','interrupted','directory-interrupted'])test(`actual restore shell persists blocking marker for ${mode} latest failure; never falls back`,async()=>{
  const f=await fixture(mode);try{
    const r=f.exec();assert.notEqual(r.status,0);
    assert.equal(fs.readFileSync(path.join(f.d,'downloaded-id'),'utf8'),'2');
    assert.equal(fs.existsSync(path.join(f.d,'out/previous.json')),false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.d,'out/recovery-block.json'))).reason,'RESTORE_UNVERIFIED');
  }finally{fs.rmSync(f.d,{recursive:true,force:true});}
});
