import {EXPECTED_SOURCE_CATEGORY} from './tcl-jd-all.mjs';
/** TCL operations-platform read-only catalog adapter.
 * The internal ops room id is NOT a JD liveId, Tmall roomNum or Douyin secUid.
 * An internal catalog row NEVER creates an external monitored account or KPI item.
 * This module handles *already exported, authorized* JSON, never fetches anything.
 */
const PLATFORMS = Object.freeze({jd:'jd',jingdong:'jd','京东':'jd',tmall:'tmall',taobao:'tmall',tb:'tmall','天猫':'tmall','淘宝':'tmall',douyin:'douyin',dy:'douyin','抖音':'douyin'});
export function normalizePlatform(p){const key=String(p??'').trim().toLowerCase();return Object.hasOwn(PLATFORMS,key)?PLATFORMS[key]:null;}
const safeId = v => (typeof v!=='number'||Number.isSafeInteger(v)) && /^[0-9]{1,20}$/.test(String(v??'').trim()) ? String(v).trim().replace(/^0+(?=\d)/,'') : null;
const safeName = v => typeof v==='string' ? v.replace(/[<>\u0000-\u001f]/g,'').trim().slice(0,80) : '';
const readArray = (body,key) => {
  if(Array.isArray(body)) return body;
  const a=body?.[key]??body?.data?.[key]??body?.data?.list??body?.list;
  if(!Array.isArray(a)) throw Error('SCHEMA_'+key.toUpperCase()+'_MISSING');
  return a;
};
function completeness(body,items) {
  if(Array.isArray(body)) return 'UNPROVEN_NO_TOTAL';
  const envelopes=[body,body?.data,body?.pagination,body?.data?.pagination,body?.meta].filter(x=>x&&typeof x==='object');
  const more=v=>v===true||v===1||v==='1'||v==='true';
  const cursor=v=>v!==undefined&&v!==null&&v!==''&&v!==false;
  if(envelopes.some(x=>more(x.has_more)||more(x.hasMore)||
    ['next_cursor','nextCursor','next'].some(k=>cursor(x[k]))||Number(x.offset??0)>0||Number(x.page??x.current_page??1)>1))
    return 'INCOMPLETE_PAGINATED';
  const totals=envelopes.flatMap(x=>[x.total,x.total_count]).filter(x=>x!==undefined&&x!==null);
  if(!totals.length)return 'UNPROVEN_NO_TOTAL';
  return totals.every(x=>(typeof x==='number'||(typeof x==='string'&&/^\d+$/.test(x)))&&Number.isSafeInteger(Number(x))&&Number(x)===items.length)
    ?'DECLARED_COMPLETE':'INCOMPLETE_TOTAL_MISMATCH';
}
function cleanStatus(_){return 'UNKNOWN';} // catalog is NOT a current observation

