/**
 * R3.6 public-evidence Douyin monitoring adapter.
 * This is a clean-room implementation built from approved repository sources.
 * It is NOT a reverse-engineered clone of the blocked reference website.
 */
import {decideDouyin} from '../lib/douyin.mjs';

const REFERENCE_ORIGIN='http://101.96.215.251';
const DATE_RE=/^\d{4}-\d{2}-\d{2}$/;
const PLATFORM_LABELS=Object.freeze({
  jd:'JD (confirmed from provided URL)',
  dy:'DOUYIN (hypothesis only, reference unverified)',
  douyin:'DOUYIN (hypothesis only, reference unverified)',
  tmall:'TMALL (hypothesis only, reference unverified)',
});

export function parseProvidedReferenceUrl(input){
  const u=new URL(input);
  if(u.origin!==REFERENCE_ORIGIN || u.pathname!=='/')throw Error('REFERENCE_ORIGIN_OR_PATH_NOT_APPROVED');
  if([...u.searchParams.keys()].some(k=>!['start','end','platform','category','shop_id'].includes(k))){
    throw Error('REFERENCE_UNRECOGNIZED_QUERY_KEY');
  }
  const from=u.searchParams.get('start'),to=u.searchParams.get('end');
  const valid=d=>DATE_RE.test(d||'') && !Number.isNaN(Date.parse(d+'T00:00:00Z'))
    && new Date(d+'T00:00:00Z').toISOString().slice(0,10)===d;
  if(!valid(from)||!valid(to)||from>to)throw Error('REFERENCE_INVALID_DATE_RANGE');
  const platform=u.searchParams.get('platform');
  if(!Object.hasOwn(PLATFORM_LABELS,platform||''))throw Error('REFERENCE_PLATFORM_NOT_VERIFIED');
  const shopId=u.searchParams.get('shop_id');
  if(shopId!==null && !/^[1-9]\d{0,9}$/.test(shopId))throw Error('REFERENCE_INVALID_INTERNAL_SHOP_ID');
  const category=u.searchParams.get('category');
  if(category!==null && (category.length>60 || /[<>]/.test(category)))throw Error('REFERENCE_INVALID_CATEGORY');
  return {
    referenceOrigin:u.origin,from,to,platform,category,internalShopId:shopId,
    platformInterpretation:PLATFORM_LABELS[platform],
    sourceVerified:platform==='jd',
    internalApiSchemaVerified:false,
    networkCaptureAvailable:false,
  };
}

function secUid(profileUrl){
  try{
    const u=new URL(profileUrl);
    if(u.protocol!=='https:'||u.hostname!=='www.douyin.com')return null;
    const m=/^\/user\/(MS4wLjABAAAA[A-Za-z0-9_-]{20,})$/.exec(u.pathname);
    return m?.[1]||null;
  }catch{return null;}
}

/** Roster is from source-controlled approved config, not the blocked reference website. */
export function buildApprovedDouyinRegistry(config){
  if(!Array.isArray(config?.douyin))throw Error('APPROVED_DOUYIN_REGISTRY_MISSING');
  const byKey=new Set(),bySecUid=new Set(),byDisplayId=new Set();
  const out=[];
  for(const t of config.douyin){
    if(t.scopeApproved!==true)throw Error('UNAPPROVED_DOUYIN_TARGET');
    if(!t.key||!t.accountName||!/^[A-Za-z0-9._-]{3,32}$/.test(String(t.displayDouyinId||'')))throw Error('INVALID_DOUYIN_IDENTITY');
    const id=secUid(t.profileUrl);
    if(!id)throw Error('INVALID_DOUYIN_SECUID');
    if(byKey.has(t.key)||bySecUid.has(id)||byDisplayId.has(t.displayDouyinId))throw Error('DUPLICATE_DOUYIN_IDENTITY');
    byKey.add(t.key);bySecUid.add(id);byDisplayId.add(t.displayDouyinId);
    out.push(Object.freeze({
      key:t.key,accountName:t.accountName,displayDouyinId:t.displayDouyinId,
      secUid:id,profileUrl:t.profileUrl,configuredRoomId:t.roomId||null,
      scopeApproved:true,scoringEligible:t.scoringEligible===true,
    }));
  }
  return Object.freeze(out);
}

/**
 * Shop IDs on the reference system are internal keys; never equate those to
 * Douyin room ID, secUid, or a public Douyin number.
 * Only an explicit source record with exact secUid or Douyin ID is matchable.
 */
