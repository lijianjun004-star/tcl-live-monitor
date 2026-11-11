import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const cwd=fileURLToPath(new URL('..',import.meta.url));
const run=(args)=>spawnSync(process.execPath,args,{cwd,encoding:'utf8',timeout:10000});
const tmp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'tcl-r09-'));

test('end-to-end main probe targets + historical JD: 29 evidence rows, UNKNOWN not LIVE',t=>{
 const dir=tmp();t.after(()=>fs.rmSync(dir,{force:true,recursive:true}));
 const registry=path.join(dir,'registry.json'),view=path.join(dir,'view.json'),audit=path.join(dir,'audit.json');
 let r=run(['probes/import-ops-room-registry.mjs','--jd-report','fixtures/jd-all-safe-report-20261105.json',
  '--targets','config/probe-targets.json','--unmapped','fixtures/ops-douyin-history-unmapped.json','--out',registry]);
 assert.equal(r.status,0,r.stderr);
 r=run(['probes/build-three-platform-view.mjs','--registry',registry,'--jd-report','fixtures/jd-all-safe-report-20261105.json','--out',view]);
 assert.equal(r.status,0,r.stderr);
 r=run(['probes/audit-three-platform-coverage.mjs','--registry',registry,'--jd-report','fixtures/jd-all-safe-report-20261105.json','--out',audit]);
 assert.equal(r.status,0,r.stderr);
 const a=JSON.parse(fs.readFileSync(audit));const v=JSON.parse(fs.readFileSync(view));
 assert.equal(a.totalEvidenceRows,37);assert.equal(a.approvedDouyinScoringAccounts,4);
 assert.equal(a.globalMonitoringCoverageVerified,false);
 assert.deepEqual(v.byPlatform,{jd:{LIVE:0,OFFLINE:0,UNKNOWN:6},tmall:{LIVE:0,OFFLINE:0,UNKNOWN:9},douyin:{LIVE:0,OFFLINE:0,UNKNOWN:12}});
 for(const p of [registry,view,audit])assert.equal(fs.statSync(p).mode&0o777,0o600,p);
 assert.ok(!fs.readFileSync(registry,'utf8').includes('bound_session_key'));
});

test('input CLI refuses to silently choose between full rooms export and JD report',t=>{
 const dir=tmp();t.after(()=>fs.rmSync(dir,{force:true,recursive:true}));
 const file=path.join(dir,'rooms.json');fs.writeFileSync(file,'{"rooms":[],"total":0}');
 const r=run(['probes/import-ops-room-registry.mjs','--rooms',file,'--jd-report','fixtures/jd-all-safe-report-20261105.json',
  '--targets','config/probe-targets.json','--out',path.join(dir,'target.json')]);
 assert.notEqual(r.status,0);assert.equal(fs.existsSync(path.join(dir,'target.json')),false);
});

test('raw read-only room+shop source JSON joins by exact platform+internal shop ID; never promotes',t=>{
 const dir=tmp();t.after(()=>fs.rmSync(dir,{force:true,recursive:true}));
 const rooms=path.join(dir,'rooms.json'),shops=path.join(dir,'shops.json'),out=path.join(dir,'safe.json');
 fs.writeFileSync(rooms,JSON.stringify({total:2,rooms:[
  {id:16,platform:'jd',shop_id:17,name:'PRIVATE_ANCHOR',bound_session_key:'SECRET-PRIVATE'},
  {id:16,platform:'tmall',shop_id:17,name:'PRIVATE_ANCHOR2'}
 ]}));
 fs.writeFileSync(shops,JSON.stringify({total:2,shops:[
  {id:17,platform:'jd',name:'TCL JD Store',anchor_name:'PRIVATE_ANCHOR'},
  {id:17,platform:'tmall',name:'TCL Tmall Store'}
 ]}));
 const r=run(['probes/import-ops-room-registry.mjs','--rooms',rooms,'--shops',shops,
  '--targets','config/probe-targets.json','--out',out]);
 assert.equal(r.status,0,r.stderr);
 const res=JSON.parse(fs.readFileSync(out));
 assert.equal(res.roomCompleteness.rooms,'DECLARED_COMPLETE');
 assert.equal(res.roomCompleteness.shops,'DECLARED_COMPLETE');
 const j=res.entries.find(x=>x.key==='ops:jd:16'),ta=res.entries.find(x=>x.key==='ops:tmall:16');
 assert.equal(j.shopName,'TCL JD Store');assert.equal(ta.shopName,'TCL Tmall Store');
 assert.equal(j.autoAddedToPublicProbe,false);assert.equal(j.currentStatus,'UNKNOWN');
 assert.ok(!JSON.stringify(res).includes('PRIVATE_ANCHOR'));
 assert.ok(!JSON.stringify(res).includes('SECRET-PRIVATE'));
});

test('preview generator escapes malicious closing script tags and does not execute input',t=>{
 const dir=tmp();t.after(()=>fs.rmSync(dir,{force:true,recursive:true}));
 const inp=path.join(dir,'view.json'),out=path.join(dir,'preview.html');
 fs.writeFileSync(inp,JSON.stringify({schemaVersion:1,rows:[{platform:'jd',source:'ops-platform',roomName:'</script><script>alert(1)</script>',currentStatus:'UNKNOWN'}]}));
 const r=run(['probes/render-offline-preview.mjs','--view',inp,'--out',out]);
 assert.equal(r.status,0,r.stderr);
 const html=fs.readFileSync(out,'utf8');
 assert.ok(html.includes('\\u003c/script\\u003e'));
 assert.equal(html.split('</script><script>').length,2); // only the template's intended script boundary
 assert.ok(!html.includes('"roomName":"</script>'));
});
