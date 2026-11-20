"""Expand the three public share links with an isolated Chromium context."""
import asyncio
import re
from urllib.parse import parse_qsl, urljoin, urlsplit


NUMBER = r"[1-9][0-9]{4,17}"
ROOTS = ("3.cn", "jd.com", "360buyimg.com", "jdcdn.com")
STATIC_SEGMENTS = set(
    "product goods item detail ware view action index index.html live lives replay "
    "room player home h5 activity babelDiy Zeus mobile redirect jump share "
    "openapp login passport verify captcha security".split()
)
KNOWN_HOSTS = set(
    "3.cn u.jd.com item.jd.com item.m.jd.com wqitem.jd.com lives.jd.com "
    "h5.m.jd.com m.jd.com wq.jd.com go.m.jd.com union-click.jd.com "
    "plogin.m.jd.com passport.jd.com api.m.jd.com".split()
)
PARAM_KEYS = set(
    "sku skuId sku_id wareId wareid liveId liveid live_id roomId roomid "
    "activityId bizId id scene source from url returnurl returnUrl redirectUrl "
    "jumpUrl babelChannel t tt ts shareToken shareId shareCode shareUuid "
    "utm_source utm_medium utm_campaign utm_term utm_content ad_od "
    "gx cjhyUuid jxsid un_area ptag ext unionId positionId".split()
)
MEDIA_PATH = re.compile(r"\.(?:m3u8|mpd|ts|m4s|mp4|webm|flv|aac|mp3|m4a)(?:$|/)", re.I)
GATE_PATH = re.compile(r"(?:^|/)(?:login|passport|captcha|verify|verification|slidecaptcha)(?:[./]|$)", re.I)
GATE_JS = """() => {
  const text = ((document.title || '') + '\\n' +
    ((document.body && document.body.innerText) || '').slice(0, 4000)).trim();
  if (/拖动.{0,12}(滑块|拼图)|滑动.{0,10}(验证|拼图)|请.{0,8}(完成|通过).{0,10}(安全|人机)验证|请按照图中轨迹绘制|安全验证|访问受限|访问过于频繁|captcha challenge/i.test(text)) return 'challenge';
  if (/^(京东登录|登录京东|京东用户登录)/.test(document.title) ||
      /请先登录|登录后.{0,12}(访问|继续|查看)|手机号.{0,8}(登录|注册)/.test(text) && text.length < 850) return 'login_wall';
  return null;
}"""
# Read only explicit single-purpose entry links from public share/relay pages.
# Validate the destination route in Python before treating it as evidence.
ENTRY_JS = """(role) => {
  const label = role === 'product'
    ? /^(?:查看商品|进入商品详情|查看商品详情|打开商品详情|去商品详情页)$/
    : /^(?:进入直播间|进入当前直播间|去直播间|观看直播|查看直播间|当前商品直播中|去直播间观看)$/;
  const omit = '[class*="recommend" i],[id*="recommend" i],[class*="guess" i],nav,aside,footer';
  return Array.from(document.querySelectorAll('a[href]')).slice(0, 200).filter(a => {
    if (a.closest(omit) || a.getClientRects().length === 0) return false;
    const text = (a.innerText || a.getAttribute('aria-label') || '').replace(/\\s+/g, '');
    return label.test(text);
  }).slice(0, 8).map(a => a.href);
}"""
SHARE_HOSTS = {"3.cn", "u.jd.com", "go.m.jd.com", "h5.m.jd.com", "m.jd.com"}


def permitted(url):
    try:
        p = urlsplit(url)
        return (
            p.scheme in {"http", "https"} and p.username is None and p.password is None
            and p.port in {None, 80, 443} and p.hostname is not None
            and any(p.hostname == root or p.hostname.endswith("." + root) for root in ROOTS)
        )
    except ValueError:
        return False


