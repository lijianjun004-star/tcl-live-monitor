/**
 * R3.14 private-only shop-name -> approved public account CANDIDATE triage.
 * No network, no implicit joins, no status LIVE/OFFLINE and no official KPI.
 * Names and identifiers MUST NOT be stored in public artifacts/logs.
 */
const norm=s=>typeof s==='string'?s.normalize('NFKC').toLocaleLowerCase('zh-CN')
  .replace(/[^\p{L}\p{N}]/gu,''): '';
const brandOnly=s=>norm(s).replace(/tcl|ffalcon|rayneo|雷鸟/g,'');
const brandFamily=s=>{
 const n=norm(s);
 if(/rayneo|雷鸟创新/.test(n))return 'RAYNEO';
 if(/ffalcon|雷鸟/.test(n))return 'FFALCON';
 if(/tcl/.test(n))return 'TCL';
 return 'UNCLASSIFIED';
};
const ngrams=(s,n=2)=>{
 const out=new Set();for(let i=0;i<=s.length-n;i++)out.add(s.slice(i,i+n));return out;
};
const jac=(a,b)=>{
 if(!a.size||!b.size)return 0;
 let n=0;for(const x of a)if(b.has(x))n++;
 return n/(a.size+b.size-n);
};
function longestCommon(a,b){
 let longest=0;
 for(let i=0;i<a.length;i++)for(let j=0;j<b.length;j++){
   let k=0;while(a[i+k]&&b[j+k]&&a[i+k]===b[j+k])k++;
   if(k>longest)longest=k;
 }
 return longest;
}
export function candidateSignals(shopName,accountName,sourceCategory='未核实'){
 const shop=norm(shopName),acc=norm(accountName),coreShop=brandOnly(shopName),coreAcc=brandOnly(accountName);
 const sBrand=brandFamily(shopName),aBrand=brandFamily(accountName);
 if(sBrand!=='UNCLASSIFIED'&&aBrand!=='UNCLASSIFIED'&&sBrand!==aBrand)
  return {score:0,reason:'BRAND_FAMILY_MISMATCH_NAME_ONLY',suggested:false,categoryConflict:false};
 const dealer=/富世新|经销商|经销|专卖店/.test(acc);
 const sourceOfficial=/官方|总部|旗舰店/.test(shop);
 if(dealer&&sourceOfficial&&!/富世新|经销|专卖店/.test(shop))
  return {score:0,reason:'SOURCE_OFFICIAL_VS_PUBLIC_DEALER',suggested:false,categoryConflict:false};
 if(!shop||!acc||coreShop.length<2||coreAcc.length<2)
  return {score:0,reason:'NO_DISTINCTIVE_NAME_EVIDENCE',suggested:false};
 // Ignore generic brand-only similarities; they cannot distinguish TCL accounts.
 const shared=longestCommon(coreShop,coreAcc);
 const max=Math.max(coreShop.length,coreAcc.length);
 const nameExact=shop===acc;
 const charOverlap=jac(ngrams(coreShop),ngrams(coreAcc));
 const substring=shared/Math.max(1,max);
 let score=nameExact?100:Math.round(100*(0.65*charOverlap+0.35*substring));
 const domainSpecific=/电视|电视机|空调|冰箱|洗衣机|显示器|家电|团购|艺术电视/.exec(coreShop)?.[0]??null;
 const incompatible=sourceCategory==='家电'&&/电视/.test(coreAcc)&&!/(?:家电|全品类)/.test(coreAcc);
 if(incompatible)score=Math.max(0,score-30);
 const suggested=Boolean(nameExact|| (shared>=3&&score>=35));
 return {
  score,reason:nameExact?'EXACT_SHOP_ACCOUNT_NAME':
    incompatible?'CATEGORY_CONFLICT_OR_NEEDS_REVIEW':
    suggested?(shared>=5?'DISTINCTIVE_NAME_FRAGMENT':'WEAK_NAME_SIMILARITY'):
    'NO_DISTINCTIVE_NAME_EVIDENCE',
  nameExact,sharedDistinctiveChars:shared,sourceCategory,
  domainSpecific,categoryConflict:incompatible,suggested,
 };
}
const validId=x=>/^[1-9][0-9]{0,15}$/.test(String(x??''));
export function buildPrivateShopAccountCandidates({sourceRows,approvedAccounts,maxCandidatesPerShop=3}){
 if(!Array.isArray(sourceRows)||!Array.isArray(approvedAccounts)||
   sourceRows.length>1000||approvedAccounts.length>1000)throw Error('INVALID_SOURCE_OR_REGISTRY');
 if(!Number.isSafeInteger(maxCandidatesPerShop)||maxCandidatesPerShop<1||maxCandidatesPerShop>6)
   throw Error('CANDIDATE_LIMIT_INVALID');
 const names=new Set(),keys=new Set(),shopIds=new Set(),roomIds=new Set();
 const accounts=approvedAccounts.filter(a=>a?.scopeApproved===true).map(a=>{
  if(typeof a.key!=='string'||!a.key||typeof a.accountName!=='string'||!a.accountName||a.accountName.length>120||
    typeof a.profileUrl!=='string')throw Error('APPROVED_ACCOUNT_RECORD_INVALID');
  let u;try{u=new URL(a.profileUrl)}catch{throw Error('APPROVED_URL_INVALID')}
  if(u.protocol!=='https:'||u.hostname!=='www.douyin.com'||
    !/^\/user\/MS4wLjABAAAA[A-Za-z0-9_-]{20,150}$/.test(u.pathname)||
    u.search||u.hash)throw Error('APPROVED_PROFILE_NOT_VERIFIED');
  if(keys.has(a.key)||names.has(u.pathname))throw Error('DUPLICATE_APPROVED_IDENTITY');
  names.add(u.pathname);keys.add(a.key);
  return {accountKey:a.key,accountName:a.accountName,publicSecUid:u.pathname.slice('/user/'.length),
   publicProfileUrl:u.href,scoringEligible:a.scoringEligible===true};
 });
 const rows=[];
 for(const r of sourceRows){
  const rid=String(r?.opsRoomId??''),sid=String(r?.opsShopId??'');
  if(!validId(rid)||!validId(sid)||!['dy','douyin','抖音'].includes(String(r.platform).toLowerCase()))
    throw Error('SOURCE_INTERNAL_IDENTITY_INVALID');
  if(roomIds.has(rid)||shopIds.has(sid))throw Error('SOURCE_DUPLICATE_IDENTITY');
  roomIds.add(rid);shopIds.add(sid);
  const shopName=typeof r.shopNameHint==='string'?r.shopNameHint.trim().slice(0,80):'';
  const candidates=accounts.map(a=>{
   const signals=candidateSignals(shopName,a.accountName,r.normalizedCategory);
   return {...a,...signals,
     // No proof => suggestions are NEVER VERIFIED regardless of name score.
     identityStatus:'UNVERIFIED',reviewApproved:false,externalBridgeProof:null,
     observedRoomId:null,liveStatus:'UNKNOWN',formalOpeningRatePercent:null};
  }).filter(c=>c.suggested)
    .sort((a,b)=>b.score-a.score||a.accountKey.localeCompare(b.accountKey,'en'))
    .slice(0,maxCandidatesPerShop);
  rows.push({opsRoomId:rid,opsShopId:sid,shopName,sourceCategory:r.normalizedCategory,
   rawSourceCategory:r.latestRawCategory,
   shopRecordPresent:r.shopRecordPresent===true,
   captureBound:r.captureBound===true,
   candidates,candidateStatus:candidates.length?'REVIEW_CANDIDATES_NOT_IDENTITY':'NO_RELIABLE_CANDIDATE',
   verifiedCrossSystemLinks:0});
 }
 // A public account that appears in leads for multiple DIFFERENT internal shops
 // is an unresolved many-to-one ambiguity; never silently choose one shop.
 const candidateUsers=new Map();
 for(const r of rows)for(const c of r.candidates){
  if(!candidateUsers.has(c.accountKey))candidateUsers.set(c.accountKey,new Set());
  candidateUsers.get(c.accountKey).add(r.opsShopId);
 }
 const ambiguousAccounts=[...candidateUsers].filter(([,shops])=>shops.size>1).map(([key])=>key);
 const ambiguousSet=new Set(ambiguousAccounts);
 for(const r of rows){
  for(const c of r.candidates)c.crossShopCandidateConflict=ambiguousSet.has(c.accountKey);
  if(r.candidates.some(c=>c.crossShopCandidateConflict))r.candidateStatus='MULTIPLE_OPS_SHOPS_CLAIM_SAME_PUBLIC_LEAD';
 }
 return {schemaVersion:314,mode:'PRIVATE_CANDIDATE_TRIAGE_ONLY',
  ambiguousPublicAccountLeads:ambiguousAccounts.length,
  ambiguousCandidateRows:rows.reduce((n,r)=>n+r.candidates.filter(c=>c.crossShopCandidateConflict).length,0),
  sourceOpsRooms:rows.length,approvedPublicAccounts:accounts.length,
  shopsWithReviewCandidates:rows.filter(x=>x.candidates.length).length,
  shopsWithoutReviewCandidates:rows.filter(x=>!x.candidates.length).length,
  suggestedPairs:rows.reduce((n,x)=>n+x.candidates.length,0),
  verifiedFourLayerBridges:0,sourceAccess:'PRIVATE_ENCRYPTED_OPS',
  formalOpeningRatePercent:null,formalFullDurationRatePercent:null,
  rows};
}
export function safePublicCandidateCounts(p){
 if(p?.schemaVersion!==314||!Array.isArray(p.rows))throw Error('INVALID_PRIVATE_CANDIDATE_REVIEW');
 return {schemaVersion:314,mode:'PUBLIC_AGGREGATE_ONLY',
  sourceOpsRooms:p.sourceOpsRooms,approvedPublicAccounts:p.approvedPublicAccounts,
  shopsWithReviewCandidates:p.shopsWithReviewCandidates,
  shopsWithoutReviewCandidates:p.shopsWithoutReviewCandidates,
  suggestedPairs:p.suggestedPairs,
  ambiguousPublicAccountLeads:p.ambiguousPublicAccountLeads,
  ambiguousCandidateRows:p.ambiguousCandidateRows,
  verifiedFourLayerBridges:0,formalOpeningRatePercent:null,formalFullDurationRatePercent:null,
  recordsOmittedBecausePrivate:true};
}
