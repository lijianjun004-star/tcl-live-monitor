import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {normalizeOpsCatalog,publicTargetsFromConfig,assembleRegistry,normalizeJdReport,targetsToTagged} from '../probes/lib/ops-room-registry.mjs';
import {mergeLiveObservations} from '../probes/lib/merge-live-observations.mjs';
import {auditThreePlatformCoverage} from '../probes/lib/coverage-audit.mjs';
const cfg=JSON.parse(readFileSync(new URL('../config/probe-targets.json',import.meta.url)));
const jd=JSON.parse(readFileSync(new URL('../fixtures/jd-all-safe-report-20261105.json',import.meta.url)));
const internal=JSON.parse(readFileSync(new URL('../fixtures/ops-douyin-history-unmapped.json',import.meta.url)));
const clock=Date.parse(jd.checkedAt)+60_000;
const registry=assembleRegistry({opsCatalog:normalizeJdReport(jd),configuredTargets:targetsToTagged(cfg),unmappedOpsRoomRows:internal,asOf:jd.checkedAt});
const jdOne=(rest={})=>({schemaVersion:2,source:'TCL_OPS_READ_ONLY',checkedAt:jd.checkedAt,rooms:[{roomId:'16',captureBound:true,agentAlive:true,status:'LIVE',...rest}]});
const row=(r,key)=>r.rows.find(x=>x.key===key);

