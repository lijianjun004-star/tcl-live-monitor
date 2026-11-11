// Tmall/Taobao public guest live-detail classifier (pure; ported from the read-only
// historical branch tcl-network-diagnostic @ d4462d2, scripts/tcl-taobao-multi-shop-monitor.mjs).
// Input is the JSON/JSONP the public guest page itself requests while loading.
// No login, cookies, tokens, signature forging or request replay.

export const LIVE_PAGE = 'https://h5.m.taobao.com/taolive/video.html?userId=';
export const LIVE_DETAIL_HOST = 'h5api.m.taobao.com';
export const LIVE_DETAIL_PATH = '/h5/mtop.mediaplatform.live.livedetail/4.0/';

export function parseJSONOrJSONP(raw) {
  const text = String(raw || '').trim();
  try { return JSON.parse(text); } catch {}
  const left = text.indexOf('('), right = text.lastIndexOf(')');
  if (left < 1 || right <= left || !/^[a-zA-Z_$][\w.$]{0,63}$/.test(text.slice(0, left).trim())) throw Error('Unrecognized JSON/JSONP');
  return JSON.parse(text.slice(left + 1, right));
}

const clean = x => String(x ?? '').replace(/\s+/g, '').trim();

export function classifyTmall(payload, target) {
  const ret = Array.isArray(payload?.ret) ? payload.ret.filter(x => typeof x === 'string').slice(0, 3) : [];
  if (!ret.some(x => x.startsWith('SUCCESS'))) return { state: 'UNKNOWN', reason: 'API_ERROR', apiRet: ret.map(x => x.split('::')[0]) };
  const d = payload?.data, b = d?.broadCaster;
  if (!d || !b) return { state: 'UNKNOWN', reason: 'MISSING_BROADCASTER' };
  const roomNumber = String(b.roomNum ?? d.roomNum ?? '');
  const observed = { accountId: String(b.accountId ?? ''), name: String(b.accountName || ''), roomNumber };
  if (observed.accountId !== target.accountId || clean(observed.name) !== clean(target.displayName))
    return { state: 'UNKNOWN', reason: 'IDENTITY_MISMATCH', observed };
  if (target.roomNumber && String(target.roomNumber) !== roomNumber) return { state: 'UNKNOWN', reason: 'ROOM_MISMATCH', observed };
  if (String(d.roomNum ?? '') !== roomNumber) return { state: 'UNKNOWN', reason: 'CONFLICTING_ROOM_NUMBERS', observed };
  const validStatus=v=>(typeof v==='number'&&Number.isInteger(v))||(typeof v==='string'&&/^[012]$/.test(v));
  if(!validStatus(d.roomStatus)||!validStatus(d.streamStatus))return {state:'UNKNOWN',reason:'UNRECOGNIZED_STATUS',observed};
  const room = Number(d.roomStatus), stream = Number(d.streamStatus);
  if (![0, 1, 2].includes(room) || ![0, 1].includes(stream))
    return { state: 'UNKNOWN', reason: 'UNRECOGNIZED_STATUS', observed, roomStatus: d.roomStatus, streamStatus: d.streamStatus };
  const liveId = String(d.liveId ?? '');
  const base = { state: 'UNKNOWN', reason: 'AMBIGUOUS_STATUS', observed, roomStatus: room, streamStatus: stream,
    liveId: liveId || null, sourceStartTime: /^\d{13}$/.test(String(d.startTime ?? '')) && Number(d.startTime) > 0 ? new Date(Number(d.startTime)).toISOString() : null };
  if (room === 1 && stream === 1 && String(d.accountId) === target.accountId && /^\d{5,24}$/.test(liveId) && Number(liveId) > 0)
    return { ...base, state: 'LIVE', reason: null };
  if ((room === 0 || room === 2) && stream === 0 && (!liveId || liveId === '0'))
    return { ...base, state: 'OFFLINE', reason: null, offlineEvidence: true };
  return base;
}

/** Pick the most informative sample from all live-detail responses seen during one page load. */
export function pickBest(samples) {
  const definitive=new Set(samples.filter(x=>x.state==='LIVE'||x.state==='OFFLINE').map(x=>x.state));
  if(definitive.size>1)return {state:'UNKNOWN',reason:'CONFLICTING_LIVE_DETAIL_RESPONSES'};
  return samples.find(x => x.state === 'LIVE' || x.state === 'OFFLINE')
    || samples.find(x => x.reason === 'IDENTITY_MISMATCH') || samples.at(-1) || null;
}