def route_shape(url):
    p = urlsplit(url)
    host = p.hostname
    if host not in KNOWN_HOSTS:
        host = next(("*." + root for root in ROOTS if host and (host == root or host.endswith("." + root))), "other")
    path, _, frag_query = p.fragment.partition("?")
    def pattern(value):
        segments = value.split("/")[:12]
        return "/".join(
            s if not s or s in STATIC_SEGMENTS else
            "{id}.html" if re.fullmatch(NUMBER + r"\.html", s) else
            "{id}" if re.fullmatch(NUMBER, s) else "{segment}"
            for s in segments
        )
    def keys(value):
        return sorted({k if k in PARAM_KEYS else "{other}" for k, _ in parse_qsl(value[:8192], keep_blank_values=True)})[:32]
    return {"host": host, "path": pattern(p.path), "query_keys": keys(p.query),
            "fragment_path": pattern(path), "fragment_query_keys": keys(frag_query)}


def identifiers(role, url):
    if not permitted(url):
        return set(), None
    p = urlsplit(url)
    frag, _, frag_query = p.fragment.partition("?")
    if role == "product":
        if p.hostname not in {"item.jd.com", "item.m.jd.com", "wqitem.jd.com", "wq.jd.com"}:
            return set(), None
        match = re.fullmatch(r"/(?:product/)?(" + NUMBER + r")\.html/?", p.path)
        selected = {"skuid", "sku_id", "wareid", "sku"}
        source = "product_url"
    else:
        if p.hostname == "lives.jd.com":
            match = re.fullmatch(r"/(" + NUMBER + r")(?:/(?:live|replay))?/?", frag) if p.path in {"", "/"} else None
            if match:
                return {match.group(1)}, "live_fragment"
        match = None
        if p.hostname not in {"lives.jd.com", "h5.m.jd.com", "m.jd.com"}:
            return set(), None
        selected = {"liveid", "live_id"}
        source = "live_query"
    if match:
        return {match.group(1)}, source
    pairs = parse_qsl(p.query[:8192]) + parse_qsl(frag_query[:8192])
    return {v for k, v in pairs if k.lower() in selected and re.fullmatch(NUMBER, v)}, source + "_field"


def url_gate(url):
    p = urlsplit(url)
    host = p.hostname or ""
    if host.split(".")[0] in {"passport", "plogin", "login"} or re.search(r"(?:^|/)login(?:[./]|$)", p.path, re.I):
        return "login_wall"
    if host.split(".")[0] in {"captcha", "jcap", "verify"} or GATE_PATH.search(p.path):
        return "challenge"
    return None


