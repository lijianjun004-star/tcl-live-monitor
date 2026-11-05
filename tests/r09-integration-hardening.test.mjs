import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {normalizePlatform,normalizeOpsCatalog,normalizeJdReport,assembleRegistry,targetsToTagged} from '../probes/lib/ops-room-registry.mjs';
import {auditThreePlatformCoverage} from '../probes/lib/coverage-audit.mjs';
import {mergeLiveObservations} from '../probes/lib/merge-live-observations.mjs';
import {classifyTmall,pickBest} from '../probes/lib/tmall.mjs';
import {decideDouyin} from '../probes/lib/douyin.mjs';
const cfg=JSON.parse(fs.readFileSync(new URL('../config/probe-targets.json',import.meta.url)));
const at=Date.parse('2026-11-05T12:00:00Z');
const registry=()=>assembleRegistry({opsCatalog:normalizeOpsCatalog({total:1,rooms:[{id:16,platform:'jd',shop_id:17}]},{total:1,shops:[{id:17,platform:'jd'}]}),configuredTargets:targetsToTagged(cfg)});
const row=(r,k)=>r.rows.find(x=>x.key===k);
for(const platform of ['__proto__','constructor','toString'])test('reject inherited platform '+platform,()=>assert.equal(normalizePlatform(platform),null));
for(const metadata of [{data:{hasMore:true}},{data:{pagination:{has_more:true}}},{pagination:{next:2}},{meta:{page:2}}])test('nested continuation cannot declare complete '+JSON.stringify(metadata),()=>{
 const body={rooms:[{id:1,platform:'jd'}],total:1,...metadata};assert.equal(normalizeOpsCatalog(body).completeness.rooms,'INCOMPLETE_PAGINATED');
});
test('conflicting totals cannot declare complete',()=>assert.equal(normalizeOpsCatalog({rooms:[],total:0,data:{total:3}}).completeness.rooms,'INCOMPLETE_TOTAL_MISMATCH'));
test('unsafe numeric internal IDs are rejected',()=>assert.equal(normalizeOpsCatalog({total:1,rooms:[{id:9007199254740992,platform:'jd'}]}).rooms.length,0));
test('leading zeros cannot manufacture another internal room',()=>{
 const c=normalizeOpsCatalog({total:2,rooms:[{id:'016',platform:'jd'},{id:16,platform:'jd'}]});assert.equal(c.rooms.length,1);assert.equal(c.completeness.rooms,'UNPROVEN_INVALID_OR_DUPLICATE_ROWS');
});
test('JD report cannot attest completeness of a shop catalog it does not contain',()=>{
 const c=normalizeJdReport({schemaVersion:2,source:'TCL_OPS_READ_ONLY',checkedAt:new Date(at).toISOString(),rooms:[],monitoringCoverage:{shopCatalogComplete:true}});assert.notEqual(c.completeness.shops,'DECLARED_COMPLETE');
});
test('audit rejects substituted public identity even when record count matches',()=>{
 const r=registry();r.entries.find(x=>x.source==='public-probe-existing').platformAccountId='other';assert.throws(()=>auditThreePlatformCoverage({registry:r,publicConfig:cfg}),/REGISTERED_PUBLIC_TARGET_IDENTITY_MISMATCH/);
});
test('missing internal shop ID is an unverified relationship',()=>{
 const r=registry();r.entries.find(x=>x.source==='ops-platform').shopLink='NOT_VERIFIED';assert.ok(auditThreePlatformCoverage({registry:r,publicConfig:cfg}).issues.some(x=>x.code==='UNVERIFIED_INTERNAL_ROOM_SHOP_LINKS'));
});
test('duplicate registry rows cannot double count projected status',()=>{
 const r=registry();r.entries.push({...r.entries[0]});assert.throws(()=>mergeLiveObservations(r,{now:at}),/REGISTRY_IDENTITY_CONFLICT/);
});
test('future-dated observation must not hide a latest UNKNOWN',()=>{
 const key=cfg.douyin[0].key,report={schemaVersion:1,observations:[{platform:'douyin',accountId:key,at,state:'UNKNOWN'},{platform:'douyin',accountId:key,at:at+30000,state:'LIVE',profileIdentityVerified:true,roomPageIdentityVerified:true,observedRoomId:'123456',checkedRoomId:'123456'}]};
 assert.equal(row(mergeLiveObservations(registry(),{now:at,publicReport:report}),'public:douyin:'+key).currentStatus,'UNKNOWN');
});
test('public LIVE label alone has no identity corroboration',()=>{
 const report={schemaVersion:1,observations:[{platform:'douyin',accountId:cfg.douyin[0].key,at,state:'LIVE'}]};assert.equal(mergeLiveObservations(registry(),{now:at,publicReport:report}).byPlatform.douyin.LIVE,0);
});
test('public OFFLINE promotion uses the producer report calibration flag',()=>{
 const report={schemaVersion:1,douyinOfflineRuleValidated:true,observations:[{platform:'douyin',accountId:cfg.douyin[0].key,at,state:'OFFLINE',profileIdentityVerified:true,roomPageIdentityVerified:true,offlineEvidence:true}]};
 assert.equal(row(mergeLiveObservations(registry(),{now:at,publicReport:report}),'public:douyin:'+cfg.douyin[0].key).currentStatus,'OFFLINE');
});
test('JD LIVE requires live agent evidence',()=>{
 const report={schemaVersion:2,source:'TCL_OPS_READ_ONLY',checkedAt:new Date(at).toISOString(),rooms:[{roomId:'16',status:'LIVE',captureBound:true,agentAlive:false}]};assert.equal(mergeLiveObservations(registry(),{now:at,jdReport:report}).byPlatform.jd.LIVE,0);
});
test('null Tmall status fields cannot manufacture OFFLINE',()=>{
 const t=cfg.tmall[0],payload={ret:['SUCCESS'],data:{roomNum:t.roomNumber,roomStatus:null,streamStatus:null,liveId:'0',broadCaster:{accountId:t.accountId,accountName:t.displayName,roomNum:t.roomNumber}}};assert.equal(classifyTmall(payload,t).state,'UNKNOWN');
});
test('contradictory Tmall response samples cannot select first LIVE',()=>assert.equal(pickBest([{state:'LIVE'},{state:'OFFLINE',offlineEvidence:true}]).state,'UNKNOWN'));
test('Douyin offline needs a matching room identity even after calibration',()=>{
 const t=cfg.douyin[0],profile={httpStatus:200,title:t.accountName+'的抖音 - 抖音',bodyExcerpt:'抖音号：'+t.displayDouyinId},room={httpStatus:200,title:'another account',bodyExcerpt:'直播已结束',statusFields:[{field:'$.data.status',value:4}]};assert.equal(decideDouyin(profile,room,t,{offlineRuleValidated:true}).state,'UNKNOWN');
});
test('UNKNOWN after LIVE does not fall back to older evidence; recovery can restore LIVE',()=>{
 const key=cfg.douyin[0].key,report={schemaVersion:1,observations:[{platform:'douyin',accountId:key,at:at-1000,state:'LIVE',profileIdentityVerified:true,roomPageIdentityVerified:true,observedRoomId:'123456',checkedRoomId:'123456'},{platform:'douyin',accountId:key,at,state:'UNKNOWN',reason:'PROBE_ERROR'}]};
 assert.equal(row(mergeLiveObservations(registry(),{now:at,publicReport:report}),'public:douyin:'+key).currentStatus,'UNKNOWN');
 report.observations.push({...report.observations[0],at:at+1000});assert.equal(row(mergeLiveObservations(registry(),{now:at+1000,publicReport:report}),'public:douyin:'+key).currentStatus,'LIVE');
});

