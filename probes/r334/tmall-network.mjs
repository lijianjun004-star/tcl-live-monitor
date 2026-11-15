// Pure helpers for passive observation of the public guest page. No request replay.
const DETAIL_HOST = 'h5api.m.taobao.com';
const DETAIL_PATH = '/h5/mtop.mediaplatform.live.livedetail/4.0';
export function isLiveDetailUrl(value) {
  try {
    const u = new URL(value);
    return u.hostname === DETAIL_HOST && u.pathname.replace(/\/$/, '') === DETAIL_PATH;
  } catch { return false; }
}
export function responseLimit({ url, status, navigation = false }) {
  return [401, 403, 429].includes(status) && (navigation || isLiveDetailUrl(url)) ? `HTTP_${status}` : null;
}
export function selectTargets(targets, key) {
  if (!Array.isArray(targets)) throw Error('TMALL_TARGET_LIMIT');
  if (key === undefined || key === '') return targets;
  const selected = targets.filter(t => t.key === key);
  if (selected.length !== 1) throw Error('TMALL_SINGLE_TARGET_NOT_REGISTERED');
  return selected;
}
export function endpointEvidence(value, status) {
  try {
    const u = new URL(value);
    if (u.hostname !== DETAIL_HOST || !/^\/h5\/mtop\.[a-z0-9._-]{1,160}\/\d+\.\d+\/?$/.test(u.pathname)) return null;
    return { path: u.pathname, http: status };
  } catch { return null; }
}
