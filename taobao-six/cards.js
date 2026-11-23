// Read the rendered author search results without opening any cards.
(enterFor = null) => {
  const watch = Array.isArray(enterFor) ? new Set(enterFor) : null;
  const compact = text => (text || '').replace(/\s+/g, ' ').trim();
  const visible = el => !el.closest('[hidden],[inert],[aria-hidden="true"]') &&
    el.checkVisibility({opacityProperty: true, visibilityProperty: true}) &&
    Array.from(el.getClientRects()).some(r => r.width && r.height);
  const cleanName = text => {
    const value = compact(text);
    return value.length >= 2 && value.length <= 64 && !/^(进入|主页|关注|直播中)$/.test(value) ? value : '';
  };
  const actions = new Set(['进入', '主页', '关注']);
  const markers = [];
  for (const el of document.body.querySelectorAll('*')) {
    if (el.children.length > 4 || el.textContent.length > 24 ||
        !actions.has(compact(el.textContent)) || !visible(el) ||
        el.closest('header,nav,footer,[role=navigation]')) continue;
    const label = compact(el.innerText);
    if (!actions.has(label)) continue;
    // The innermost label is enough if several nested spans repeat the same text.
    if (markers.length && markers.at(-1).el.contains(el)) markers.pop();
    markers.push({el, label});
  }
  function explicitCard(el) {
    if (el.matches('[data-anchor-card],[data-live-card],[data-testid="anchor-card"],article,li,[role=listitem]')) return true;
    return Array.from(el.classList).some(token =>
      /^(?:(?:anchor|live|streamer|user|author|account|search|result)[-_]?)*(?:card|item)(?:(?:__|--)[\w-]+|_[A-Za-z0-9]{5,})?$/i.test(token) &&
      !/(?:__|--|_)(?:title|name|btn|button|body|list|wrapper|content|action)$/i.test(token));
  }
  function cardName(card) {
    // Prefer author labels; ordinary live titles can advertise a different store.
    const descendants = [...card.querySelectorAll('*')];
    const readable = el => {
      if (!visible(el)) return '';
      return cleanName(el.getAttribute('data-anchor-name') || el.innerText);
    };
    const named = descendants.filter(el =>
      el.hasAttribute('data-anchor-name') ||
      [...el.classList].some(c => /^(?:(?:anchor|nick|user|shop|author|streamer|account)[_-]?)?name(?:$|--|__|_)/i.test(c)));
    if (card.hasAttribute('data-anchor-name')) named.unshift(card);
    const names = [...new Set(named.map(readable).filter(Boolean))];
    if (names.length) return names.length === 1 ? names[0] : '';
    const headings = descendants.filter(el => el.matches('h2,h3,h4,[role=heading]'));
    const titles = [...new Set(headings.map(readable).filter(Boolean))];
    if (titles.length) return titles.length === 1 ? titles[0] : '';
    // Only use an unlabelled text line when it clearly identifies a single store.
    const lines = card.innerText.split(/\n/).map(compact).filter(Boolean);
    const fans = lines.findIndex(line => /^(?:粉丝[:：]?\s*[\d.,万亿]+|[\d.,万亿]+\s*粉丝)$/.test(line));
    if (fans > 0 && cleanName(lines[fans - 1])) return cleanName(lines[fans - 1]);
    if (watch) {
      // A mention in an otherwise unrelated description is not the author.
      // Without metadata, accept only one non-action text line in the card.
      const labels = lines.filter(line => !actions.has(line));
      return labels.length === 1 ? cleanName(labels[0]) : '';
    }
    const storeLines = card.innerText.split(/\n/).map(cleanName)
      .filter(line => /(?:旗舰店?|专营店|专卖店|官方账号|直播间)$/.test(line));
    const stores = [...new Set(storeLines)];
    return stores.length === 1 ? stores[0] : '';
  }
  const markerElements = new Set(markers.map(m => m.el));
  function repeatedCard(el) {
    if (!el.parentElement || !el.classList.length) return false;
    return Array.from(el.parentElement.children).some(peer =>
      peer !== el && peer.tagName === el.tagName &&
      [...el.classList].some(token => peer.classList.contains(token)) &&
      [...markerElements].some(action => peer.contains(action)) &&
      cardName(el) && cardName(peer));
  }
  function boundary(el) {
    for (let box = el.parentElement; box && box !== document.body; box = box.parentElement) {
      if (box.matches('main,ul,ol,[role=list]')) break;
      if (explicitCard(box) || repeatedCard(box)) return box;
    }
    return null;
  }
  function isAction(el, card) {
    if (el.closest(':disabled,[aria-disabled=true]')) return false;
    for (let node = el; node && card.contains(node); node = node.parentElement) {
      if (node.matches('a,button,[role=button],[role=link],[onclick]') ||
          getComputedStyle(node).cursor === 'pointer' ||
          [...node.classList].some(c => /btn|button/i.test(c))) return true;
    }
    return false;
  }
  // Chrome exposes ordinary sRGB paints as rgb()/rgba(), including gradient
  // stops. Reject uncertain paints (e.g. bitmap or a newly introduced theme).
  function containsRed(css) {
    for (const match of (css || '').matchAll(/rgba?\(([^)]+)\)/gi)) {
      const values = match[1].trim().split(/[, /]+/);
      if (values.length !== 3 && values.length !== 4) continue;
      const convert = (s, scale) => parseFloat(s) * (s.endsWith('%') ? scale / 100 : 1);
      const [r, g, b] = values.slice(0, 3).map(s => convert(s, 255));
      const alpha = values.length === 4 ? convert(values[3], 1) : 1;
      if (alpha >= 0.3 && r >= 100 && r - g >= 40 && r - b >= 35 &&
          g <= r * 0.65 && b <= r * 0.75) return true;
    }
    return false;
  }
  function redEntry(label, card) {
    if (containsRed(getComputedStyle(label).color)) return true;
    for (let node = label; node && node !== card && card.contains(node); node = node.parentElement) {
      // A red card background or a sibling's red 关注 is not button evidence.
      if (compact(node.innerText) !== '进入') break;
      const s = getComputedStyle(node);
      if (containsRed(s.backgroundColor) ||
          (/gradient\(/i.test(s.backgroundImage || '') && containsRed(s.backgroundImage))) return true;
      for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
        const border = 'border' + side;
        if (parseFloat(s[border + 'Width']) > 0 &&
            !['none', 'hidden'].includes(s[border + 'Style']) &&
            containsRed(s[border + 'Color'])) return true;
      }
    }
    return false;
  }
  // Limit URL evidence to the actual button, its owning link or links inside
  // that same control. Never borrow a live or home link from a sibling card.
  function entry(el, card) {
    let control = el;
    for (let node = el; node && card.contains(node); node = node.parentElement) {
      if (node.matches('a,button,[role=button],[role=link],[onclick]') ||
          [...node.classList].some(c => /btn|button/i.test(c))) {
        control = node;
        break;
      }
    }
    const hrefs = new Set();
    const owning = el.closest('a[href]');
    if (owning) hrefs.add(owning.href);
    for (const link of control.querySelectorAll('a[href]')) hrefs.add(link.href);
    if (control.matches('a[href]')) hrefs.add(control.href);
    const concrete = [...hrefs].filter(h => {
      const url = new URL(h, document.baseURI);
      return !(url.origin === location.origin && url.pathname === location.pathname &&
               url.search === location.search && url.hash !== '');
    });
    // '#' resolves to the same document and 'javascript:void(0)' is sometimes
    // used for a native click handler. Never navigate to either value ourselves.
    const urls = concrete.filter(h => !/^javascript:void\(0\);?$/i.test(h) &&
                                        h !== location.href && h !== location.href + '#');
    const clickAllowed = !urls.length && !control.closest('form') &&
                         !control.matches('[disabled],[aria-disabled=true]');
    return {urls, click: clickAllowed ? control : null};
  }
  const groups = new Map();
  let unresolved = 0;
  for (const marker of markers) {
    const card = boundary(marker.el);
    if (!card) { if (marker.label !== '关注') unresolved++; continue; }
    if (!groups.has(card)) groups.set(card, []);
    groups.get(card).push(marker);
  }
  if (watch) {
    // Include a named card even if its controls have not rendered. This also
    // keeps two cards with the same name from being combined into one result.
    for (const label of document.body.querySelectorAll('*')) {
      if (label.closest('header,nav,footer,[role=navigation]')) continue;
      const name = compact(label.getAttribute('data-anchor-name') || label.textContent);
      if (!watch.has(name) || !visible(label)) continue;
      const card = explicitCard(label) ? label : boundary(label);
      if (card && !groups.has(card)) groups.set(card, []);
    }
    const rows = [];
    for (const [card, group] of groups) {
      const name = cardName(card);
      if (!watch.has(name)) continue;
      const signals = group.filter(marker => marker.label !== '关注');
      const enters = signals.filter(marker => marker.label === '进入');
      const homes = signals.filter(marker => marker.label === '主页');
      // Require the label's own action. A clickable ancestor spanning the
      // whole card or another shop cannot turn static copy into an action.
      function ownAction(marker) {
        if (marker.el.closest(':disabled,[disabled],[aria-disabled="true"],[inert]')) return false;
        for (let el = marker.el; el && el !== card && compact(el.innerText) === marker.label;
             el = el.parentElement) {
          if (getComputedStyle(el).pointerEvents === 'none') continue;
          if (el.matches('a[href],button,[role=button],[role=link],[onclick]') ||
              [...el.classList].some(c => /btn|button/i.test(c)) ||
              (getComputedStyle(el).cursor === 'pointer' &&
               getComputedStyle(el.parentElement).cursor !== 'pointer')) return true;
        }
        return false;
      }
      const nested = [...groups.keys()].some(other => other !== card && card.contains(other));
      let status = 'unknown';
      if (!nested && signals.every(ownAction) && enters.length <= 1 && homes.length <= 1) {
        if (enters.length) status = 'live';
        else if (homes.length) status = 'offline';
      }
      const row = {name, status};
      if (!nested && !signals.length) row.pending = true;
      if (status === 'live') {
        // Inspect only the rendered entry control, not a parent card's link,
        // sibling home buttons, app state, or another room's recommendations.
        const publicRooms = new Set();
        for (let el = enters[0].el; el && el !== card && compact(el.innerText) === '进入';
             el = el.parentElement) {
          for (const attr of ['href', 'data-href', 'data-url', 'data-live-url']) {
            const raw = el.getAttribute(attr);
            if (!raw || !raw.trim() || raw.startsWith('#') || /^javascript:/i.test(raw)) continue;
            let url;
            try { url = new URL(raw, document.baseURI); } catch { row.unverifiedHref = true; continue; }
            const ids = url.searchParams.getAll('liveId');
            if (url.origin === 'https://tbzb.taobao.com' && !url.username && !url.password &&
                /^\/live\/?$/.test(url.pathname) && ids.length === 1 &&
                /^[1-9]\d{4,19}$/.test(ids[0])) {
              publicRooms.add(url.origin + '/live?liveId=' + ids[0]);
            } else {
              row.unverifiedHref = true;
            }
          }
        }
        if (publicRooms.size) row.hrefs = [...publicRooms];
      }
      rows.push(row);
    }
    return rows;
  }
  const cards = [];
  const clicks = [];
  for (const [card, group] of groups) {
    const shared = [...groups.keys()].some(other => other !== card && card.contains(other));
    const name = cardName(card);
    const signals = group.filter(m => m.label !== '关注');
    const liveCount = signals.filter(m => m.label === '进入').length;
    if (shared || !name || !signals.length || signals.some(m => !isAction(m.el, card)) ||
        liveCount > 1 || signals.length - liveCount > 1) {
      unresolved++;
      continue;
    }
    const signal = signals.find(m => m.label === '进入');
    if (signal && !redEntry(signal.el, card)) {
      unresolved++;
      continue;
    }
    const target = signal ? entry(signal.el, card) : {urls: [], click: null};
    if (enterFor === name && target.click) clicks.push(target.click);
    cards.push({name, isLive: !!signal, hrefs: target.urls});
  }
  if (enterFor !== null) return !unresolved && clicks.length === 1 ? clicks[0] : null;
  return {cards, unresolved};
}
