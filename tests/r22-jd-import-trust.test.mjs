import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {acceptJdOpsScan} from '../probes/r21/accept-jd-ops-scan.mjs';

const html=fs.readFileSync(new URL('../preview/jd/index.html',import.meta.url),'utf8');
const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
const fn=script.match(/function isAccepted\(x\)\{[\s\S]*?\n\}/);
assert.ok(fn,'validator missing');
const accept=vm.runInNewContext(fn[0]+'\n isAccepted');
const sample=()=>({
 schema_version:21,platform:'jd',source:'TCL_OPS_READ_ONLY',readiness:'OBSERVED',
 checked_at:'2026-11-10T12:23:50.475Z',room_count:1,live:1,unknown:0,offline:0,
 warnings:[],catalog_complete_attested:true,formal_opening_rate_percent:null,
 formal_attendance_ready:false,fully_verified_public_accounts:false,fully_verified_schedule:false,
 rooms:[{room_id:'777',shop_id:'21',category:'电视',state:'LIVE',
 reason:'FRESH_MINUTE_DATA_STATUS_1',agent_alive:true,offline_candidate:false,minute_age_min:1.2}]
});
test('QA-01: a forged room 777 with valid-looking fields cannot be displayed as verified LIVE',()=>{
 assert.equal(accept(sample()),true,'syntax matching cannot attest source');
 assert.match(script,/importedUnverified=true;render\(\)/);
 assert.match(script,/未经来源签名验证/);
 assert.match(script,/文件声称/);
 assert.match(script,/el\("live"\)\.textContent=isBlocked\|\|importedUnverified\?"—"/);
 assert.match(script,/importedUnverified\?"UNVERIFIED_LOCAL_FILE"/);
});
test('QA-01: unverifiable source and mismatched platform are rejected',()=>{
 let x=sample();delete x.source;assert.equal(accept(x),false);
 x=sample();x.platform='douyin';assert.equal(accept(x),false);
 x=sample();x.formal_attendance_ready=true;assert.equal(accept(x),false);
});
test('QA-01: fake summary or duplicate IDs rejected',()=>{
 let x=sample();x.room_count=2;assert.equal(accept(x),false);
 x=sample();x.live=0;assert.equal(accept(x),false);
 x=sample();x.rooms.push({...x.rooms[0]});x.room_count=2;x.live=2;assert.equal(accept(x),false);
});
test('QA-02: incomplete source may not claim OBSERVED in imported data',()=>{
 let x=sample();x.catalog_complete_attested=false;assert.equal(accept(x),false);
 x=sample();x.warnings=['ROOM_CATALOG_INCOMPLETE_SOURCE'];assert.equal(accept(x),false);
});
test('QA-01: UI rejects missing current LIVE evidence, explicit OFFLINE and invalid date',()=>{
 let x=sample();x.rooms[0].state='OFFLINE';assert.equal(accept(x),false);
 x=sample();x.rooms[0].minute_age_min=5;assert.equal(accept(x),false);
 x=sample();x.rooms[0].agent_alive=false;assert.equal(accept(x),false);
 x=sample();x.checked_at='2026-02-30T12:23:50.475Z';assert.equal(accept(x),false);
});
test('QA-01: BLOCKED cannot carry an apparently live room',()=>{
 let x=sample();x.readiness='BLOCKED';assert.equal(accept(x),false);
 x.rooms=[];x.room_count=0;x.live=0;x.unknown=0;
 assert.equal(accept(x),true);
});
test('QA-01: CSV current-state must always be UNKNOWN for unsigned imports',()=>{
 assert.match(script,/\(!importedUnverified&&fresh\(data\)\)\?r\.state:"UNKNOWN"/);
 assert.match(script,/UNVERIFIED_LOCAL_FILE/);
});
test('QA-04: expired LIVE gets neutral styling and explicit historical caption',()=>{
 assert.match(script,/历史 "\+r\.state\+" · 非当前/);
 assert.match(script,/r\.state==="LIVE"&&!importedUnverified&&isFresh\?"live":"unknown"/);
});
test('QA-03: failed source or validation must fail job AFTER preserving sanitized artifact',()=>{
 const f=fs.readFileSync(new URL('../.github/workflows/r21-jd-real-source-one-shot.yml',import.meta.url),'utf8');
 const up=f.indexOf('name: Upload only sanitized state reports');
 const gate=f.indexOf('name: Fail closed after retaining diagnostics');
 assert.ok(up>0&&gate>up);
 assert.match(f,/exit 1/);
 assert.match(f,/steps\.source\.outcome/);
 assert.match(f,/steps\.validate\.outcome/);
});
test('QA-02: explicit upstream incomplete catalog returns PARTIAL and unattested',()=>{
 const room=(i)=>({roomId:String(i),shopId:String(i),category:'电视',status:'LIVE',
  reason:'FRESH_MINUTE_DATA_STATUS_1',agentAlive:true,offlineCandidate:false,latestMinuteAgeMin:1.2});
 const input={schemaVersion:2,source:'TCL_OPS_READ_ONLY',checkedAt:'2026-11-10T12:23:49.000Z',
 date:'2026-11-10',catalogStatus:'RECEIVED',roomListScope:'API_DECLARED_COMPLETE',
 monitoringCoverage:{roomCatalogComplete:false},
 shard:{index:0,total:1},summaryScope:'ALL_SOURCE_ROOMS',
 warnings:[],discoveredRoomCount:1,summary:{LIVE:1,OFFLINE:0,UNKNOWN:0},rooms:[room(1)]};
 const result=acceptJdOpsScan(input,{now:'2026-11-10T12:23:55.000Z'});
 assert.equal(result.readiness,'PARTIAL');
 assert.equal(result.catalog_complete_attested,false);
 assert.ok(result.warnings.includes('ROOM_CATALOG_INCOMPLETE_SOURCE'));
 assert.equal(result.formal_opening_rate_percent,null);
});
