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

export function profileIdentity(p, t) {
  if (p?.httpStatus !== 200 || CHALLENGE_RE.test(`${p.title} ${p.bodyExcerpt}`)) return false;
  const title = String(p.title || '').trim();
  const allowedTitles = new Set([
    `${t.accountName}的抖音 - 抖音`,
    `${t.accountName}的主页 - 抖音`,
    ...(Array.isArray(t?.alternateTitles) ? t.alternateTitles : []),
  ]);
  if (!allowedTitles.has(title)) return false;
  // Exact token match only: "抖音号：14145381" must not match "抖音号：141453819".
  const id = String(t.displayDouyinId || '');
  const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const exact = new RegExp(`抖音号[:：]\\s*${esc}(?![A-Za-z0-9._-])`);
  return (p.douyinIdsInPage || []).includes(id) || exact.test(String(p.bodyExcerpt || ''));
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
export function decideDouyin(profile, room, t, { offlineRuleValidated = false } = {}) {
  const challenged = CHALLENGE_RE.test(`${profile?.title} ${profile?.bodyExcerpt}`) || CHALLENGE_RE.test(`${room?.title} ${room?.bodyExcerpt}`);
  const pid = profileIdentity(profile, t);
  const anchors = pid ? liveAnchorRoomIds(profile) : [];
  const observedRoomId = anchors[0] || null;
  const rid = roomIdentity(room, t);
  const roomIdChanged = !!observedRoomId && observedRoomId !== t.roomId;
  const out = { state: 'UNKNOWN', reason: null, profileIdentityVerified: pid, roomPageIdentityVerified: rid,
    observedRoomId, roomIdChanged, offlineCandidate: false, signals: {} };
  if (challenged) return { ...out, reason: 'PUBLIC_GUEST_ACCESS_CHALLENGED' };
  if (!pid) return { ...out, reason: 'PROFILE_IDENTITY_NOT_VERIFIED' };
  if (observedRoomId) {
    if (rid) return { ...out, state: 'LIVE', reason: roomIdChanged ? 'LIVE_ROOM_ID_CHANGED' : 'PROFILE_LIVE_BADGE_AND_ROOM_PAGE_IDENTITY' };
    return { ...out, reason: 'LIVE_BADGE_BUT_ROOM_PAGE_NOT_CROSS_VERIFIED' };
  }
  // No live badge on a verified profile. Absence alone is not offline proof.
  const endedText = ENDED_RE.exec(String(room?.bodyExcerpt || ''))?.[0] || null;
  const fields = room?.statusFields || [];
  // Webcast room payloads commonly use status 4 for "ended" (unverified convention; candidate only).
  const passiveEnded = fields.some(f => /\.data.*\.status$/i.test(f.field) && Number(f.value) === 4);
  out.signals = { endedText, passiveEnded, roomHttp: room?.httpStatus ?? null, statusFields: fields.slice(0, 12) };
  if (rid && endedText && passiveEnded) {
    if (offlineRuleValidated) return { ...out, state: 'OFFLINE', offlineEvidence: true, reason: 'NO_BADGE_ENDED_TEXT_AND_STATUS_4' };
    return { ...out, offlineCandidate: true, reason: 'OFFLINE_CANDIDATE_RULE_NOT_VALIDATED' };
  }
  return { ...out, reason: 'NO_LIVE_BADGE; not proof of offline' };
}
