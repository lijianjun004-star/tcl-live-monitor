import {publicTargetsFromConfig} from './ops-room-registry.mjs';
/** Evidence-based census audit. Safe: works on sanitized source data only; no network writes. */
const PLATFORMS=['jd','tmall','douyin'];
const cleanCode = v=>typeof v==='string'&&/^[A-Z][A-Z0-9_:-]{0,70}$/.test(v)?v:'UNKNOWN_WARNING';

/**
 * Must not add independent accounts across ops internal IDs and public IDs without approved crosswalk.
 * Output represents evidence records, not global physical-room total.
 */
export function auditThreePlatformCoverage({registry,publicConfig,jdReport=null,sourceCatalog=null,asOf=new Date().toISOString()}={}){
 if(registry?.schemaVersion!==1||!Array.isArray(registry.entries))throw Error('REGISTRY_INVALID');
 if(publicConfig?.schemaVersion!==1||!Array.isArray(publicConfig.douyin)||!Array.isArray(publicConfig.tmall))throw Error('TARGET_CONFIG_INVALID');
 if(!Number.isFinite(Date.parse(asOf)))throw Error('AUDIT_TIME_INVALID');
 const sourceRows=registry.entries.filter(x=>x.source==='ops-platform');
 const existing=registry.entries.filter(x=>x.source==='public-probe-existing');
 const unknown=registry.entries.filter(x=>x.source==='ops-history-unmapped');
 const counts={jd:{opsRecords:0,publicAccounts:0,unmappedOpsHistory:0},tmall:{opsRecords:0,publicAccounts:0,unmappedOpsHistory:0},douyin:{opsRecords:0,publicAccounts:0,unmappedOpsHistory:0}};
 const seen=new Set(),seenOpsRoomIds=new Set();
 for(const r of registry.entries){
  if(!PLATFORMS.includes(r.platform)||typeof r.key!=='string'||seen.has(r.key))throw Error('REGISTRY_IDENTITY_CONFLICT');
  seen.add(r.key);
  if(r.opsRoomId!==undefined&&r.opsRoomId!==null&&r.opsRoomId!==''){
   const rk=`${r.platform}:${r.opsRoomId}`;
   if(seenOpsRoomIds.has(rk))throw Error('REGISTRY_IDENTITY_CONFLICT');
   seenOpsRoomIds.add(rk);
  }
  if(r.source==='ops-platform')counts[r.platform].opsRecords++;
  else if(r.source==='public-probe-existing')counts[r.platform].publicAccounts++;
  else if(r.source==='ops-history-unmapped')counts[r.platform].unmappedOpsHistory++;
  else throw Error('REGISTRY_SOURCE_UNRECOGNIZED');
 }
 // JD historical room inventory is authoritative only for the rooms observed at that sample, not global coverage.
 const jdRoomList=sourceRows.filter(x=>x.platform==='jd').map(x=>({
  opsRoomId:String(x.opsRoomId??''),opsInternalShopId:x.opsShopId??null,category:x.category??'',
  sourceRoomShopLink:x.shopLink??'NOT_VERIFIED',categoryMappingConflict:x.categoryMappingConflict===true,
  knownPublicJdShopId:null,knownJdLiveSessionId:null,scoringEligible:false,
 })).sort((a,b)=>Number(a.opsRoomId)-Number(b.opsRoomId));
 const allShops=sourceCatalog?.shops??registry.shops??[];
 const shopCounts={jd:0,tmall:0,douyin:0};
 const sourceShops=[],seenShopIds=new Set();
 for(const shop of allShops){
  if(!PLATFORMS.includes(shop.platform))continue;
  const sk=`${shop.platform}:${shop.shopId}`;
  if(seenShopIds.has(sk))throw Error('SHOP_IDENTITY_CONFLICT');
  seenShopIds.add(sk);
  shopCounts[shop.platform]++;
  sourceShops.push({platform:shop.platform,opsInternalShopId:shop.shopId,shopName:shop.shopName||'',
    linkedOpsRoomIds:sourceRows.filter(x=>x.platform===shop.platform&&x.opsShopId===shop.shopId).map(x=>x.opsRoomId),
    externalStoreId:null,externalStoreVerified:false,source:'OPS_INTERNAL_SHOP_ONLY'});
 }
 const jdShops=allShops.filter(x=>x.platform==='jd').map(x=>({
  opsInternalShopId:x.shopId,shopName:x.shopName||'',linkedRooms:jdRoomList.filter(y=>y.opsInternalShopId===x.shopId).map(y=>y.opsRoomId),
  identitySource:'OPS_INTERNAL_SHOP_ONLY',externalJdStoreVerified:false,
 }))??[];
 const jdObservedCount=Array.isArray(jdReport?.rooms)?jdReport.rooms.filter(x=>/^\d{1,20}$/.test(String(x.roomId))).length:null;
 const sourceComplete=registry.roomCompleteness?.rooms==='DECLARED_COMPLETE'&&registry.roomCompleteness?.shops==='DECLARED_COMPLETE';
 const totalCfg=publicConfig.douyin.filter(x=>x.scopeApproved===true).length+publicConfig.tmall.filter(x=>x.userConfirmed===true).length;
 if(existing.length!==totalCfg)throw Error('REGISTERED_PUBLIC_TARGET_COUNT_MISMATCH');
 const expected=new Map(publicTargetsFromConfig(publicConfig).map(x=>[x.key,x]));
 for(const item of existing){const e=expected.get(item.key);
  if(!e||item.platform!==e.platform||item.platformAccountId!==e.platformAccountId||item.publicProfileSecUid!==e.publicProfileSecUid||item.platformRoomId!==e.platformRoomId||item.scoringEligible!==e.scoringEligible)
    throw Error('REGISTERED_PUBLIC_TARGET_IDENTITY_MISMATCH');
 }
 const unmappedSource=sourceRows.filter(x=>x.verifiedExternalIdentity!==true);
 const orphanShops=sourceShops.filter(x=>x.linkedOpsRoomIds.length===0);
 const issues=[];
 const add=(code,severity,details={})=>issues.push({code,severity,...details});
 if(unmappedSource.length)add('OPS_EXTERNAL_ACCOUNT_MAPPING_UNPROVEN','BLOCKER',{count:unmappedSource.length});
 if(orphanShops.length)add('SOURCE_SHOPS_WITHOUT_ROOM_MAPPING','BLOCKER',{count:orphanShops.length});
 if(!sourceComplete)add('OPS_GLOBAL_CATALOG_UNPROVEN','BLOCKER');
 if(unknown.length)add('OPS_DOUYIN_HISTORY_NOT_BOUND_TO_PUBLIC_IDENTITIES','BLOCKER',{count:unknown.filter(x=>x.platform==='douyin').length});
 if(sourceRows.some(x=>x.shopLink==='NOT_VERIFIED'||x.shopLink==='SHOPS_NOT_IMPORTED'||x.shopLink==='AMBIGUOUS_DUPLICATE_SHOP'||x.shopLink==='DUPLICATE_ROOM_ID_UNVERIFIED'))add('UNVERIFIED_INTERNAL_ROOM_SHOP_LINKS','BLOCKER');
 if(jdRoomList.some(x=>x.categoryMappingConflict))add('JD_CATEGORY_MAPPING_CONFLICT','REVIEW');
 if(!jdRoomList.length)add('NO_JD_SOURCE_ROOM_EVIDENCE','BLOCKER');
 if(jdObservedCount!==null && jdObservedCount!==jdRoomList.length)add('JD_REPORT_CATALOG_COUNT_MISMATCH','REVIEW');
 if(existing.some(x=>x.platform==='douyin'&&!x.publicProfileSecUid))add('DOUYIN_PROFILE_SECUID_NOT_PROVEN','REVIEW');
 return {
  schemaVersion:1,generatedAt:asOf,
  scope:'source-record-census-not-distinct-live-room-count',
  counts, sourceShopCounts:shopCounts, sourceShopList:sourceShops, totalEvidenceRows:registry.entries.length,
  totalConfiguredPublicAccounts:existing.length,
  approvedDouyinScoringAccounts:existing.filter(x=>x.platform==='douyin'&&x.scoringEligible===true).length,
  verifiedPhysicalRoomCount:null,
  globalShopCatalogComplete:sourceComplete,
  globalMonitoringCoverageVerified:false,
  unknownNeverMeansOffline:true,
  noNewScoringEnrollment:true,
  jd:{roomList:jdRoomList,opsShopList:jdShops,sourceSnapshotAt:jdReport?.checkedAt??null,observedHistoricalJDRecords:jdObservedCount},
  unmappedSourceIdentities:unmappedSource.map(x=>({platform:x.platform,opsRoomId:x.opsRoomId,externalIdentity:null,scoringEligible:false})),
  sourceShopsWithoutRoomMapping:orphanShops,
  unmappedOpsHistory:unknown.map(x=>({platform:x.platform,opsRoomId:x.opsRoomId,category:x.category??'',externalIdentity:null,scoringEligible:false})),
  issues,
  sourceWarnings:(registry.warnings??[]).map(cleanCode).slice(0,50),
 };
}