export function normalizeOpsCatalog(roomsBody,shopsBody=null) {
  const roomItems=readArray(roomsBody,'rooms');
  const roomCompleteness=completeness(roomsBody,roomItems);
  let shopItems=null,shopCompleteness='NO_SHOP_EXPORT';
  if(shopsBody!==null){shopItems=readArray(shopsBody,'shops');shopCompleteness=completeness(shopsBody,shopItems);}
  const warnings=[], stores=new Map(), rooms=new Map(), ambiguousShops=new Set();
  for(const raw of shopItems??[]){
    const platform=normalizePlatform(raw?.platform),shopId=safeId(raw?.id??raw?.shop_id??raw?.shopId);
    if(!platform||!shopId){warnings.push('SHOP_PLATFORM_OR_ID_INVALID');continue;}
    const key=`${platform}:${shopId}`;
    if(stores.has(key)){warnings.push('SHOP_DUPLICATE:'+key);ambiguousShops.add(key);continue;}
    stores.set(key,{platform,shopId,shopName:safeName(raw?.name??raw?.shop_name),key});
  }
  for(const raw of roomItems){
    const platform=normalizePlatform(raw?.platform);
    const opsRoomId=safeId(raw?.id??raw?.room_id??raw?.live_room_id);
    if(!platform||!opsRoomId){warnings.push('ROOM_PLATFORM_OR_ID_INVALID');continue;}
    const key=`ops:${platform}:${opsRoomId}`;
    if(rooms.has(key)){
      warnings.push('ROOM_DUPLICATE:'+key);
      // Conflicting same-source IDs must never retain the first inferred shop binding.
      Object.assign(rooms.get(key), {opsShopId:null,shopName:'',shopLink:'DUPLICATE_ROOM_ID_UNVERIFIED',categoryMappingConflict:true});
      continue;
    }
    const shopId=safeId(raw?.shop_id??raw?.shopId??raw?.shop?.id);
    const ambiguous=shopId?ambiguousShops.has(`${platform}:${shopId}`):false;
    const matched=shopId&&!ambiguous?stores.get(`${platform}:${shopId}`):null;
    const unresolved=shopId!==null&&shopItems!==null&&!matched;
    if(unresolved)warnings.push(ambiguous?'SHOP_LINK_AMBIGUOUS:'+key:'SHOP_LINK_UNRESOLVED:'+key);
    const captureBound=!!raw?.bound_session_key;
    const categoryMappingConflict=platform==='jd'&&Object.hasOwn(EXPECTED_SOURCE_CATEGORY,opsRoomId)&&safeName(raw?.category)!==EXPECTED_SOURCE_CATEGORY[opsRoomId];
    if(categoryMappingConflict)warnings.push('CATEGORY_MAPPING_CONFLICT:'+opsRoomId);
    rooms.set(key,{
      key,source:'ops-platform',platform,opsRoomId,opsShopId:shopId,
      roomName:'运营巡检房间 '+opsRoomId,shopName:matched?.shopName||(!ambiguous?safeName(raw?.shop_name):''),
      category:safeName(raw?.category),captureBound,categoryMappingConflict,
      shopLink:matched?'SOURCE_SHOP_ID_JOIN':(ambiguous?'AMBIGUOUS_DUPLICATE_SHOP':shopItems===null?'SHOPS_NOT_IMPORTED':'NOT_VERIFIED'),
      verifiedExternalIdentity:false,currentStatus:cleanStatus(raw),
      scoringEligible:false,autoAddedToPublicProbe:false,
    });
  }
  // A declared total does not prove completeness if rows were discarded or duplicated.
  const inconsistentRooms=warnings.some(x=>/^(ROOM_DUPLICATE|ROOM_PLATFORM_OR_ID_INVALID)/.test(x));
  const inconsistentShops=warnings.some(x=>/^(SHOP_DUPLICATE|SHOP_PLATFORM_OR_ID_INVALID)/.test(x));
  for(const room of rooms.values()) if(room.opsShopId&&ambiguousShops.has(`${room.platform}:${room.opsShopId}`)) {
    room.shopName='';room.shopLink='AMBIGUOUS_DUPLICATE_SHOP';
  }
  return {
    rooms:[...rooms.values()].sort((a,b)=>a.key.localeCompare(b.key,'en')),
    shops:[...stores.values()].map(x=>ambiguousShops.has(x.key)?{...x,shopName:'',verification:'AMBIGUOUS_DUPLICATE_SHOP'}:x).sort((a,b)=>a.key.localeCompare(b.key,'en')),
    warnings,completeness:{rooms:inconsistentRooms?'UNPROVEN_INVALID_OR_DUPLICATE_ROWS':roomCompleteness,
      shops:inconsistentShops?'UNPROVEN_INVALID_OR_DUPLICATE_ROWS':shopCompleteness},
  };
}

