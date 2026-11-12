/**
 * R3.13 private-only four-layer review preflight.
 * No network, no automatic identity joins or scoring. Never upload input or
 * private output to PUBLIC GitHub. Public summary has counts ONLY.
 */
export const REVIEW_HEADERS=Object.freeze([
 '序号','内部房间ID','内部店铺ID','来源类目(11-11)','来源类目(11-07原值)',
 '采集绑定','第1层 房间→店铺','11-07是否已存在','第2层 店铺→公开账号secUid',
 '第2层证据(原件位置/截图/导出)','第3层 账号→公开直播间ID','第3层证据',
 '第4层 跨系统桥接','审核人','审核时间','当前状态','说明'
]);
const ID=/^[1-9][0-9]{0,15}$/;
const ROOM=/^[1-9][0-9]{4,23}$/;
const SEC=/^MS4wLjABAAAA[A-Za-z0-9_-]{20,150}$/;
const SAFE_DOUYIN=/^https:\/\/www\.douyin\.com\/user\//;
const UNSUPPLIED=new Set(['','UNVERIFIED','UNKNOWN','待核实','未核实','待审核','N/A','-']);
const usable = value=>typeof value==='string'&&!UNSUPPLIED.has(value.trim());
const time = x=>typeof x==='string' && /^\d{4}-\d{2}-\d{2}T/.test(x.trim())&&Number.isFinite(Date.parse(x))?new Date(x).toISOString():null;

