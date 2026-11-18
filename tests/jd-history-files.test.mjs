import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {withHistoryTransaction,verifyHistoryPair,validateHistoryCommit,readHistoryJson} from '../probes/lib/history-files.mjs';
import {decideJdBackup} from '../probes/r33/jd-backup-freshness.mjs';
const moduleURL=new URL('../probes/lib/history-files.mjs',import.meta.url).href;
const temp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'jd-transaction-'));
const paths=d=>({stateOutput:path.join(d,'state.json'),summaryOutput:path.join(d,'summary.json')});
const build=s=>({state:{value:(s?.value??0)+1},summary:{value:(s?.value??0)+1}});
test('explicit null or array history cannot masquerade as an empty bootstrap',async()=>{
  const d=temp();try{
    const previous=path.join(d,'previous.json');
    for(const value of ['null','[]']){
      fs.writeFileSync(previous,value);
      await assert.rejects(withHistoryTransaction({...paths(d),previous},build),/HISTORY_INPUT_UNAVAILABLE/);
      assert.equal(fs.existsSync(paths(d).stateOutput),false);
    }
  }finally{fs.rmSync(d,{recursive:true,force:true});}
});
async function childAt(d,phase){
  const child=spawn(process.execPath,['--input-type=module','-e',`
    import {withHistoryTransaction} from ${JSON.stringify(moduleURL)};
    try {await withHistoryTransaction(${JSON.stringify(paths(d))},()=>({state:{value:1},summary:{value:1}}),{
      checkpoint:async phase=>{if(phase===${JSON.stringify(phase)}){process.send('ready');await new Promise(resolve=>process.once('message',resolve));}}
    });process.disconnect();}catch{process.exit(7);}`],{stdio:['ignore','ignore','pipe','ipc']});
  let stderr='';child.stderr.on('data',b=>stderr+=b);
  const timer=setTimeout(()=>child.kill(),5000);
  try{
    await Promise.race([once(child,'message'),once(child,'exit').then(()=>{throw Error('worker exited: '+stderr);})]);
  }finally{clearTimeout(timer);}
  return child;
}
test('single authoritative state carries summary and digest; tampered or mixed generation pair is rejected',async()=>{
  const d=temp();try{
    const first=await withHistoryTransaction(paths(d),build);
    verifyHistoryPair(first.state,first.summary);
    assert.deepEqual(first.state._historyCommit.summary,first.summary);
    assert.throws(()=>verifyHistoryPair(first.state,{...first.summary,value:999}),/HISTORY_PAIR_MISMATCH/);
    const changed=structuredClone(first.state);changed.value=999;
    assert.throws(()=>validateHistoryCommit(changed),/HISTORY_COMMIT_INVALID/);
    assert.equal(fs.existsSync(paths(d).stateOutput+'.lock'),false);
  }finally{fs.rmSync(d,{recursive:true,force:true});}
});
test('a second process cannot enter an active read-modify-publish transaction',async()=>{
  const d=temp();let child;try{
    child=await childAt(d,'locked');let called=false;
    await assert.rejects(withHistoryTransaction(paths(d),()=>{called=true;return build(null);}),/HISTORY_LOCK_REQUIRES_REVIEW/);
    assert.equal(called,false);
    const exited=once(child,'exit');child.send('continue');assert.equal((await exited)[0],0);
    verifyHistoryPair(readHistoryJson(paths(d).stateOutput),readHistoryJson(paths(d).summaryOutput));
  }finally{if(child?.exitCode===null)child.kill();fs.rmSync(d,{recursive:true,force:true});}
});
test('different state paths cannot concurrently publish to a shared summary in the same directory',async()=>{
  const d=temp();let child;try{
    child=await childAt(d,'locked');
    await assert.rejects(withHistoryTransaction({...paths(d),stateOutput:path.join(d,'other-state.json')},build),/HISTORY_LOCK_REQUIRES_REVIEW/);
    const exited=once(child,'exit');child.send('continue');assert.equal((await exited)[0],0);
  }finally{if(child?.exitCode===null){const exited=once(child,'exit');child.kill();await exited;}fs.rmSync(d,{recursive:true,force:true});}
});
for(const phase of ['prepared','state-published'])test(`process death at ${phase} leaves a blocking lock; no silent reinitialization`,async()=>{
  const d=temp();let child;try{
    child=await childAt(d,phase);const exited=once(child,'exit');child.kill('SIGKILL');await exited;
    assert.equal(fs.existsSync(paths(d).stateOutput+'.lock'),true);
    await assert.rejects(withHistoryTransaction(paths(d),build),/HISTORY_LOCK_REQUIRES_REVIEW/);
    if(phase==='state-published'){
      const state=readHistoryJson(paths(d).stateOutput);validateHistoryCommit(state);
      assert.equal(state._historyCommit.summary.value,1);
      assert.throws(()=>verifyHistoryPair(state,null),/HISTORY_PAIR_MISMATCH/);
    }else assert.equal(fs.existsSync(paths(d).stateOutput),false);
  }finally{if(child?.exitCode===null)child.kill();fs.rmSync(d,{recursive:true,force:true});}
});
test('stale previous snapshot cannot overwrite a newer committed generation',async()=>{
  const d=temp();try{
    await withHistoryTransaction(paths(d),build);
    const previous=path.join(d,'old.json');fs.copyFileSync(paths(d).stateOutput,previous);
    await withHistoryTransaction({...paths(d),previous:paths(d).stateOutput},build);
    let called=false;
    await assert.rejects(withHistoryTransaction({...paths(d),previous},()=>{called=true;return build(null);}),/HISTORY_STALE_PREVIOUS/);
    assert.equal(called,false);assert.equal(readHistoryJson(paths(d).stateOutput).value,2);
  }finally{fs.rmSync(d,{recursive:true,force:true});}
});
test('failure before publish cleans temporary files and preserves existing bytes',async()=>{
  const d=temp();try{
    await withHistoryTransaction(paths(d),build);
    const before=fs.readFileSync(paths(d).stateOutput);
    await assert.rejects(withHistoryTransaction({...paths(d),previous:paths(d).stateOutput},build,{checkpoint:phase=>{if(phase==='prepared')throw Error('INJECTED_WRITE_FAILURE');}}),/INJECTED_WRITE_FAILURE/);
    assert.deepEqual(fs.readFileSync(paths(d).stateOutput),before);
    assert.equal(fs.readdirSync(d).filter(n=>n.endsWith('.tmp')||n.endsWith('.lock')).length,0);
  }finally{fs.rmSync(d,{recursive:true,force:true});}
});
test('oversized next snapshot is rejected before authoritative publish',async()=>{
  const d=temp();try{
    await assert.rejects(withHistoryTransaction(paths(d),()=>({state:{data:'x'.repeat(12*1024*1024)},summary:{}})),/HISTORY_OUTPUT_TOO_LARGE/);
    assert.equal(fs.existsSync(paths(d).stateOutput),false);assert.equal(fs.readdirSync(d).length,0);
  }finally{fs.rmSync(d,{recursive:true,force:true});}
});
for(const phase of ['locked','prepared','state-published','summary-published'])for(const name of ['state.json.lock','.jd-history.lock'])
test(`replacement of ${name} at ${phase} cannot publish further or delete the replacement owner's lock`,async()=>{
  const d=temp();try{
    const replacement={version:1,id:'99999999-9999-4999-8999-999999999999',reason:'WRITE_IN_PROGRESS_OR_INTERRUPTED'};
    await assert.rejects(withHistoryTransaction(paths(d),build,{checkpoint:stage=>{
      if(stage===phase){fs.unlinkSync(path.join(d,name));fs.writeFileSync(path.join(d,name),JSON.stringify(replacement));}
    }}),/HISTORY_LOCK_OWNERSHIP_CHANGED/);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(d,name))),replacement);
    if(['locked','prepared'].includes(phase))assert.equal(fs.existsSync(paths(d).stateOutput),false);
    if(phase==='state-published')assert.equal(fs.existsSync(paths(d).summaryOutput),false);
  }finally{fs.rmSync(d,{recursive:true,force:true});}
});
test('directory identity swap is detected before publish and retains original lock for review',async()=>{
  const d=temp(),original=path.join(d,'active'),moved=path.join(d,'moved');fs.mkdirSync(original);
  try{
    await assert.rejects(withHistoryTransaction(paths(original),build,{checkpoint:phase=>{
      if(phase==='prepared'){fs.renameSync(original,moved);fs.mkdirSync(original);}
    }}),/HISTORY_DIRECTORY_CHANGED/);
    assert.equal(fs.existsSync(path.join(moved,'state.json.lock')),true);
    assert.equal(fs.existsSync(paths(original).stateOutput),false);
  }finally{fs.rmSync(d,{recursive:true,force:true});}
});
test('backup gate refuses mismatched bound pair before interpreting freshness',async()=>{
  const d=temp();try{
    const first=await withHistoryTransaction(paths(d),()=>({state:{schema_version:23,rooms:{},last_processed_run:'synthetic',last_checked_at:'2026-11-18T00:00:00.000Z'},summary:{source_evidence_accepted:true}}));
    const now=new Date('2026-11-18T00:01:00.000Z');
    assert.equal(decideJdBackup({now,priorState:first.state,priorSummary:first.summary}).should_run,false);
    assert.throws(()=>decideJdBackup({now,priorState:first.state,priorSummary:{source_evidence_accepted:true}}),/HISTORY_PAIR_MISMATCH/);
  }finally{fs.rmSync(d,{recursive:true,force:true});}
});