test('fresh authorized source catalog reconciles 16 rooms / 17 shops; historical placeholders are replaced',()=>{
 const f=JSON.parse(fs.readFileSync(new URL('../fixtures/ops-catalog-safe-20261105.json',import.meta.url)));
 const history=JSON.parse(fs.readFileSync(new URL('../fixtures/ops-douyin-history-unmapped.json',import.meta.url)));
 const r=assembleRegistry({opsCatalog:normalizeOpsCatalog(f.roomsResponse,f.shopsResponse),configuredTargets:targetsToTagged(cfg),unmappedOpsRoomRows:history});
 const a=auditThreePlatformCoverage({registry:r,publicConfig:cfg});
 assert.equal(r.numbers.opsRooms,16);assert.equal(r.numbers.opsUnmappedHistory,0);assert.equal(a.totalEvidenceRows,29);
 assert.deepEqual(a.sourceShopCounts,{jd:6,tmall:1,douyin:10});
 assert.equal(a.unmappedSourceIdentities.length,16);assert.equal(a.sourceShopsWithoutRoomMapping.length,1);
 assert.equal(a.sourceShopsWithoutRoomMapping[0].platform,'tmall');assert.equal(a.globalShopCatalogComplete,false);
 assert.equal(a.jd.roomList.find(x=>x.opsRoomId==='1').categoryMappingConflict,true);
 assert.ok(mergeLiveObservations(r).rows.every(x=>x.currentStatus==='UNKNOWN'&&x.formalScoringEnabled===false));
});
test('source-shaped fixture contains no raw keys, anchor names, notes or GMV',()=>{
 const f=JSON.parse(fs.readFileSync(new URL('../fixtures/ops-catalog-safe-20261105.json',import.meta.url)));
 assert.ok(f.roomsResponse.rooms.every(x=>Object.keys(x).every(k=>['id','platform','shop_id','category'].includes(k))));
 assert.ok(f.shopsResponse.every(x=>Object.keys(x).every(k=>['id','platform','category'].includes(k))));
});
