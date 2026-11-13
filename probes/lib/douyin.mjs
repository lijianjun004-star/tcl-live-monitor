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
export function liveAnchorScope(profile, target) {
  const ownerAnchors=(profile?.liveRoomAnchors || [])
    .filter(a=>a?.ownerScoped===true);
  const ids=liveAnchorRoomIds({...profile,liveRoomAnchors:ownerAnchors});
  if(ids.length>1) return {scope:'AMBIGUOUS_OWNER_LIVE_ANCHORS',roomId:null};
  if(ids.length===1) return {scope:'OWNER_HEADER_LIVE_ANCHOR',roomId:ids[0]};
  // R3.23 (real run 43449924435): the owner's own "直播中" link sat outside the guessed owner
  // containers. Second, independent evidence: the WHOLE verified page shows exactly one live room
  // and it is THIS approved account's registered room. That can never lead to another account's
  // room, and the room page must still confirm the owner before LIVE.
  const all=liveAnchorRoomIds(profile);
  const registered=target?.roomId ? String(target.roomId) : null;
  if(registered && all.length===1 && all[0]===registered) return {scope:'REGISTERED_ROOM_LIVE_ANCHOR',roomId:registered};
  return {scope:'NO_OWNER_HEADER_LIVE_ANCHOR',roomId:null};
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

/**
 * R3.24 calibration, PRIVATE (encrypted) record only. Shape of the RAW server HTML of a page, read
 * before any page script runs: counts, small status integers and JSON key NAMES (letters/underscore)
 * found just before each match. Never a value, id, name, title or URL.
 */
export function documentShape(html, t) {
  const raw = typeof html === 'string' ? html : '';
  let decoded = '';
  const rd = /<script[^>]*\bid=["']RENDER_DATA["'][^>]*>([\s\S]*?)<\/script>/i.exec(raw);
  if (rd) { try { decoded = decodeURIComponent(rd[1]); } catch { decoded = ''; } }
  // Search the decoded payload instead of its encoded copy (no double counting); streamed payloads
  // hold JSON inside JS string literals, so undo one level of quote escaping.
  const text = ((decoded ? raw.replace(rd[0], '') : raw) + '\n' + decoded).replace(/\\"/g, '"');
  const keysBefore = i => [...text.slice(Math.max(0, i - 300), i).matchAll(/"([A-Za-z_]{2,24})"\s*:/g)].map(m => m[1]).slice(-8);
  const find = needle => {
    const out = { count: 0, contexts: [] };
    if (typeof needle !== 'string' || needle.length < 4) return out;
    for (let i = text.indexOf(needle); i !== -1 && out.count < 200; i = text.indexOf(needle, i + needle.length)) {
      out.count++;
      if (out.contexts.length < 5) out.contexts.push(keysBefore(i));
    }
    return out;
  };
  let sec = '';
  try { sec = new URL(t?.profileUrl).pathname.split('/').pop() || ''; } catch {}
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw)?.[1]?.trim() || '';
  const meta = /<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)/i.exec(raw)?.[1] || '';
  const name = String(t?.accountName || '');
  return {
    bytes: raw.length,
    renderData: Boolean(rd), renderDataDecoded: decoded.length > 0,
    paceScripts: (raw.match(/<script[^>]*>[^<]{0,80}__pace_f/g) || []).length,
    titleTagEmpty: title === '', titleTagHasName: name.length > 0 && title.includes(name),
    metaTagPresent: meta !== '', metaTagHasName: name.length > 0 && meta.includes(name),
    secUid: find(sec), roomId: find(t?.roomId ? String(t.roomId) : ''),
    displayId: find(t?.displayDouyinId ? String(t.displayDouyinId) : ''), accountName: find(name),
    status: [...text.matchAll(/"((?:live_|room_)?status)"\s*:\s*(\d{1,2})(?!\d)/g)].slice(0, 16)
      .map(m => ({ key: m[1], value: Number(m[2]), before: keysBefore(m.index) })),
    endedText: ENDED_RE.test(raw + decoded), loginGateText: LOGIN_GATE_RE.test(raw + decoded),
    // R3.25: does the raw page mention live replays at all? Count of the wording and key NAMES only.
    replayText: (text.match(/直播回放/g) || []).length,
    replayKeys: [...new Set([...text.matchAll(/"([A-Za-z_]{0,24}replay[A-Za-z_]{0,24})"\s*:/gi)].map(m => m[1]))].filter(k => k.length <= 32).slice(0, 10),
  };
}

/**
 * R3.26: room identity from the RAW server HTML of the room page (no page script needed).
 * Shape seen in approved run 43464891978: roomStore.roomInfo.room{id_str,status,...,owner{sec_uid}} and
 * {roomId,web_rid,anchor{sec_uid}}. Returns booleans and the small status integer only. Fail closed.
 */
export function rawRoomEvidence(html, t, roomId) {
  const out = { forRoomId: roomId ? String(roomId) : null, present: false, webRidExact: false, ownerExact: false, anchorExact: false, status: null };
  const raw = typeof html === 'string' ? html : '';
  let sec = '';
  try { sec = new URL(t?.profileUrl).pathname.split('/').pop() || ''; } catch {}
  if (!raw || sec.length < 8 || !/^\d{5,24}$/.test(String(roomId || ''))) return out;
  let decoded = '';
  const rd = /<script[^>]*\bid=["']RENDER_DATA["'][^>]*>([\s\S]*?)<\/script>/i.exec(raw);
  if (rd) { try { decoded = decodeURIComponent(rd[1]); } catch { decoded = ''; } }
  // Streamed chunks nest JSON in JS strings, possibly more than once: drop any backslashes before a quote.
  const text = (raw + '\n' + decoded).replace(/\\+"/g, '"');
  // Any roomStore occurrence may be the data one (others can be code or chunk names): take the first
  // that is directly followed by roomInfo.room{id_str,status}.
  const ROOM = /"roomStore"\s*:\s*\{[\s\S]{0,600}?"roomInfo"\s*:\s*\{[\s\S]{0,600}?"room"\s*:\s*\{[\s\S]{0,200}?"status"\s*:\s*(\d{1,2})(?!\d)/g;
  let room = null, start = -1;
  for (const m of text.matchAll(ROOM)) { if (!/[{}]/.test(m[0].slice(m[0].lastIndexOf('"room"')).replace(/^"room"\s*:\s*\{/, '').replace(/"[^"]*"/g, ''))) { room = m; start = m.index; break; } }
  if (!room) return out;
  const win = text.slice(start, start + 900000);
  room = { 1: room[1], index: 0 };
  out.present = true; out.status = Number(room[1]);
  // The room object's own owner: the first owner object after the room starts.
  const owner = /"owner"\s*:\s*\{[^{}]{0,200}?"sec_uid"\s*:\s*"([^"]{1,200})"/.exec(win.slice(room.index));
  out.ownerExact = owner?.[1] === sec;
  // Every {web_rid, anchor} pair for THIS room number must name this account; none may name another.
  const pairs = [...win.matchAll(/"web_rid"\s*:\s*"(\d{5,24})"\s*,[^{}]{0,200}?"anchor"\s*:\s*\{[^{}]{0,200}?"sec_uid"\s*:\s*"([^"]{1,200})"/g)];
  const mine = pairs.filter(m => m[1] === String(roomId));
  out.webRidExact = mine.length > 0;
  out.anchorExact = mine.length > 0 && mine.every(m => m[2] === sec);
  return out;
}
/** PRIVATE (encrypted) record only: JSON key skeletons near each "roomStore", every value and digit masked. */
export function roomStoreSkeleton(html) {
  const text = (typeof html === 'string' ? html : '').replace(/\\+"/g, '"');
  // Values cut by the slice edges are dropped too: leading fragment up to the first key, trailing open value.
  const mask = x => x.replace(/^[^{]*?(?=[,{]"[A-Za-z_]+":)/, '').replace(/:\s*"[^"]*"/g, ':"S"').replace(/:\s*"[^"]*$/, ':"S').replace(/\d/g, '9').replace(/[^\x20-\x7e]/g, 'U');
  const out = { occurrences: 0, samples: [], owner: [], anchor: [] };
  for (let i = text.indexOf('"roomStore"'); i !== -1 && out.occurrences < 50; i = text.indexOf('"roomStore"', i + 1)) {
    out.occurrences++;
    if (out.samples.length < 6) out.samples.push(mask(text.slice(Math.max(0, i - 40), i + 260)));
  }
  for (const [k, arr] of [['"owner":{', out.owner], ['"anchor":{', out.anchor], ['"web_rid"', out.anchor]])
    for (let i = text.indexOf(k), n = 0; i !== -1 && n < 3; i = text.indexOf(k, i + 1), n++) arr.push(mask(text.slice(Math.max(0, i - 60), i + 200)));
  return out;
}
/** True only when every raw-HTML identity signal holds for the room that was actually checked. */
export function rawRoomIdentity(room, observedRoomId) {
  const e = room?.raw;
  return Boolean(e && observedRoomId && e.forRoomId === String(observedRoomId) && e.present && e.webRidExact && e.ownerExact && e.anchorExact);
}

/** Booleans only, for the public receipt: which room-page identity signal held. */
export function roomIdentityEvidence(r, t) {
  const title = String(r?.title || '');
  return { httpOk: r?.httpStatus === 200, titleEmpty: title.trim() === '',
    titleExact: title === `${t?.accountName}的抖音直播间 - 抖音直播`,
    metaExact: String(r?.metaDescription || '').startsWith(`欢迎来到${t?.accountName}的抖音直播间`),
    ownerLinkExact: strictRoomOwnerVerified(r, t),
    rawPresent: r?.raw?.present === true, rawWebRidExact: r?.raw?.webRidExact === true, rawOwnerExact: r?.raw?.ownerExact === true,
    rawAnchorExact: r?.raw?.anchorExact === true, rawStatus: Number.isInteger(r?.raw?.status) ? r.raw.status : null };
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
  const ownerScope=liveAnchorScope(profile, t);
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
    // R3.26: the room page did not render, but its RAW server HTML names this account as owner and anchor
    // of exactly this room. Only the strict path, only on the exact room URL, never when gated.
    const rawOk = strictRoomOwner && room?.httpStatus === 200 && room?.finalHost === 'live.douyin.com' && room?.finalPath === '/' + observedRoomId
      && !LOGIN_GATE_RE.test(String(room?.bodyExcerpt || '')) && rawRoomIdentity(room, observedRoomId);
    if (rawOk && room.raw.status === 2) return { ...out, state: 'LIVE', roomPageIdentityVerified: true,
      reason: roomIdChanged ? 'LIVE_ROOM_ID_CHANGED' : 'PROFILE_LIVE_BADGE_AND_ROOM_RAW_HTML_IDENTITY' };
    if (rawOk) return { ...out, roomPageIdentityVerified: true, reason: 'ROOM_RAW_HTML_STATUS_NOT_LIVE' };
    return { ...out, reason: 'LIVE_BADGE_BUT_ROOM_PAGE_NOT_CROSS_VERIFIED' };
  }
  // A live link IS on the verified page but could not be tied to this account: say so (it is not
  // "no live badge"), never visit or count it.
  if (strictRoomOwner && liveAnchorRoomIds(profile).length > 0) return { ...out, reason: 'LIVE_BADGE_OUTSIDE_OWNER_SCOPE' };
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
  return { ...out, reason: 'NO_LIVE_BADGE_NOT_PROOF_OF_OFFLINE' };
}
