// Runs inside page.evaluate. Only rendered store content and ordinary links are read.
// Report numeric session IDs, never full share URLs, login fields or tracking parameters.
export function readJdShopPage(target) {
  const { protocol, host, pathname, searchParams } = new URL(location.href);
  const title = document.title.trim().replace(/\s+/g, ' ');
  const body = (document.body?.innerText ?? '').slice(0, 1500);
  if (/京东验证|安全验证|验证码中间页|请按照图中轨迹绘制|滑块验证|captcha/i.test(`${title} ${body}`) ||
      /验证码|滑块/i.test(title) || /captcha/i.test(pathname)) {
    return { result: 'WALLED', reason: 'HUMAN_VERIFICATION_REQUIRED' };
  }
  if (['plogin.m.jd.com', 'passport.jd.com'].includes(host) ||
      /京东登录|请登录|登录后|扫码登录/i.test(title) || /(?:扫码登录后|请先登录后)观看/.test(body)) {
    return { result: 'WALLED', reason: 'LOGIN_REQUIRED' };
  }
  if (host === 'cfe.m.jd.com' || /风控|risk/i.test(`${title} ${pathname}`)) {
    return { result: 'WALLED', reason: 'ACCESS_RESTRICTED' };
  }

  const correctRoute = protocol === 'https:' && (
    (host === 'mall.jd.com' && pathname === '/index-' + target.id + '.html') ||
    (host === 'shop.m.jd.com' && pathname === '/' && searchParams.getAll('shopId').length === 1 &&
      searchParams.get('shopId') === target.id)
  );
  if (!correctRoute) return { result: 'UNEXPECTED_DESTINATION' };

  const safeTitle = /^[\p{L}\p{N} ·_（）()【】&-]{1,100}$/u.test(title) ? title : '';
  const row = { result: 'PAGE_READ', finalHost: host, finalPath: pathname, title: safeTitle, candidateSessionIds: [] };
  if (safeTitle.replace(/\s*-\s*京东$/, '') !== target.claimedName) return row;

  const ids = new Set();
  for (const anchor of document.querySelectorAll('a[href]')) {
    if (!anchor.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) ||
        !anchor.getClientRects().length) continue;
    try {
      const url = new URL(anchor.href);
      if (url.origin !== 'https://lives.jd.com' || url.username || url.password || url.pathname !== '/') continue;
      const match = /^#\/(\d{5,16})(?:\?|$)/.exec(url.hash);
      if (match) ids.add(match[1]);
    } catch { /* Ignore non-URL anchors. */ }
  }
  row.candidateSessionIds = [...ids];
  return row;
}

export async function checkJdShops(targets, read, emit) {
  let blocked = false;
  for (const target of targets) {
    if (!/^\d{5,16}$/.test(target.id)) {
      emit({ platform: 'jd', id: target.id, result: 'INVALID_ID' });
      continue;
    }
    const channels = [
      ['mall', 'https://mall.jd.com/index-' + target.id + '.html'],
      ['m', 'https://shop.m.jd.com/?shopId=' + target.id],
    ];
    for (const [channel, url] of channels) {
      const base = { platform: 'jd-' + channel, id: target.id, claimedName: target.claimedName };
      if (blocked) {
        emit({ ...base, result: 'SKIPPED_PLATFORM_WALLED' });
        continue;
      }
      const page = await read(channel, url, target);
      if (page.result === 'WALLED' || [401, 403, 429].includes(page.http)) {
        blocked = true;
        const reason = page.reason ?? (page.http === 401 ? 'LOGIN_REQUIRED' : 'ACCESS_RESTRICTED');
        emit({ ...base, result: 'WALLED', reason, http: page.http });
      } else if (page.error || !Number.isInteger(page.http) || page.http < 200 || page.http >= 300) {
        emit({ ...base, result: 'NAV_ERROR', http: page.http ?? null });
      } else {
        emit({ ...base, ...page });
      }
    }
  }
  return blocked;
}
