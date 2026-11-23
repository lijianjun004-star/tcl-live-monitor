// Read the rendered author search results without opening any cards.
() => {
  const compact = text => (text || '').replace(/\s+/g, ' ').trim();
  const visible = el => !el.closest('[hidden],[inert],[aria-hidden="true"]') &&
    el.checkVisibility({opacityProperty: true, visibilityProperty: true}) &&
    Array.from(el.getClientRects()).some(r => r.width && r.height);
  const cleanName = text => {
    const value = compact(text);
    return value.length >= 2 && value.length <= 64 && !/^(进入|主页|关注|直播中)$/.test(value) ? value : '';
  };
  const actions = new Set(['进入', '主页']);
  const markers = [];
  for (const el of document.body.querySelectorAll('*')) {
    if (el.children.length > 4 || el.textContent.length > 24 ||
        !actions.has(compact(el.textContent)) || !visible(el) ||
        el.closest('header,nav,footer,[role=navigation],:disabled,[aria-disabled=true]')) continue;
    const label = compact(el.innerText);
    if (!actions.has(label)) continue;
    // The innermost label is enough if several nested spans repeat the same text.
    if (markers.length && markers.at(-1).el.contains(el)) markers.pop();
    markers.push({el, live: label === '进入'});
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
  const groups = new Map();
  let unresolved = 0;
  for (const marker of markers) {
    const card = boundary(marker.el);
    if (!card) { unresolved++; continue; }
    if (!groups.has(card)) groups.set(card, []);
    groups.get(card).push(marker);
  }
  const cards = [];
  for (const [card, group] of groups) {
    const shared = [...groups.keys()].some(other => other !== card && card.contains(other));
    const name = cardName(card);
    const liveCount = group.filter(m => m.live).length;
    if (shared || !name || liveCount > 1 || group.length - liveCount > 1) {
      unresolved++;
      continue;
    }
    cards.push({name, live: liveCount === 1});
  }
  return {cards, unresolved};
}
