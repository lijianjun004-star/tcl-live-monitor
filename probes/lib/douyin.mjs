// Douyin public guest corroboration (pure). Ported from read-only historical branch
// tcl-douyin-diagnostic @ 9665289 and extended with:
//   1) cross-session room discovery: the profile's "直播中" anchor may point to a room id
//      different from the configured one -> reported as ROOM_ID_CHANGED, verified on that room page;
//   2) an OFFLINE *candidate* path. Douyin offline evidence has never been validated against a
//      real, user-confirmed stopped broadcast, so a candidate stays state=UNKNOWN until the
//      rule is promoted (config: douyinOfflineRuleValidated). UNKNOWN is never OFFLINE.

export const CHALLENGE_RE = /(验证码中间页|安全验证|滑块验证|captcha)/i;
export const LOGIN_GATE_RE = /(请先登录后观看|登录后观看|扫码登录后观看)/;
// Explicit end-of-broadcast wording on the room page (candidate signal only; to be calibrated).
export const ENDED_RE = /(直播已结束|直播已经结束|主播已下播|暂未开播|主播暂未开播)/;

/**
 * Conservative evidence from the page that the browser ACTUALLY loaded.
 * A title variant is acceptable only when the resolved approved profile URL
 * and one uniquely visible Douyin ID both match the approved registry.
 * A missing ID or a redirect to a different account is UNKNOWN.
 */
export function profileIdentityEvidence(p, t) {
  const title = String(p?.title || '').trim();
  const id = String(t?.displayDouyinId || '').trim();
  const name = String(t?.accountName || '');
  const allowedTitles = new Set([
    name + '的抖音 - 抖音',
    name + '的主页 - 抖音',
    ...(Array.isArray(t?.alternateTitles) ? t.alternateTitles : []),
  ]);
  const titleExact = allowedTitles.has(title);
  let expected = null;
  try { expected = new URL(t.profileUrl); } catch {}
  const finalProvided = typeof p?.finalHost === 'string' && typeof p?.finalPath === 'string';
  const finalUrlExact = expected?.protocol === 'https:' && expected?.hostname === 'www.douyin.com' &&
    p?.finalHost === 'www.douyin.com' && p?.finalPath === expected.pathname;
  const esc = id.replace(/[.*+?^$()|[\]{}]/g, '\\$&');
  const idPattern = id ? new RegExp('抖音号[:：]\\s*' + esc + '(?![A-Za-z0-9._-])') : null;
  const ids = [...new Set((Array.isArray(p?.douyinIdsInPage) ? p.douyinIdsInPage : []).map(String))];
  const idExact = id.length > 0 && (ids.length === 1 ? ids[0] === id
    : ids.length === 0 && idPattern.test(String(p?.bodyExcerpt || '')));
  const accessOk = p?.httpStatus === 200 &&
    !CHALLENGE_RE.test(title + ' ' + (p?.bodyExcerpt || '')) &&
    !LOGIN_GATE_RE.test(String(p?.bodyExcerpt || ''));
  const verified = accessOk && idExact && (finalProvided ? finalUrlExact : titleExact);
  return { verified: verified === true, httpOk: p?.httpStatus === 200,
    titleExact, idExact, finalProvided, finalUrlExact: Boolean(finalUrlExact),
    multipleVisibleIds: ids.length > 1, accessOk };
}
export function profileIdentity(p, t) {
  return profileIdentityEvidence(p,t).verified;
}

/**
 * A live room number is session-specific, NOT a permanent account identity.
 * A generic recommended-live anchor is never sufficient to visit another room.
 * Only one anchor explicitly scoped to the account OWNER profile header may be
 * explored, and the resulting room must independently confirm owner identity.
 */
export function liveAnchorScope(profile) {
  const ownerAnchors=(profile?.liveRoomAnchors || [])
    .filter(a=>a?.ownerScoped===true);
  const ids=liveAnchorRoomIds({...profile,liveRoomAnchors:ownerAnchors});
  if(ids.length===0) return {scope:'NO_OWNER_HEADER_LIVE_ANCHOR',roomId:null};
  if(ids.length!==1) return {scope:'AMBIGUOUS_OWNER_LIVE_ANCHORS',roomId:null};
  return {scope:'OWNER_HEADER_LIVE_ANCHOR',roomId:ids[0]};
}

function strictRoomOwnerVerified(room, target) {
  if(!Array.isArray(room?.ownerProfileLinks)) return false;
  try {
    const exp=new URL(target?.profileUrl);
    if(exp.protocol!=='https:' || exp.hostname!=='www.douyin.com') return false;
    return room.ownerProfileLinks.some(raw=>{
      try {
        const u=new URL(raw);
        return u.protocol==='https:' && u.hostname===exp.hostname && u.pathname===exp.pathname;
      } catch { return false; }
    });
  } catch { return false; }
}