export function publicTargetsFromConfig(cfg){
  if(cfg?.schemaVersion!==1||!Array.isArray(cfg?.douyin)||!Array.isArray(cfg?.tmall))throw Error('TARGET_CONFIG_INVALID');
  const targets=[],keys=new Set(),dyIds=new Set(),dySecUids=new Set(),tmallIds=new Set();
  for(const p of cfg.tmall){
    if(p.userConfirmed!==true)continue;
    const key='public:tmall:'+String(p.key||'');
    if(!p.key||keys.has(key))throw Error('DUPLICATE_PUBLIC_TARGET');keys.add(key);
    const tid=String(p.accountId??'').trim();
    if(!tid||tmallIds.has(tid))throw Error('DUPLICATE_TMALL_ACCOUNT');tmallIds.add(tid);
    targets.push({key,source:'public-probe-existing',platform:'tmall',name:safeName(p.displayName),platformAccountId:String(p.accountId??''),
      platformRoomId:String(p.roomNumber??''),scoringEligible:false,currentStatus:'UNKNOWN',autoAddedToPublicProbe:false,alreadyConfiguredInPublicProbe:true});
  }
  for(const p of cfg.douyin){
    if(p.scopeApproved!==true)continue;
    const key='public:douyin:'+String(p.key||'');
    if(!p.key||keys.has(key))throw Error('DUPLICATE_PUBLIC_TARGET');keys.add(key);
    const id=String(p.displayDouyinId??'').trim().toLowerCase();
    if(!id||dyIds.has(id))throw Error('DUPLICATE_DOUYIN_ACCOUNT');dyIds.add(id);
    const secUid=/^https:\/\/www\.douyin\.com\/user\/(MS4wLjABAAAA[\w-]{20,})(?:[?#].*)?$/.exec(String(p.profileUrl??''))?.[1]??null;
    if(secUid&&dySecUids.has(secUid))throw Error('DUPLICATE_DOUYIN_SECUID');
    if(secUid)dySecUids.add(secUid);
    targets.push({key,source:'public-probe-existing',platform:'douyin',name:safeName(p.accountName),platformAccountId:String(p.displayDouyinId??''),
      platformRoomId:String(p.roomId??''),publicProfileSecUid:secUid,scoringEligible:p.scoringEligible===true,
      currentStatus:'UNKNOWN',autoAddedToPublicProbe:false,alreadyConfiguredInPublicProbe:true});
  }
  return targets;
}

export function assembleRegistry({opsCatalog,configuredTargets,asOf,unmappedOpsRoomRows=[]}) {
  if(!opsCatalog||!Array.isArray(configuredTargets)||!Array.isArray(unmappedOpsRoomRows))throw Error('REGISTRY_INPUT_INVALID');
  const publicTargets=publicTargetsFromConfig({schemaVersion:1,tmall:configuredTargets.filter(t=>t._platform==='tmall').map(t=>t.data),douyin:configuredTargets.filter(t=>t._platform==='douyin').map(t=>t.data)});
  const confirmedOps=opsCatalog.rooms;
  const seen=new Set(confirmedOps.map(x=>x.key)),candidates=[];
  for(const item of unmappedOpsRoomRows){
    const p=normalizePlatform(item.platform),id=safeId(item.opsRoomId);
    if(!p||!id)continue;
    const key=`ops:${p}:${id}`;
    if(seen.has(key))continue;seen.add(key);
    candidates.push({key,source:'ops-history-unmapped',platform:p,opsRoomId:id,category:safeName(item.category),
      currentStatus:'UNKNOWN',verifiedExternalIdentity:false,scoringEligible:false,autoAddedToPublicProbe:false});
  }
  const all=[...confirmedOps,...publicTargets,...candidates];
  if(new Set(all.map(x=>x.key)).size!==all.length)throw Error('REGISTRY_KEY_COLLISION');
  return {
    schemaVersion:1,generatedAt:asOf??new Date().toISOString(),
    note:'Not an exhaustive census or live snapshot. Internal platform IDs and external accounts have no inferred 1:1 bindings.',
    roomCompleteness:opsCatalog.completeness,
    shops:opsCatalog.shops, // source-owned store identities only; never inferred external JD/Tmall/Douyin IDs
    numbers:{opsRooms:confirmedOps.length,alreadyConfiguredPublicAccounts:publicTargets.length,
      opsUnmappedHistory:candidates.length,uniquePhysicalRooms:'UNKNOWN_NOT_RECONCILED'},
    warnings:opsCatalog.warnings,
    entries:all,
  };
}
export const targetsToTagged = c => [...(c.tmall??[]).map(data=>({_platform:'tmall',data})),...(c.douyin??[]).map(data=>({_platform:'douyin',data}))];

/** Import the sanitized real JD Actions R0.7 artifact, without reconstituting secrets. */
export function normalizeJdReport(report) {
  if(report?.schemaVersion!==2 || report?.source!=='TCL_OPS_READ_ONLY' || !Array.isArray(report?.rooms) ||
     !Number.isFinite(Date.parse(report?.checkedAt??''))) throw Error('JD_REPORT_INVALID');
  const warnings = [...(Array.isArray(report.warnings)?report.warnings:[])];
  const rooms=[],seen=new Set();
  for(const r of report.rooms){
    const opsRoomId=safeId(r?.roomId),opsShopId=safeId(r?.shopId);
    if(!opsRoomId || seen.has(opsRoomId)){warnings.push('JD_REPORT_INVALID_OR_DUPLICATE_ROOM');continue;}
    seen.add(opsRoomId);
    rooms.push({key:'ops:jd:'+opsRoomId,source:'ops-platform',platform:'jd',opsRoomId,opsShopId,
      roomName:'',shopName:'',category:safeName(r.category),captureBound:r.captureBound===true,
      shopLink:opsShopId?'SOURCE_ROOM_SHOP_ID':'NOT_VERIFIED',
      verifiedExternalIdentity:false,currentStatus:'UNKNOWN',scoringEligible:false,autoAddedToPublicProbe:false,
      historicalObservationAt:report.checkedAt, historicalObservationState:['LIVE','OFFLINE','UNKNOWN'].includes(r.status)?r.status:'UNKNOWN',
      categoryMappingConflict:r.categoryMappingConflict===true});
  }
  const roomBroken=warnings.some(x=>x==='JD_REPORT_INVALID_OR_DUPLICATE_ROOM');
  return {rooms,shops:[],warnings,completeness:{rooms:roomBroken?'UNPROVEN_INVALID_OR_DUPLICATE_ROWS':report.monitoringCoverage?.roomCatalogComplete===true?'DECLARED_COMPLETE':'UNPROVEN_FROM_SOURCE',shops:'UNPROVEN_FROM_SOURCE'}};
}
