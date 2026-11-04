// Passive diagnostics only. Never persist the URL query string, headers, cookies, raw payloads or secrets.
const secret = /token|cookie|sign|signature|bogus|session|secret|password|passwd|passport|captcha|verify|ticket|ttwid|odin|device_id|sec_uid|secuid|csrf|uid|user_id/i;
const stateKey = /^(status|room_status|roomStatus|stream_status|streamStatus|live_status|liveStatus|is_live|isLive|live_state|liveState|isLiving|status_code)$/;
export function sanitizeEndpoint(href) {
  try {
    const u = new URL(href);
    if (u.protocol !== 'https:' || !/(^|\.)douyin\.com$/.test(u.hostname)) return null;
    if (/passport|login|auth|token|captcha|verify|wallet|pay|account\/login/i.test(u.pathname)) return null;
    const params = [...u.searchParams.keys()];
    return {
      hostname: u.hostname,
      pathname: u.pathname.slice(0,160),
      safeQueryKeys: [...new Set(params.filter(k=>!secret.test(k)))].slice(0,12),
      sensitiveQueryPresent: params.some(k=>secret.test(k)),
      queryKeyCount: params.length
    };
  } catch {return null;}
}
export function extractStatusFields(payload) {
  const result=[];
  const seen=new WeakSet();
  let scanned=0;
  function walk(value,path,depth) {
    if (result.length>=20 || depth>7 || ++scanned>1000 || !value || typeof value!=='object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for(let i=0;i<Math.min(value.length,3);i++)walk(value[i],path+'['+i+']',depth+1);
      return;
    }
    for (const [key,v] of Object.entries(value).slice(0,60)) {
      if (secret.test(key)) continue;
      if (stateKey.test(key) && ['string','number','boolean'].includes(typeof v)) {
        const safeValue=typeof v==='string'?v.slice(0,24):v;
        if(typeof safeValue!=='string'||/^[\w.\-]{1,24}$/.test(safeValue))
          result.push({field:(path+'.'+key).slice(0,145),value:safeValue});
      } else if (v && typeof v==='object') walk(v,path+'.'+key,depth+1);
      if(result.length>=20)break;
    }
  }
  walk(payload,'$',0);
  return result;
}
export function decidePublicState(profile,room) {
  const profileVerified=profile?.httpStatus===200 && profile?.exactAccountMatch && profile?.exactDouyinIdMatch && !profile.challenge;
  const roomVerified=room?.httpStatus===200 && room?.exactRoomAccountMatch && !room.challenge;
  const profileLive=profileVerified && profile.liveAnchorMatched && profile.liveAnchorLabeled;
  if (profileLive && roomVerified) return {state:'LIVE',reason:'TWO_PUBLIC_PAGES_CORROBORATED'};
  // Absence of a live badge is not trustworthy negative evidence.
  return {state:'UNKNOWN',reason:'NO_TWO_PAGE_LIVE_PROOF; OFFLINE_NOT_VALIDATED'};
}
export function validateTargets(targets) {
  if (!Array.isArray(targets) || targets.length!==4) throw Error('Require exactly four known approved targets');
  for(const t of targets) {
    if (t.scopeApproved!==true || !/^\d{8,16}$/.test(t.displayDouyinId) || !/^\d{5,24}$/.test(t.roomId)) throw Error('Invalid target');
    const p=new URL(t.profileUrl),r=new URL(t.roomUrl);
    if(p.protocol!=='https:'||p.hostname!=='www.douyin.com'||!p.pathname.startsWith('/user/')||r.protocol!=='https:'||r.hostname!=='live.douyin.com'||r.pathname!=='/'+t.roomId) throw Error('Target url or room mismatch');
  }
  for(const key of ['key','displayDouyinId','roomId','profileUrl']) if(new Set(targets.map(t=>t[key])).size!==targets.length)throw Error('Duplicate '+key);
}