test('main config has 12 separate Douyin secUids and 1 Tmall, scored only 4 as approved',()=>{
 const targets=publicTargetsFromConfig(cfg);
 assert.equal(targets.length,13);
 assert.equal(targets.filter(x=>x.platform==='douyin').length,12);
 assert.equal(new Set(targets.filter(x=>x.platform==='douyin').map(x=>x.publicProfileSecUid)).size,12);
 assert.equal(targets.filter(x=>x.platform==='douyin'&&x.scoringEligible).length,4);
});
test('same Douyin secUid under different display IDs is rejected, even with different roomId',()=>{
 const t=structuredClone(cfg), old=t.douyin[0];
 t.douyin.push({...old,key:'new-alias',displayDouyinId:'newAlias22',roomId:'564839201'});
 assert.throws(()=>publicTargetsFromConfig(t),/DUPLICATE_DOUYIN_SECUID/);
});
test('Tmall separate key with same account ID is not a new independent store',()=>{
 const t=structuredClone(cfg);
 t.tmall.push({...t.tmall[0],key:'alias-2'});
 assert.throws(()=>publicTargetsFromConfig(t),/DUPLICATE_TMALL_ACCOUNT/);
});
test('internal shop17 -> JD room16; never a public JD session 17',()=>{
 const r=registry.entries.find(x=>x.platform==='jd'&&x.opsRoomId==='16');
 assert.equal(r.opsShopId,'17');assert.equal(r.verifiedExternalIdentity,false);
 assert.equal(r.scoringEligible,false);assert.equal(r.platformRoomId,undefined);
});
test('complete page with page index 2 must not claim full catalog',()=>{
 const o=normalizeOpsCatalog({page:2,total:1,rooms:[{id:1,platform:'jd'}]});
 assert.equal(o.completeness.rooms,'INCOMPLETE_PAGINATED');
});
test('duplicate internal room IDs invalidate census, preserve room but revoke ambiguous shop association',()=>{
 const o=normalizeOpsCatalog({total:2,rooms:[{id:16,platform:'jd',shop_id:17},{id:16,platform:'jd',shop_id:18}]});
 assert.equal(o.rooms.length,1);
 assert.equal(o.rooms[0].opsShopId,null);
 assert.equal(o.rooms[0].shopLink,'DUPLICATE_ROOM_ID_UNVERIFIED');
 assert.equal(o.completeness.rooms,'UNPROVEN_INVALID_OR_DUPLICATE_ROWS');
});
test('invalid room ID reduces claimed completeness despite API total matching row count',()=>{
 const o=normalizeOpsCatalog({total:2,rooms:[{id:1,platform:'jd'},{id:'../etc',platform:'jd'}]});
 assert.equal(o.rooms.length,1);
 assert.equal(o.completeness.rooms,'UNPROVEN_INVALID_OR_DUPLICATE_ROWS');
});
test('duplicate shop ID removes room->shop name join even if first occurrence has a name',()=>{
 const o=normalizeOpsCatalog({total:1,rooms:[{id:16,platform:'jd',shop_id:17}]},
 {total:2,shops:[{id:17,platform:'jd',name:'A'},{id:17,platform:'jd',name:'B'}]});
 assert.equal(o.rooms[0].shopLink,'AMBIGUOUS_DUPLICATE_SHOP');
 assert.equal(o.rooms[0].shopName,'');
 assert.equal(o.shops[0].shopName,'');
 assert.equal(o.completeness.shops,'UNPROVEN_INVALID_OR_DUPLICATE_ROWS');
});
test('invalid shop row also prevents full-store claims',()=>{
 const o=normalizeOpsCatalog({rooms:[]}, {total:1,shops:[{id:17,platform:'unknown',name:'NotJD'}]});
 assert.equal(o.completeness.shops,'UNPROVEN_INVALID_OR_DUPLICATE_ROWS');
});
test('identical numeric shop IDs across JD/Tmall must not cross-associate',()=>{
 const o=normalizeOpsCatalog({total:2,rooms:[{id:1,platform:'jd',shop_id:2},{id:1,platform:'tmall',shop_id:2}]},
  {total:2,shops:[{id:2,platform:'jd',name:'J'},{id:2,platform:'tmall',name:'T'}]});
 assert.equal(o.rooms.find(x=>x.platform==='jd').shopName,'J');
 assert.equal(o.rooms.find(x=>x.platform==='tmall').shopName,'T');
});
test('internal room display name never copies anchor name, capture key or personal notes',()=>{
 const s='PRIVATE_ANCHOR_NAME_AND_PHONE_13712345678';
 const o=normalizeOpsCatalog({total:1,rooms:[{id:1,platform:'jd',name:s,anchor_name:s,bound_session_key:'secret-cookie'}]});
 for(const secret of [s,'secret-cookie','bound_session_key'])assert.ok(!JSON.stringify(o).includes(secret));
});
test('JD artifact internally duplicated room invalidates claimed complete list',()=>{
 const fake=structuredClone(jd);fake.rooms.push({...jd.rooms[0]});fake.monitoringCoverage.roomCatalogComplete=true;
 const out=normalizeJdReport(fake);
 assert.equal(out.completeness.rooms,'UNPROVEN_INVALID_OR_DUPLICATE_ROWS');
});
test('fresh duplicate JD observations cannot report LIVE even if both say LIVE',()=>{
 const report=jdOne();report.rooms.push({...report.rooms[0]});
 const r=mergeLiveObservations(registry,{jdReport:report,now:clock});
 assert.equal(row(r,'ops:jd:16').currentStatus,'UNKNOWN');
 assert.equal(row(r,'ops:jd:16').currentReason,'JD_DUPLICATE_OBSERVATIONS');
});
test('untrusted JD report without schemaVersion cannot manufacture LIVE',()=>{
 const report=jdOne();delete report.schemaVersion;
 const r=mergeLiveObservations(registry,{jdReport:report,now:clock});
 assert.equal(row(r,'ops:jd:16').currentStatus,'UNKNOWN');
});
test('JD old snapshot expires even when status says LIVE',()=>{
 const r=mergeLiveObservations(registry,{jdReport:jd,now:clock+30*60_000});
 assert.equal(r.byPlatform.jd.LIVE,0);
 assert.equal(r.byPlatform.jd.UNKNOWN,6);
});
test('main public probe report format: LIVE joins on configured stable key, not public display ID',()=>{
 const report={schemaVersion:1,observations:[{platform:'douyin',accountId:cfg.douyin[0].key,at:clock,state:'LIVE',profileIdentityVerified:true,roomPageIdentityVerified:true,observedRoomId:'123456',checkedRoomId:'123456'},{platform:'tmall',accountId:cfg.tmall[0].accountId,at:clock,state:'LIVE',profileIdentityVerified:true,roomPageIdentityVerified:true,observedRoomId:'123456',checkedRoomId:'123456'}]};
 const out=mergeLiveObservations(registry,{publicReport:report,now:clock});
 assert.equal(row(out,`public:douyin:${cfg.douyin[0].key}`).currentStatus,'LIVE');
 assert.equal(out.byPlatform.tmall.LIVE,0); // Tmall uses config `key`, not `accountId`
});
test('same timestamp PUBLIC OFFLINE must have uniformly validated evidence; one unverified -> UNKNOWN',()=>{
 const key=cfg.douyin[0].key;
 const report={schemaVersion:1,observations:[{platform:'douyin',accountId:key,at:clock,state:'OFFLINE',offlineEvidence:true,offlineRuleValidated:true},
  {platform:'douyin',accountId:key,at:clock,state:'OFFLINE',offlineEvidence:false,offlineRuleValidated:false}]};
 const out=mergeLiveObservations(registry,{publicReport:report,now:clock});
 assert.equal(row(out,`public:douyin:${key}`).currentStatus,'UNKNOWN');
});
test('wrong-schema public report cannot alter status',()=>{
 const report={schemaVersion:999,observations:[{platform:'douyin',accountId:cfg.douyin[0].key,at:clock,state:'LIVE',profileIdentityVerified:true,roomPageIdentityVerified:true,observedRoomId:'123456',checkedRoomId:'123456'}]};
 const out=mergeLiveObservations(registry,{publicReport:report,now:clock});
 assert.equal(out.byPlatform.douyin.LIVE,0);
});
test('full historical coverage ledger counts sources but never sums to unique physical room total',()=>{
 const audit=auditThreePlatformCoverage({registry,publicConfig:cfg,jdReport:jd,asOf:jd.checkedAt});
 assert.deepEqual(audit.counts,{jd:{opsRecords:6,publicAccounts:0,unmappedOpsHistory:0},tmall:{opsRecords:0,publicAccounts:1,unmappedOpsHistory:0},douyin:{opsRecords:0,publicAccounts:12,unmappedOpsHistory:10}});
 assert.equal(audit.totalEvidenceRows,29);
 assert.equal(audit.totalConfiguredPublicAccounts,13);
 assert.equal(audit.approvedDouyinScoringAccounts,4);
 assert.equal(audit.verifiedPhysicalRoomCount,null);
 assert.equal(audit.globalMonitoringCoverageVerified,false);
 assert.equal(audit.globalShopCatalogComplete,false);
 assert.ok(audit.issues.some(x=>x.code==='OPS_DOUYIN_HISTORY_NOT_BOUND_TO_PUBLIC_IDENTITIES'));
});
test('audit JD joins are internal only and preserving category conflict',()=>{
 const audit=auditThreePlatformCoverage({registry,publicConfig:cfg,jdReport:jd,asOf:jd.checkedAt});
 const room16=audit.jd.roomList.find(x=>x.opsRoomId==='16');
 assert.equal(room16.opsInternalShopId,'17');
 assert.equal(room16.knownPublicJdShopId,null);
 assert.equal(room16.knownJdLiveSessionId,null);
 assert.equal(audit.jd.roomList.find(x=>x.opsRoomId==='1').categoryMappingConflict,true);
 assert.ok(audit.jd.roomList.every(x=>x.scoringEligible===false));
});
test('audit rejects a duplicated register key rather than claiming new coverage',()=>{
 const r=structuredClone(registry);r.entries.push({...r.entries[0]});
 assert.throws(()=>auditThreePlatformCoverage({registry:r,publicConfig:cfg}),/REGISTRY_IDENTITY_CONFLICT/);
});
test('audit detects mismatch between registry and public probe config',()=>{
 const r=structuredClone(registry);r.entries.splice(r.entries.findIndex(x=>x.source==='public-probe-existing'),1);
 assert.throws(()=>auditThreePlatformCoverage({registry:r,publicConfig:cfg}),/REGISTERED_PUBLIC_TARGET_COUNT_MISMATCH/);
});
test('strictly read-only: historic unmatched ops Douyin are not promoted to score eligibility',()=>{
 const audit=auditThreePlatformCoverage({registry,publicConfig:cfg});
 assert.equal(audit.unmappedOpsHistory.length,10);
 assert.ok(audit.unmappedOpsHistory.every(x=>x.externalIdentity===null&&x.scoringEligible===false));
 assert.equal(audit.noNewScoringEnrollment,true);
});

test('verified source shop catalog spans all three platforms but never becomes public store ID',()=>{
 const shops=[{platform:'jd',shopId:'17',shopName:'JD'}, {platform:'tmall',shopId:'8',shopName:'Tmall'}, {platform:'douyin',shopId:'9',shopName:'Dy'}];
 const r=structuredClone(registry);r.shops=shops;
 const audit=auditThreePlatformCoverage({registry:r,publicConfig:cfg});
 assert.deepEqual(audit.sourceShopCounts,{jd:1,tmall:1,douyin:1});
 assert.equal(audit.sourceShopList.length,3);
 assert.ok(audit.sourceShopList.every(s=>s.externalStoreVerified===false&&s.externalStoreId===null));
 assert.equal(audit.globalMonitoringCoverageVerified,false);
});