async def resolve(browser, role, url):
    """Follow natural HTTP and same-document navigation. Return only masked evidence."""
    result = {"role": role, "status": "unresolved", "sku_id": None, "live_id": None,
              "identity_status": "unresolved", "id_source": None, "landing_route": None, "navigation": [], "http_status": None}
    if role not in {"product", "clip", "control"} or not permitted(url) or urlsplit(url).hostname != "3.cn":
        result["status"] = "invalid_input"
        return result

    context = None
    gate = None
    observed = []
    def record(link, origin):
        if not permitted(link):
            return
        shape = route_shape(link)
        if origin not in {"document_canonical", "advertised_share_entry"}:
            result["landing_route"] = shape
            nav = result["navigation"]
            if len(nav) < 24 and (not nav or nav[-1] != shape):
                nav.append(shape)
        if gate or url_gate(link):
            return
        ids, source = identifiers(role, link)
        if origin == "advertised_share_entry" and source not in {"product_url", "live_fragment"}:
            return
        if ids:
            item = (ids, source, origin)
            if item not in observed:
                observed.append(item)

    try:
        context = await browser.new_context(service_workers="block", accept_downloads=False, locale="zh-CN")
        page = await context.new_page()
        session = await context.new_cdp_session(page)
        root_frame = (await session.send("Page.getFrameTree"))["frameTree"]["frame"]["id"]
        async def intercept(event):
            nonlocal gate
            rid = event["requestId"]
            req = event["request"]
            target = req["url"] + (req.get("urlFragment", "") if "#" not in req["url"] else "")
            doc = event["resourceType"] == "Document" and event.get("frameId") == root_frame
            allowed = permitted(target)
            if doc:
                if allowed:
                    record(target, "document_request")
                gate = gate or (url_gate(target) if allowed else "external_redirect")
            blocked = gate or not allowed or req["method"] not in {"GET", "HEAD"} or (
                event["resourceType"] in {"Media", "Image", "Font", "Ping", "WebSocket"}
                or MEDIA_PATH.search(urlsplit(target).path)
            )
            try:
                if blocked:
                    await session.send("Fetch.failRequest", {"requestId": rid, "errorReason": "BlockedByClient"})
                else:
                    await session.send("Fetch.continueRequest", {"requestId": rid})
            except Exception:
                # An in-flight event can be delivered while the context closes.
                pass

        def commit(frame):
            if frame == page.main_frame:
                record(frame.url, "committed_navigation")
        def response(resp):
            nonlocal gate
            req = resp.request
            if req.is_navigation_request() and req.frame == page.main_frame:
                result["http_status"] = resp.status
                if resp.status in {301, 302, 303, 307, 308}:
                    location = resp.headers.get("location")
                    if location:
                        record(urljoin(resp.url, location), "http_redirect_target")
                if resp.status in {401, 403, 429}:
                    gate = gate or "http_access_restriction"

        session.on("Fetch.requestPaused", intercept)
        await session.send("Fetch.enable", {"patterns": [{"urlPattern": "*", "requestStage": "Request"}]})
        page.on("framenavigated", commit)
        page.on("response", response)
        navigation_error = None
        try:
            await page.goto(url, wait_until="commit", timeout=20000)
        except Exception as exc:
            navigation_error = "navigation_timeout" if type(exc).__name__ == "TimeoutError" else "navigation_error"
        if not navigation_error and not gate:
            for _ in range(16):
                if gate:
                    break
                try:
                    visible_gate = await page.evaluate(GATE_JS)
                    gate = gate or visible_gate
                except Exception:
                    # A JavaScript redirect can destroy the context being evaluated.
                    pass
                if gate:
                    break
                await asyncio.sleep(0.35)
        if permitted(page.url) and not gate:
            record(page.url, "final_location")
            if not navigation_error and (result["http_status"] is None or result["http_status"] < 400):
                try:
                    canonical = await page.eval_on_selector_all(
                        'link[rel="canonical"], meta[property="og:url"]',
                        "(nodes) => nodes.slice(0,4).map(n=>n.href || n.content || '')"
                    )
                    for link in canonical:
                        record(link, "document_canonical")
                    if urlsplit(page.url).hostname in SHARE_HOSTS:
                        for link in await page.evaluate(ENTRY_JS, role):
                            record(link, "advertised_share_entry")
                except Exception:
                    pass
        if observed:
            weights = {"live_fragment": 2, "product_url": 2}
            best = max(weights.get(source, 1) for _, source, _ in observed)
            preferred = [item for item in observed if weights.get(item[1], 1) == best]
            preferred_ids = set().union(*(item[0] for item in preferred))
            if len(preferred_ids) == 1:
                result["sku_id" if role == "product" else "live_id"] = preferred_ids.pop()
                evidence_order = ("advertised_share_entry", "document_canonical", "document_request",
                                  "http_redirect_target", "committed_navigation", "final_location")
                _, structure, location = max(preferred, key=lambda entry: evidence_order.index(entry[2]))
                result["id_source"] = {"structure": structure, "location": location}
                result["identity_status"] = "resolved"
            else:
                result["identity_status"] = "ambiguous_id"
        if gate:
            result["status"] = gate
        elif result["http_status"] is not None and result["http_status"] >= 400:
            result["status"] = "http_error"
        else:
            result["status"] = navigation_error or result["identity_status"]
    except Exception:
        result["status"] = gate or "resolver_error"
    finally:
        if context:
            await context.close()
    return result
