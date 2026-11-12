/**
 * R3.6 - Douyin four-layer identity evidence gate and sampled-session events.
 * No network, no secrets, no guessing room/shop/UID relations, no scoring.
 * The caller must provide explicit source evidence; this module does not assert
 * that reference-site OPS IDs belong to any public Douyin account.
 */
const roomId = x => /^(?:[1-9]\d{0,15})$/.test(String(x ?? '')) ? String(x) : null;
const secUid = x => /^MS4wLjABAAAA[A-Za-z0-9_-]{20,150}$/.test(String(x ?? '')) ? String(x) : null;
const iso = x => typeof x === 'string' && Number.isFinite(Date.parse(x)) && /^\d{4}-\d\d-\d\dT/.test(x) ? new Date(x).toISOString() : null;
const evidenceRef = x => typeof x === 'string' && /^[A-Za-z][A-Za-z0-9_-]{5,79}$/.test(x) ? x : null;
const ALLOWED_KINDS = new Set(['OPS_ROOM_SHOP', 'PUBLIC_ACCOUNT_ROOM', 'CROSS_SYSTEM_BRIDGE']);
const asArray = a => Array.isArray(a) ? a : [];
const unknown = (r, reason) => ({opsRoomId:r.roomId,opsShopId:r.shopId??null, publicSecUid:null,publicLiveRoomId:null,accountKey:null,status:'UNVERIFIED',bridgeStatus:'NO_EVIDENCE',reason,scoringEligible:false,verifiedAt:null});