/** Room ids the verified profile marks as live right now. */
export function liveAnchorRoomIds(p) {
  const ids = [];
  for (const a of p?.liveRoomAnchors || []) {
    try {
      const u = new URL(a.href);
      const m = u.hostname === 'live.douyin.com' && /^\/(\d{5,24})$/.exec(u.pathname);
      if (m && String(a.text || '').includes('直播中') && !ids.includes(m[1])) ids.push(m[1]);
    } catch {}
  }
  return ids;
}

export function roomIdentity(r, t) {
  return r?.httpStatus === 200 && !CHALLENGE_RE.test(`${r.title} ${r.bodyExcerpt}`) && !LOGIN_GATE_RE.test(String(r.bodyExcerpt || ''))
    && r.title === `${t.accountName}的抖音直播间 - 抖音直播`
    && String(r.metaDescription || '').startsWith(`欢迎来到${t.accountName}的抖音直播间`);
}

/**
 * profile: page snapshot; room: snapshot of the room page actually checked
 * (observedRoomId if the profile pointed elsewhere, else configured roomId).
 */
export function decideDouyin(profile, room, t, { offlineRuleValidated = false, strictRoomOwner = false } = {}) {
  const challenged = CHALLENGE_RE.test(`${profile?.title} ${profile?.bodyExcerpt}`) || CHALLENGE_RE.test(`${room?.title} ${room?.bodyExcerpt}`);
  const profileEvidence = profileIdentityEvidence(profile, t);
  const pid = profileEvidence.verified;
  const ownerScope=liveAnchorScope(profile);
  const anchors = pid ? (strictRoomOwner ? (ownerScope.roomId ? [ownerScope.roomId] : []) : liveAnchorRoomIds(profile)) : [];
  const observedRoomId = anchors[0] || null;
  const roomPageUrlMatches = !observedRoomId || !room?.finalHost || (
    room.finalHost === 'live.douyin.com' && room.finalPath === '/' + observedRoomId);
  const rid = roomIdentity(room, t) && roomPageUrlMatches && (!strictRoomOwner || strictRoomOwnerVerified(room,t));
  const roomIdChanged = !!observedRoomId && !!t?.roomId && observedRoomId !== String(t.roomId);
  const out = { state: 'UNKNOWN', reason: null, profileIdentityVerified: pid, roomPageIdentityVerified: rid,
    observedRoomId, roomIdChanged, offlineCandidate: false,
    signals: { profile: profileEvidence, roomPageUrlMatches, ownerAnchorScope:strictRoomOwner ? ownerScope.scope : 'LEGACY' } };
  if (challenged) return { ...out, reason: 'PUBLIC_GUEST_ACCESS_CHALLENGED' };
  if (!pid) return { ...out, reason: 'PROFILE_IDENTITY_NOT_VERIFIED' };
  if (observedRoomId) {
    // Stale profile live badge cannot override the actual main player's ended state.
    if (rid && ENDED_RE.test(String(room?.mainPlayerEndedText || ''))) return { ...out, state: 'UNKNOWN', reason: 'LIVE_BADGE_BUT_MAIN_PLAYER_ENDED' };
    if (rid) return { ...out, state: 'LIVE', reason: roomIdChanged ? 'LIVE_ROOM_ID_CHANGED' : 'PROFILE_LIVE_BADGE_AND_ROOM_PAGE_IDENTITY' };
    return { ...out, reason: 'LIVE_BADGE_BUT_ROOM_PAGE_NOT_CROSS_VERIFIED' };
  }
  // No live badge on a verified profile. Absence alone is not offline proof.
// Never infer ended from the full body excerpt: unrelated recommendations may say '已下播'.
  const endedText = ENDED_RE.exec(String(room?.mainPlayerEndedText || ''))?.[0] || null;
  const fields = room?.statusFields || [];
  // Webcast room payloads commonly use status 4 for "ended" (unverified convention; candidate only).
  const passiveEnded = fields.some(f => /\.data.*\.status$/i.test(f.field) && Number(f.value) === 4);
  out.signals = { ...out.signals, endedText, passiveEnded, roomHttp: room?.httpStatus ?? null, statusFields: fields.slice(0, 12) };
  if (room?.httpStatus === 200 && endedText && passiveEnded) {
    if (offlineRuleValidated) return { ...out, state: 'OFFLINE', offlineEvidence: true, reason: 'NO_BADGE_ENDED_TEXT_AND_STATUS_4' };
    return { ...out, offlineCandidate: true, reason: 'OFFLINE_CANDIDATE_RULE_NOT_VALIDATED' };
  }
  return { ...out, reason: 'NO_LIVE_BADGE; not proof of offline' };
}