export function reconcileReferenceShopRows(rows,registry){
  if(!Array.isArray(rows)||!Array.isArray(registry))throw Error('INVALID_REFERENCE_ROWS');
  const bySec=new Map(registry.map(x=>[x.secUid,x]));
  const byNum=new Map(registry.map(x=>[x.displayDouyinId,x]));
  return rows.map((row,index)=>{
    const base={index,internalShopId:null,identity:'UNVERIFIED',accountKey:null,scoringEligible:false,reason:null};
    if(!row||typeof row!=='object')return {...base,reason:'INVALID_ROW'};
    const shop=String(row.shop_id??row.internalShopId??'');
    if(!/^[1-9]\d{0,9}$/.test(shop))return {...base,reason:'INTERNAL_SHOP_ID_UNVERIFIED'};
    base.internalShopId=shop;
    const sec=typeof row.secUid==='string'?bySec.get(row.secUid):null;
    const num=typeof row.displayDouyinId==='string'?byNum.get(row.displayDouyinId):null;
    if(sec&&num&&sec.key!==num.key)return {...base,identity:'CONFLICT',reason:'SECUID_DISPLAY_ID_MISMATCH'};
    if(!sec&&!num)return {...base,reason:'NO_EXACT_PLATFORM_IDENTITY'};
    // A row explicitly claiming an ID not matching the resolved account is unsafe.
    const hit=sec||num;
    if((row.secUid&&row.secUid!==hit.secUid)||(row.displayDouyinId&&row.displayDouyinId!==hit.displayDouyinId)){
      return {...base,identity:'CONFLICT',reason:'EXPLICIT_IDENTITY_CONFLICT'};
    }
    return {...base,identity:'MATCHED_CANDIDATE',accountKey:hit.key,
      scoringEligible:hit.scoringEligible,reason:'PUBLIC_ACCOUNT_ID_MATCH_ONLY; SHOP_OWNERSHIP_NOT_PROVEN'};
  });
}

/** Use the exact validated public-guest two-page classifier already in MAIN. */
export function projectDouyinGuestObservation({account,profile,room,checkedAt}){
  if(!account?.scopeApproved)throw Error('TARGET_NOT_APPROVED');
  const at=Date.parse(checkedAt);
  if(!Number.isFinite(at))throw Error('OBSERVATION_TIME_INVALID');
  const target={
    accountName:account.accountName,
    displayDouyinId:account.displayDouyinId,
    roomId:account.configuredRoomId,
  };
  const d=decideDouyin(profile,room,target,{offlineRuleValidated:false});
  if(d.state==='OFFLINE')throw Error('UNVALIDATED_OFFLINE_MUST_NOT_PROMOTE');
  return {
    platform:'douyin',accountKey:account.key,checkedAt:new Date(at).toISOString(),
    state:d.state,reason:d.reason,observedRoomId:d.observedRoomId||null,
    roomIdChanged:d.roomIdChanged===true,profileIdentityVerified:d.profileIdentityVerified===true,
    roomIdentityVerified:d.roomPageIdentityVerified===true,offlineCandidate:d.offlineCandidate===true,
    scoringEligible:account.scoringEligible===true,
    exactStartAt:null,exactEndAt:null,formalOpeningRate:null,formalDurationRate:null,
  };
}

/** Reconstruct only observed boundaries, never exact start/stop or continuous duration. */
export function observedSessionWindows(observations){
  if(!Array.isArray(observations))throw Error('INVALID_OBSERVATIONS');
  const sorted=[...observations].sort((a,b)=>Date.parse(a.checkedAt)-Date.parse(b.checkedAt));
  const byAccount=new Map();
  for(const o of sorted){
    if(o.platform!=='douyin'||!o.accountKey||!Number.isFinite(Date.parse(o.checkedAt)))throw Error('INVALID_OBSERVATION');
    const arr=byAccount.get(o.accountKey)||[];
    const prev=arr.at(-1);
    if(o.state==='LIVE'){
      // Never infer that UNKNOWN means ended. A new observed room ID alone
      // is not proof of a new broadcast without an independent session signal.
      if(prev&&prev.open && (!prev.roomId||prev.roomId===o.observedRoomId||!o.observedRoomId)){
        prev.lastLiveObservedAt=o.checkedAt;prev.samples++;
      }else if(prev&&prev.open){
        prev.roomIdChangeObserved=true;
        prev.lastLiveObservedAt=o.checkedAt;
        prev.samples++;
        prev.roomId=o.observedRoomId||prev.roomId;
      }else{
        arr.push({accountKey:o.accountKey,firstLiveObservedAt:o.checkedAt,
          lastLiveObservedAt:o.checkedAt,roomId:o.observedRoomId||null,samples:1,
          open:true,roomIdChangeObserved:false,exactStartAt:null,exactEndAt:null});
      }
    }else if(o.state==='UNKNOWN'&&prev?.open){
      prev.hasUnknownGap=true; // no fabricated OFFLINE transition
    }
    byAccount.set(o.accountKey,arr);
  }
  return [...byAccount.values()].flat();
}