export function reconcileDouyinFourLayers({opsRooms, accounts, evidenceRows=[]}) {
  if (!Array.isArray(opsRooms) || !Array.isArray(accounts) || !Array.isArray(evidenceRows)) throw Error('INVALID_EVIDENCE_INPUT');
  if(opsRooms.length>1000||accounts.length>1000||evidenceRows.length>1000)throw Error('EVIDENCE_LIMIT_EXCEEDED');
  const eligible = new Map(), knownSec = new Set();
  for(const a of accounts){
    if(a?.scopeApproved!==true || typeof a.key!=='string' || !a.key)continue;
    let u;try{u=new URL(a.profileUrl)}catch{continue}
    const id = secUid(u.pathname.replace(/^\/user\//,''));
    if(u.origin!=='https://www.douyin.com'||!/^\/user\/MS4wLjABAAAA/.test(u.pathname)||u.search||u.hash||!id)continue;
    if(eligible.has(a.key)||knownSec.has(id))throw Error('APPROVED_ACCOUNT_COLLISION');
    eligible.set(a.key,{secUid:id,scoringEligible:a.scoringEligible===true});knownSec.add(id);
  }
  const rooms = new Map(), roomCounts=new Map(), accountCounts=new Map(), secCounts=new Map(), liveCounts=new Map();
  for(const r of opsRooms){
    const rid=roomId(r?.roomId),sid=roomId(r?.shopId);
    if(!rid||!sid||!['dy','douyin','抖音'].includes(String(r?.platform||'').toLowerCase()))continue;
    if(rooms.has(rid))throw Error('DUPLICATE_OPS_ROOM');
    rooms.set(rid,{roomId:rid,shopId:sid});
  }
  const candidates=[];
  for(const row of evidenceRows){
    const rid=roomId(row?.opsRoomId),sid=roomId(row?.opsShopId),pubRoom=roomId(row?.publicLiveRoomId),uid=secUid(row?.publicSecUid);
    const acc=typeof row?.accountKey==='string'?eligible.get(row.accountKey):null;
    const observed=iso(row?.observedAt);
    const base={opsRoomId:rid,opsShopId:sid,publicSecUid:uid,publicLiveRoomId:pubRoom,
      accountKey:typeof row?.accountKey==='string'?row.accountKey:null,
      status:'UNVERIFIED',bridgeStatus:'CANDIDATE',reason:'INSUFFICIENT_EVIDENCE',verifiedAt:null,scoringEligible:false};
    const ops=rooms.get(rid);
    if(!ops||ops.shopId!==sid||!acc||acc.secUid!==uid||!pubRoom||!observed){
      candidates.push({...base,reason:'IDENTITY_FIELDS_MISMATCH'});continue;
    }
    const proofs=asArray(row.proofs);
    const types=new Set(), refs=new Set();let valid=true;
    for(const p of proofs){
      const when=iso(p?.observedAt), ref=evidenceRef(p?.ref);
      if(!ALLOWED_KINDS.has(p?.kind)||!when||!ref||refs.has(ref)||types.has(p.kind)||Math.abs(Date.parse(when)-Date.parse(observed))>7*86400000){valid=false;break}
      types.add(p.kind);refs.add(ref);
    }
    if(!valid||types.size!==3||row?.reviewApproved!==true){
      candidates.push({...base,reason:'THREE_INDEPENDENT_PROOFS_AND_APPROVAL_REQUIRED'});continue;
    }
    candidates.push({...base,status:'VERIFIED',bridgeStatus:'VERIFIED',reason:'EXPLICIT_CROSS_SYSTEM_EVIDENCE',verifiedAt:observed,scoringEligible:acc.scoringEligible});
    for(const [map,key] of [[roomCounts,rid],[accountCounts,row.accountKey],[secCounts,uid],[liveCounts,pubRoom]])map.set(key,(map.get(key)||0)+1);
  }
  const accepted = new Map(), conflicts=[];
  for(const c of candidates){
    if(c.status!=='VERIFIED')continue;
    if([roomCounts.get(c.opsRoomId),accountCounts.get(c.accountKey),secCounts.get(c.publicSecUid),liveCounts.get(c.publicLiveRoomId)].some(n=>n>1)){
      conflicts.push({opsRoomId:c.opsRoomId,reason:'MULTIPLE_COMPETING_EXPLICIT_LINKS'});continue;
    }
    accepted.set(c.opsRoomId,c);
  }
  const links=[];
  const conflictIds = new Set(conflicts.map(c => c.opsRoomId));
  const candidateIds = new Set(candidates.map(c => c.opsRoomId).filter(Boolean));
  for(const r of rooms.values()) {
    const x=accepted.get(r.roomId);
    const fallback=unknown(r, conflictIds.has(r.roomId) ? 'MULTIPLE_COMPETING_EXPLICIT_LINKS' :
      candidateIds.has(r.roomId) ? 'CANDIDATE_REQUIRES_REVIEW' : 'NO_EXPLICIT_BRIDGE');
    links.push(x || {...fallback, bridgeStatus:conflictIds.has(r.roomId)?'CONFLICT':
      candidateIds.has(r.roomId)?'CANDIDATE':'NO_EVIDENCE'});
  }
  links.sort((a,b)=>a.opsRoomId.localeCompare(b.opsRoomId,'en',{numeric:true}));
  return {schemaVersion:36,platform:'douyin',links,verifiedLinks:accepted.size,
    unresolvedLinks:links.length-accepted.size,conflicts,
    allPublicIdentitiesVerified:links.length>0&&links.every(l=>l.status==='VERIFIED'),
    formalOpeningRatePercent:null,formalFullDurationRatePercent:null};
}

/**
 * Emits observed sampling events, not actual broadcast start or end times.
 * A public LIVE requires verified profile AND room plus a VERIFIED four-layer link.
 * Room ID changing alone never proves a new session. A new-session event needs
 * independently verified boundary evidence, not capture session credentials.
 */
export function buildDouyinSessionEvents({observations, identityReport}) {
  if(!Array.isArray(observations)||!Array.isArray(identityReport?.links))throw Error('INVALID_SESSION_INPUT');
  if(observations.length>10000)throw Error('OBSERVATION_LIMIT_EXCEEDED');
  const verified=new Map(identityReport.links.filter(l=>l.status==='VERIFIED').map(l=>[l.opsRoomId,l]));
  const accepted=[], skipped=[], events=[];
  for(const o of observations){
    const rid=roomId(o?.opsRoomId),at=iso(o?.checkedAt),link=verified.get(rid);
    if(!rid||!at||!link){skipped.push({opsRoomId:rid,reason:!link?'IDENTITY_NOT_VERIFIED':'INVALID_OBSERVATION'});continue}
    if(!link.verifiedAt || Date.parse(at)<Date.parse(link.verifiedAt) || Date.parse(at)-Date.parse(link.verifiedAt)>7*86400000){
      skipped.push({opsRoomId:rid,reason:'BRIDGE_EVIDENCE_STALE_OR_NOT_YET_VALID'});continue;
    }
    const pRid=roomId(o?.publicLiveRoomId);
    const proof=o.sessionBoundaryEvidence;
    const proofAt=iso(proof?.observedAt);
    const boundary = proof?.kind==='INDEPENDENT_NEW_SESSION' && proof?.confirmed===true && evidenceRef(proof?.ref)!==null &&
      proofAt!==null && Date.parse(proofAt)<=Date.parse(at) && Date.parse(at)-Date.parse(proofAt)<=30*60000;
    const publicDoubleVerified = o.accountKey===link.accountKey&&o.state==='LIVE'&&o.profileIdentityVerified===true&&o.roomIdentityVerified===true&&pRid!==null;
    accepted.push({opsRoomId:rid,at,state:publicDoubleVerified?'LIVE':'UNKNOWN',publicLiveRoomId:pRid,
      candidate:o.offlineCandidate===true,boundary:boundary===true,boundaryRef:boundary?proof.ref:null});
  }
  accepted.sort((a,b)=>a.opsRoomId.localeCompare(b.opsRoomId,'en',{numeric:true})||Date.parse(a.at)-Date.parse(b.at));
  const seen = new Map(), trustedRoomByOps = new Map();
  for(const s of accepted){
    const link=verified.get(s.opsRoomId), p=seen.get(s.opsRoomId);
    if(p&&s.at===p.at){skipped.push({opsRoomId:s.opsRoomId,reason:'DUPLICATE_TIMESTAMP'});continue}
    const trustedRoom=trustedRoomByOps.get(s.opsRoomId)??link.publicLiveRoomId;
    const live=s.state==='LIVE'&&(s.publicLiveRoomId===trustedRoom||s.boundary);
    if(live&&s.boundary)trustedRoomByOps.set(s.opsRoomId,s.publicLiveRoomId);
    const evt={opsRoomId:s.opsRoomId,accountKey:link.accountKey,observedAt:s.at,
      previousObservedAt:p?.at??null,exactStartAt:null,exactEndAt:null,formalFullDurationRatePercent:null};
    if(live){
      if(!p?.everLive){events.push({...evt,type:'FIRST_SEEN_LIVE',possibleStartAfter:p?.at??null});}
      else if(s.boundary&&(!p.lastBoundaryRef||p.lastBoundaryRef!==s.boundaryRef)) {
        events.push({...evt,type:'NEXT_SESSION_DETECTED',possibleStartAfter:p.at,boundaryEvidenceRef:s.boundaryRef});
      }
    } else if(p?.everLive){
      if(!p.unknownActive)events.push({...evt,type:'UNKNOWN_GAP'});
      if(s.candidate&&!p.candidateActive)events.push({...evt,type:'OFFLINE_CANDIDATE'});
    }
    seen.set(s.opsRoomId,{at:s.at,everLive:(p?.everLive||false)||live,
      unknownActive:!live,candidateActive:!live&&s.candidate,
      lastBoundaryRef:s.boundary?(s.boundaryRef):p?.lastBoundaryRef??null});
  }
  return {schemaVersion:36,platform:'douyin',events,skipped,
    verifiedOpsRoomCount:verified.size,observationsAccepted:accepted.length-skipped.filter(x=>x.reason==='DUPLICATE_TIMESTAMP').length,
    validatedOfflineCount:0,exactStartTimesKnown:0,exactEndTimesKnown:0,
    formalOpeningRatePercent:null,formalFullDurationRatePercent:null};
}