/** RFC4180-ish CSV with BOM, quoted CR/LF, escaped double quote and strict width. */
export function parsePrivateCSV(input){
 if(typeof input!=='string'||input.length>1_000_000)throw Error('PRIVATE_CSV_SIZE_INVALID');
 const src=input.replace(/^\uFEFF/,'');
 const rows=[];let row=[],cell='',quoted=false,afterQuote=false;
 for(let i=0;i<src.length;i++){
  const c=src[i];
  if(quoted){
   if(c==='"'){if(src[i+1]==='"'){cell+='"';i++}else{quoted=false;afterQuote=true}}
   else cell+=c;
   continue;
  }
  if(c==='"'){
   if(cell.length||afterQuote)throw Error('CSV_QUOTE_INVALID');
   quoted=true;continue;
  }
  if(c===','||c==='\n'||c==='\r'){
   row.push(cell);cell='';afterQuote=false;
   if(c!==','){
    if(c==='\r'&&src[i+1]==='\n')i++;
    rows.push(row);row=[];
   }
   continue;
  }
  if(afterQuote && c!==' ' && c!=='\t')throw Error('CSV_TRAILING_QUOTE_TEXT');
  if(afterQuote && (c===' '||c==='\t'))continue;
  cell+=c;
 }
 if(quoted)throw Error('CSV_UNTERMINATED_QUOTE');
 if(cell.length||row.length){row.push(cell);rows.push(row)}
 if(!rows.length)throw Error('CSV_EMPTY');
 if(rows[0].length!==REVIEW_HEADERS.length||
   !REVIEW_HEADERS.every((h,i)=>rows[0][i].trim()===h))throw Error('CSV_SCHEMA_MISMATCH');
 if(rows.length>1004)throw Error('CSV_ROW_LIMIT');
 return rows.slice(1).filter(row=>row.some(v=>String(v).trim()));
}
function normalizeSource(source){
 if(source?.schemaVersion!==311||!Array.isArray(source.rooms)||source.rooms.length>1000)
  throw Error('PRIVATE_SOURCE_DETAIL_REQUIRED');
 const sourceMap=new Map();
 for(const r of source.rooms){
  const rid=String(r.opsRoomId??''),sid=String(r.opsShopId??'');
  if(!ID.test(rid)||!ID.test(sid)||!['dy','douyin','抖音'].includes(String(r.platform).toLowerCase())||
   sourceMap.has(rid))throw Error('PRIVATE_SOURCE_IDENTITY_INVALID');
  sourceMap.set(rid,{shopId:sid,category:String(r.category??''),captureBound:r.captureBound===true});
 }
 return sourceMap;
}
function approvedAccounts(config){
 if(!Array.isArray(config?.douyin))throw Error('PUBLIC_APPROVED_REGISTRY_REQUIRED');
 const allowed=new Map();
 for(const a of config.douyin){
  if(a?.scopeApproved!==true)continue;
  let url;try{url=new URL(a.profileUrl)}catch{throw Error('REGISTRY_URL_INVALID')}
  const uid=url.pathname.startsWith('/user/')?url.pathname.slice(6):'';
  if(!SAFE_DOUYIN.test(url.href)||url.hostname!=='www.douyin.com'||
    url.search||url.hash||!SEC.test(uid)||allowed.has(uid))throw Error('APPROVED_SECUID_CONFLICT');
  allowed.set(uid,{key:a.key,secUid:uid});
 }
 return allowed;
}
export function auditPrivateBridgeCSV({csvText,sourceDetail,registry}={}){
 const entries=parsePrivateCSV(csvText);
 const source=normalizeSource(sourceDetail);
 const accounts=approvedAccounts(registry);
 const seenRooms=new Set(),seenShops=new Set(),seenPublic=new Set(),review=[];
 let instructionRows=0,conflictCount=0,verifiedInternalPairs=0,categoryDrift=0;
 for(const cells of entries){
  // Existing private sheet ends with one plain two-column editorial note.
  if(cells[0]?.trim()==='填写规则'&&cells.length<=2){instructionRows++;continue}
  if(cells.length!==REVIEW_HEADERS.length)throw Error('CSV_ROW_WIDTH_INVALID');
  const row=Object.fromEntries(REVIEW_HEADERS.map((h,i)=>[h,String(cells[i]??'').trim()]));
  const rid=row['内部房间ID'],sid=row['内部店铺ID'];
  if(!rid&&!sid&&!String(row['序号']).trim()){instructionRows++;continue}
  const issues=[];
  if(!ID.test(rid)||!ID.test(sid))issues.push('INVALID_PRIVATE_ROOM_OR_SHOP_ID');
  if(seenRooms.has(rid))issues.push('DUPLICATE_INTERNAL_ROOM');
  if(seenShops.has(sid))issues.push('DUPLICATE_INTERNAL_SHOP_REQUIRES_REVIEW');
  seenRooms.add(rid);seenShops.add(sid);
  const s=source.get(rid);
  const internalVerified=Boolean(s&&s.shopId===sid&&
   row['第1层 房间→店铺'].startsWith('VERIFIED'));
  if(!s)issues.push('INTERNAL_ROOM_NOT_IN_SOURCE');
  else if(s.shopId!==sid)issues.push('INTERNAL_SHOP_MISMATCH');
  else if(!row['第1层 房间→店铺'].startsWith('VERIFIED'))issues.push('INTERNAL_RELATION_NOT_MARKED_VERIFIED');
  if(internalVerified)verifiedInternalPairs++;
  if(s&&row['来源类目(11-11)']!==row['来源类目(11-07原值)']){
   categoryDrift++;issues.push('HISTORICAL_CATEGORY_DIFF_REQUIRES_ORIGINAL_EVIDENCE');
  }
  const uid=row['第2层 店铺→公开账号secUid'];
  const hasUid=usable(uid)&&SEC.test(uid);
  const matched=hasUid?accounts.get(uid):null;
  if(usable(uid)&&!matched)issues.push('PUBLIC_ACCOUNT_NOT_APPROVED_OR_INVALID');
  if(matched){if(seenPublic.has(uid))issues.push('PUBLIC_SECUID_LINK_COLLISION');seenPublic.add(uid)}
  const pubRoom=row['第3层 账号→公开直播间ID'];
  const hasRoom=usable(pubRoom)&&ROOM.test(pubRoom);
  if(usable(pubRoom)&&!hasRoom)issues.push('PUBLIC_LIVE_ROOM_ID_INVALID');
  const secondProof=usable(row['第2层证据(原件位置/截图/导出)']);
  const thirdProof=usable(row['第3层证据']);
  const bridgeMark=row['第4层 跨系统桥接'];
  const reviewer=usable(row['审核人'])?row['审核人']:null;
  const reviewedAt=time(row['审核时间']);
  const reviewReady=Boolean(internalVerified&&matched&&hasRoom&&secondProof&&thirdProof&&reviewer&&reviewedAt&&
    issues.filter(i=>i!=='HISTORICAL_CATEGORY_DIFF_REQUIRES_ORIGINAL_EVIDENCE').length===0);
  if(bridgeMark==='VERIFIED'&&!reviewReady)issues.push('UNSUPPORTED_BRIDGE_VERIFIED_MARKER');
  if(issues.length||!reviewReady)conflictCount++;
  // NEVER emit reviewApproved=true from a CSV marker, a name similarity, or a proof filename.
  review.push({
   privateOpsRoomId:rid,privateOpsShopId:sid,
   sourcePairMatched:internalVerified,approvedAccountKey:matched?.key??null,
   proposedPublicSecUid:matched?.secUid??null,
   proposedLiveRoomId:hasRoom?pubRoom:null,
   secondProofDeclared:secondProof,thirdProofDeclared:thirdProof,
   reviewerDeclared:Boolean(reviewer),reviewedAt,
   categorySourceValue:row['来源类目(11-11)'],
   categoryHistoricalValue:row['来源类目(11-07原值)'],
   reviewReady,verifiedBridge:false,issues,
   status:'UNVERIFIED',
  });
 }
 const unknownSourceRooms=[...source.keys()].filter(rid=>!seenRooms.has(rid)).length;
 return {schemaVersion:313,mode:'PRIVATE_OFFLINE_REVIEW_NO_AUTOMATIC_BRIDGE',
  inputSourceRoomCount:source.size,privateSheetRoomCount:review.length,
  ignoredInstructionRows:instructionRows,internalSourcePairsVerified:verifiedInternalPairs,
  categoryDifferenceRows:categoryDrift,conflictedOrIncompleteRows:conflictCount,
  missingSourceRowsInSheet:unknownSourceRooms,approvedPublicAccounts:accounts.size,
  declaredPublicAccounts:review.filter(r=>r.approvedAccountKey).length,
  rowsReadyForIndependentHumanReview:review.filter(r=>r.reviewReady).length,
  verifiedCrossSystemBridges:0,formalOpeningRatePercent:null,formalFullDurationRatePercent:null,
  review,readyForProduction:false};
}
/** Caller may write this into PUBLIC CI; it contains NO private room IDs or per-row ordinal. */
export function publicBridgePreflightSummary(report){
 if(report?.schemaVersion!==313||!Array.isArray(report.review))throw Error('INVALID_PRIVATE_REVIEW');
 return {schemaVersion:313,mode:'PUBLIC_COUNTS_ONLY',
  inputSourceRoomCount:report.inputSourceRoomCount,
  privateSheetRoomCount:report.privateSheetRoomCount,
  internalSourcePairsVerified:report.internalSourcePairsVerified,
  categoryDifferenceRows:report.categoryDifferenceRows,
  conflictedOrIncompleteRows:report.conflictedOrIncompleteRows,
  missingSourceRowsInSheet:report.missingSourceRowsInSheet,
  approvedPublicAccounts:report.approvedPublicAccounts,
  declaredPublicAccounts:report.declaredPublicAccounts,
  rowsReadyForIndependentHumanReview:report.rowsReadyForIndependentHumanReview,
  verifiedCrossSystemBridges:0,
  formalOpeningRatePercent:null,formalFullDurationRatePercent:null,
  readyForProduction:false};
}
