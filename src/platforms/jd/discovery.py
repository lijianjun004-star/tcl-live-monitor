"""JD discovery layer (B): direct ids, 3.cn links, H5 SKU pages and the shop entry hook.

The block between the ``verbatim`` markers is copied unchanged from
experiments/jd_sku_live/discovery.py. ``observe_h5`` is that file's ``observe()`` with the PC
variant removed (defect B-1) and its inline interception replaced by JdDiscoveryPolicy (defect B-2).
"""

from __future__ import annotations

import asyncio
import json
import re
from collections import Counter
from urllib.parse import parse_qs, urljoin, urlsplit

from core.base import DiscoveryEngine, RunContext
from core.config import JD_GROUP, Target
from core.errors import Code
from core.models import Resolution
from core.network import GateLatch, NetworkAudit, install_policy
from core.runtime import bounded_map, guarded

from . import short_link
from .policy import ACCESS_HOSTS, PRIVATE, JdDiscoveryPolicy, func_id, jd_host

# --- verbatim: experiments/jd_sku_live/discovery.py ------------------------------------------
DIGITS = re.compile(r"[1-9][0-9]{3,19}\Z")
NUMBERS = re.compile(r"(?<![0-9])[1-9][0-9]{3,19}(?![0-9])")
JSONP = re.compile(r"(?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$][\w$]*\s*\((.*)\)\s*;?\s*\Z", re.S)
LIMIT_BODY = 2_000_000
MAX_RESPONSES = 80
MAX_NUMBERS = 40_000
MAX_CANDIDATES = 500

ACCESS_JS = """() => {
 const visible = el => !!(el && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
 const text = (document.body?.innerText || '').slice(0, 12000);
 if (/安全验证|滑动验证|拖动滑块|完成拼图|访问受限|访问过于频繁|请完成验证|人机验证/.test(document.title) ||
     /拖动滑块|向右滑动.{0,10}验证|完成安全验证|拖动.{0,10}完成拼图|访问过于频繁|请完成以下验证/.test(text) ||
     [...document.querySelectorAll('iframe[src*="jcap."], [id*="captcha"] canvas')].some(visible)) return 'challenge';
 if (/京东登录|京东登陆|登录京东/.test(document.title) ||
     /请(?:先)?登录(?:后)?(?:再|以)?(?:查看商品|查看详情|访问本页)/.test(text) ||
     [...document.querySelectorAll('input[type=password]')].some(visible)) return 'login_wall';
 return null;
}"""
PRODUCT_JS = """() => {
 const text = (document.body?.innerText || '').slice(0, 14000);
 const signals = [];
 if (document.querySelector('.sku-name, #sku-name, [class*=skuName], [class*=productName], [itemtype*="schema.org/Product"], meta[property="og:type"][content*="product"]')) signals.push('product_markup');
 if (document.title.length > 5 && /TCL|空调|挂[机式]|立[柜式]/i.test(document.title)) signals.push('product_title');
 if (/加入购物车|立即购买|商品详情|商品介绍/.test(text) && /[￥¥]|价格|评价|规格参数/.test(text)) signals.push('product_controls');
 return signals;
}"""
LIVE_UI_JS = """() => {
 const text = document.body?.innerText || '';
 return [['current_product_live', /当前商品直播中/], ['product_live_clip', /商品直播切片/],
         ['watch_live', /看直播|进入直播间/], ['live_now', /正在直播|直播中/]]
   .filter(([,pat]) => pat.test(text)).map(([name]) => name);
}"""
HYDRATION_JS = """() => {
 const payloads = [];
 let bytes = 0, truncated = false;
 for (const el of document.querySelectorAll('script[type="application/json"],script[type="application/ld+json"]')) {
   const text = el.textContent || '';
   if (text.length > 750000 || bytes + text.length > 1500000 || payloads.length >= 16) {
     truncated = true; continue;
   }
   bytes += text.length;
   payloads.push(text);
 }
 return {payloads, truncated};
}"""
LINKS_JS = """() => Array.from(document.querySelectorAll(
 'a[href],area[href],[data-live-id],[data-liveid],[data-live-room-id],[data-room-id],[data-live-url],[data-url],[data-href],[data-jump-url]'
 )).slice(0, 2000).flatMap(el => {
  const rows = [];
  const contextual = el.hasAttribute('data-live-url') || /直播|live/i.test(
    ((el.innerText || '').slice(0, 100)) + ' ' + (el.className || '') + ' ' + (el.getAttribute('aria-label') || ''));
  if (el.href && typeof el.href === 'string' && el.href.length < 8192) rows.push(['href', el.href]);
  for(const key of ['data-live-id','data-liveid','data-live-room-id']) {
   if(el.hasAttribute(key)) rows.push([key, el.getAttribute(key)]);
  }
  if(contextual && el.hasAttribute('data-room-id')) rows.push(['data-room-id', el.getAttribute('data-room-id')]);
  for(const key of ['data-live-url','data-url','data-href','data-jump-url']) {
   const val = el.getAttribute(key);
   if(contextual && val && val.length < 8192) rows.push(['live_entry_href', val]);
  }
  return rows;
 })"""


def parse_url(value):
    try:
        parts = urlsplit(value)
        return parts, (parts.hostname or '').lower()
    except ValueError:
        return None, ''


def sku_page_url(url, sku):
    parts, host = parse_url(url)
    if not parts or host not in {'item.jd.com', 'item.m.jd.com'}:
        return False
    return bool(re.search(r'(?<![0-9])' + re.escape(sku) + r'(?![0-9])', parts.path)
                or any(sku in vals for key, vals in parse_qs(parts.query).items()
                       if key.lower() in {'wareid', 'sku', 'skuid'}))


def landing_route(url, sku):
    parts, host = parse_url(url)
    if not parts:
        return None
    known = {'item.m.jd.com', 'item.jd.com', 'www.jd.com', 'm.jd.com', 'wqs.jd.com',
             'item-soa.jd.com', 'pro.m.jd.com', '3.cn', *ACCESS_HOSTS}
    literals = {'index', 'index.html', 'product', 'ware', 'view.action', 'home', 'detail', 'error',
                'login', 'login.aspx', 'new', 'entrance.action', 'verify', 'captcha', 'redirect',
                'sorry.html', '404.html', 'item', 'notfound', 'risk', 'error.html', 'search'}
    def segment(s):
        if s in {sku, sku + '.html'}:
            return '{sku}' + ('.html' if s.endswith('.html') else '')
        return s.lower() if s.lower() in literals else '{segment}'
    return {'host': host if host in known else ('other_jd_host' if jd_host(host) else 'other'),
            'path_shape': '/' + '/'.join(segment(x) for x in parts.path.split('/')[:12] if x),
            'query_keys': sorted(set(parse_qs(parts.query)).intersection(
                {'wareId', 'sku', 'skuId', 'id', 'returnurl', 'returnUrl', 'from', 'source', 'url'})),
            'has_fragment': bool(parts.fragment)}


def json_value(raw):
    text = raw.decode('utf-8-sig').strip()
    try:
        return json.loads(text)
    except ValueError:
        match = JSONP.fullmatch(text)
        if match:
            return json.loads(match[1])
        raise


class Evidence:
    def __init__(self):
        self.candidates = {}
        self.numbers = {}
        self.truncated = set()

    def record(self, identifier, source, *, candidate=False):
        if not DIGITS.fullmatch(identifier):
            return
        table, limit = (self.candidates, MAX_CANDIDATES) if candidate else (self.numbers, MAX_NUMBERS)
        if identifier not in table and len(table) >= limit:
            self.truncated.add('candidate_limit' if candidate else 'numeric_observation_limit')
            return
        table.setdefault(identifier, set()).add(source)

    def link(self, value, source, base=None):
        if not isinstance(value, str) or len(value) > 8192:
            return
        if base:
            value = urljoin(base, value)
        elif value.startswith('//'):
            value = 'https:' + value
        parts, host = parse_url(value)
        if not parts or parts.scheme not in ('https', 'http') or not jd_host(host):
            return
        route, _, fragment_query = parts.fragment.partition('?')
        if host == 'lives.jd.com':
            for path in (route, parts.path):
                match = re.fullmatch(r'/?([1-9][0-9]{3,19})(?:/(?:live|replay))?/?', path)
                if match:
                    self.record(match[1], source + ('public_live_route',), candidate=True)
        # Ignore free-form tracking and share parameters, even in ordinary JD hrefs.
        for key, vals in parse_qs('&'.join((parts.query, fragment_query))).items():
            canonical = key.lower().replace('_', '')
            if canonical in {'liveid', 'liveroomid'} or canonical == 'roomid' and host == 'lives.jd.com':
                for identifier in vals:
                    self.record(identifier, source + ('live_url_parameter',), candidate=True)
            if canonical in {'id', 'activityid', 'videoid', 'roomid', 'skuid', 'wareid', 'channelid'}:
                for identifier in vals:
                    self.record(identifier, source + ('public_url_numeric_parameter',))
        for identifier in NUMBERS.findall(parts.path + '/' + route):
            self.record(identifier, source + ('url_path_number',))

    def payload(self, data, source):
        todo = [(None, data, False, 0)]
        visited = 0
        while todo:
            key, node, live_context, depth = todo.pop()
            visited += 1
            if visited > 80_000:
                self.truncated.add('json_node_limit')
                break
            if depth > 40:
                self.truncated.add('json_depth_limit')
                continue
            if isinstance(node, dict):
                for name, value in node.items():
                    if isinstance(name, str) and not PRIVATE.search(name):
                        todo.append((name, value, live_context or 'live' in name.lower(), depth + 1))
            elif isinstance(node, list):
                todo.extend((key, value, live_context, depth + 1) for value in node)
            elif isinstance(node, (str, int)) and not isinstance(node, bool):
                val = str(node)
                flag = (key or '').replace('_', '').lower()
                if flag in {'liveid', 'liveroomid'} or live_context and flag == 'roomid':
                    self.record(val, source + ('live_id_field',), candidate=True)
                if val.startswith(('https://', 'http://', '//')):
                    self.link(val, source)
                elif len(val) < 8192:
                    for identifier in NUMBERS.findall(val):
                        self.record(identifier, source + ('json_numeric_occurrence',))


def sources(rows):
    return [{'surface': surface, 'function_id': fid or None, 'structure': structure}
            for surface, fid, structure in sorted(rows)]


# --- end of verbatim block ------------------------------------------------------------------

H5_DEVICE = "Pixel 7"
JD_ROOM_URL = "https://lives.jd.com/#/{}"
PUBLIC_LIVE_ID = re.compile(r"[1-9][0-9]{4,17}\Z")
APP_DOWNLOAD = ("wqs.jd.com", "/downloadApp/download.html")
# functionIds whose JSON the shop entry hook reads. Response structure is NOT calibrated; only the
# generic Evidence walker and a top-level key summary are applied.
SHOP_FUNCTION_HOOKS = frozenset({"batchGetShopInfoByVenderId"})
SAFE_KEY = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,40}$")
SENSITIVE_KEY = re.compile(r"token|cookie|secret|password|phone|mobile|email|user|nick|pin|address", re.I)
STATUS_CODES = {
    "login_wall": (Code.LOGIN_REQUIRED, "login_wall"),
    "challenge": (Code.CAPTCHA_X5SEC, "challenge"),
    "access_denied": (Code.CAPTCHA_X5SEC, "http_access_restriction"),
    "http_error": (Code.NAV_TIMEOUT, "http_error"),
    "navigation_error": (Code.NAV_TIMEOUT, "navigation_error"),
    "observation_error": (Code.NAV_TIMEOUT, "observation_error"),
    "app_download_landing": (Code.REDIRECTED, "app_download_landing"),
}


def _links_and_hydration_once(evidence: Evidence, counts: Counter):
    async def read(frame, surface):
        try:
            rows = await frame.evaluate(LINKS_JS)
            if len(rows) >= 2000:
                evidence.truncated.add("dom_element_limit_possible")
            for key, val in rows:
                if key in {"href", "live_entry_href"}:
                    evidence.link(val, (surface if key == "href" else surface + "_live_entry", ""), frame.url)
                elif isinstance(val, str):
                    evidence.record(val, (surface, "", key), candidate=True)
        except Exception:
            counts["dom_frame_read_errors"] += 1
        try:
            hyd = await frame.evaluate(HYDRATION_JS)
            if hyd["truncated"]:
                evidence.truncated.add("hydration_limit")
            for raw in hyd["payloads"]:
                try:
                    data = json.loads(raw)
                except (ValueError, RecursionError):
                    counts["invalid_hydration_json"] += 1
                    continue
                if isinstance(data, (dict, list)):
                    evidence.payload(data, (surface + "_hydration_json", ""))
                    counts["hydration_json_parsed"] += 1
        except Exception:
            counts["hydration_read_errors"] += 1
    return read


async def observe_h5(factory, sku, *, device=H5_DEVICE):
    """observe(mobile=True) from the experiment, with the discovery policy installed."""
    page_url = f"https://item.m.jd.com/product/{sku}.html"
    evidence = Evidence()
    out = {"variant": "h5", "product_url": page_url, "status": "navigation_error",
           "main_http_status": None, "loaded_product_page": False, "login_wall": False,
           "challenge": False, "product_content_signals": [], "response_diagnostics": {}}
    latch = GateLatch(JdDiscoveryPolicy())
    audit = NetworkAudit(latch.name)
    context = await factory.new_context("jd_h5_mobile", device=device)
    counts = Counter()
    attributed, capture_tasks, scheduled = set(), set(), set()
    captured = Evidence()
    prior = Evidence()
    accepting_responses = True
    out["live_entry_signals"] = []
    out["landing_route"] = None
    out["prior_sku_public_json"] = {"response_count": 0}
    gate = None
    try:
        page = await context.new_page()

        def on_allowed(request, info, decision):
            if info.host == "api.m.jd.com":
                on_sku = sku_page_url(page.url, sku) and jd_host(parse_url(info.frame_url or "")[1])
                if on_sku and len(attributed) < 500:
                    attributed.add(request)

        def on_blocked(info, decision):
            nonlocal gate
            if decision.gate and not gate:
                gate = decision.gate
                out["gate_route"] = landing_route(info.url, sku)

        async def capture(req, resp):
            stage = "response"
            try:
                if resp is None:
                    resp = await asyncio.wait_for(req.response(), 4)
                if not resp or gate or resp.status != 200:
                    return
                declared = getattr(resp, "headers", {}).get("content-length", "")
                if str(declared).isdigit() and int(declared) > LIMIT_BODY:
                    captured.truncated.add("response_size_limit")
                    return
                stage = "body"
                raw = await asyncio.wait_for(resp.body(), 6)
                if gate:
                    return
                if len(raw) > LIMIT_BODY:
                    captured.truncated.add("response_size_limit")
                    return
                stage = "parse"
                data = json_value(raw)
                if isinstance(data, (dict, list)):
                    captured.payload(data, ("public_api_json", func_id(req) or ""))
                    counts["public_json_responses_parsed"] += 1
            except (UnicodeError, ValueError, RecursionError):
                counts["non_json_responses"] += 1
            except Exception as exc:
                counts["response_read_errors"] += 1
                kind = type(exc).__name__
                kind = kind if kind in {"Error", "TimeoutError", "TargetClosedError", "KeyError", "RuntimeError"} else "OtherError"
                counts["response_read_" + stage + "_" + kind] += 1

        def schedule_capture(req, resp=None):
            if not accepting_responses or gate or req in scheduled or parse_url(req.url)[1] != "api.m.jd.com":
                return
            if req.resource_type not in {"xhr", "fetch", "script", "document"}:
                return
            if req not in attributed:
                if resp is not None:
                    counts["responses_without_sku_context_skipped"] += 1
                return
            if PRIVATE.search(func_id(req) or ""):
                return
            if len(scheduled) >= MAX_RESPONSES:
                captured.truncated.add("response_count_limit")
                return
            scheduled.add(req)
            counts["public_response_captures_started"] += 1
            capture_tasks.add(asyncio.create_task(capture(req, resp)))

        await install_policy(context, latch, audit, on_allowed, on_blocked)
        page.on("response", lambda resp: schedule_capture(resp.request, resp))
        page.on("requestfinished", schedule_capture)
        response = None
        try:
            response = await page.goto(page_url, wait_until="domcontentloaded", timeout=25_000)
        except Exception:
            counts["navigation_exceptions"] += 1
        if response:
            out["main_http_status"] = response.status
        for tick in range(14):
            if gate or (response and response.status >= 400):
                break
            try:
                gate = (await page.evaluate(ACCESS_JS)) or gate
                if tick == 6 and not gate and sku_page_url(page.url, sku) and await page.evaluate(PRODUCT_JS):
                    await page.evaluate("() => window.scrollBy(0, Math.min(420, innerHeight / 2))")
                    counts["ordinary_product_scroll"] += 1
            except Exception:
                counts["document_transitions"] += 1
            if gate:
                latch.gate = gate
                break
            await asyncio.sleep(0.5)
        if not gate:
            try:
                gate = (await page.evaluate(ACCESS_JS)) or gate
            except Exception:
                counts["document_unavailable"] += 1
        if gate:
            latch.gate = gate
        out["login_wall"] = gate == "login_wall" or bool(response and response.status == 401)
        out["challenge"] = gate == "challenge"
        landing_host = parse_url(page.url)[1]
        out["landing_host"] = landing_host if landing_host in {"item.jd.com", "item.m.jd.com", *ACCESS_HOSTS} else None
        out["landing_route"] = landing_route(page.url, sku)
        if gate or out["login_wall"]:
            out["status"] = gate or "login_wall"
        elif response and response.status >= 400:
            out["status"] = "access_denied" if response.status in {403, 429} else "http_error"
        elif not response:
            out["status"] = "navigation_error"
        elif not sku_page_url(page.url, sku):
            out["status"] = "redirected_elsewhere"
        else:
            out["product_content_signals"] = await page.evaluate(PRODUCT_JS)
            out["live_entry_signals"] = await page.evaluate(LIVE_UI_JS)
            out["loaded_product_page"] = bool(out["product_content_signals"])
            out["status"] = "loaded" if out["loaded_product_page"] else "product_content_unconfirmed"
            read = _links_and_hydration_once(evidence, counts)
            for frame in page.frames:
                if jd_host(parse_url(frame.url)[1]):
                    await read(frame, "dom" if frame == page.main_frame else "jd_iframe_dom")
        accepting_responses = False
        if out["status"] in {"loaded", "product_content_unconfirmed", "redirected_elsewhere"}:
            if capture_tasks:
                await asyncio.gather(*capture_tasks)
            if not gate:
                previous = out["status"] == "redirected_elsewhere"
                destination = prior if previous else evidence
                surface = "prior_sku_public_api_json" if previous else "public_api_json"
                destination.truncated.update(captured.truncated)
                for candidate, entries in ((True, captured.candidates), (False, captured.numbers)):
                    for identifier, origins in entries.items():
                        for _, fid, structure in origins:
                            destination.record(identifier, (surface, fid, structure), candidate=candidate)
                if previous:
                    out["prior_sku_public_json"]["response_count"] = counts.get("public_json_responses_parsed", 0)
    except Exception:
        out["status"] = gate or "observation_error"
        out["login_wall"] = gate == "login_wall"
        out["challenge"] = gate == "challenge"
    finally:
        accepting_responses = False
        for task in capture_tasks:
            if not task.done():
                task.cancel()
        if capture_tasks:
            await asyncio.gather(*capture_tasks, return_exceptions=True)
        await context.close()
    if gate:
        out.update(status=gate, loaded_product_page=False, login_wall=gate == "login_wall", challenge=gate == "challenge")
        evidence, prior = Evidence(), Evidence()
        out["prior_sku_public_json"] = {"response_count": 0}
    out["response_diagnostics"] = dict(sorted(counts.items()))
    out["limits_reached"] = sorted(evidence.truncated)
    return out, evidence, prior, audit


def _safe_keys(value) -> list[str]:
    if not isinstance(value, dict):
        return []
    return sorted(k for k in value if isinstance(k, str) and SAFE_KEY.fullmatch(k) and not SENSITIVE_KEY.search(k))[:30]


def _value_seen(node, wanted: str, budget: int = 50_000) -> bool:
    todo, seen = [node], 0
    while todo and seen < budget:
        item = todo.pop()
        seen += 1
        if isinstance(item, dict):
            todo.extend(item.values())
        elif isinstance(item, list):
            todo.extend(item)
        elif not isinstance(item, bool) and isinstance(item, (str, int)) and str(item) == wanted:
            return True
    return False


async def observe_shop(factory, shop_id, vender_id=None, *, budget=12.0, device=H5_DEVICE):
    """Hop 1 of shop_discover. Uncalibrated: records structure, never assumes field names."""
    entry = f"https://shop.m.jd.com/?shopId={shop_id}"
    evidence = Evidence()
    out = {"entry": "shop_m_jd", "status": "navigation_error", "main_http_status": None,
           "landing_route": None, "hook_responses": 0, "hook_key_summary": {}, "vender_id_seen": None}
    latch = GateLatch(JdDiscoveryPolicy())
    audit = NetworkAudit(latch.name)
    counts = Counter()
    tasks = []
    gate = None
    context = await factory.new_context("jd_h5_mobile", device=device)
    try:
        page = await context.new_page()

        def on_blocked(info, decision):
            nonlocal gate
            if decision.gate and not gate:
                gate = decision.gate

        async def read_hook(resp, name):
            try:
                if resp.status != 200:
                    return
                raw = await asyncio.wait_for(resp.body(), 4)
                if len(raw) > LIMIT_BODY:
                    return
                data = json_value(raw)
                if not isinstance(data, (dict, list)):
                    return
                out["hook_responses"] += 1
                evidence.payload(data, ("shop_hook_json", name))
                summary = {"top": _safe_keys(data)}
                if isinstance(data, dict) and isinstance(data.get("data"), dict):
                    summary["data"] = _safe_keys(data["data"])
                out["hook_key_summary"].setdefault(name, summary)
                if vender_id:
                    out["vender_id_seen"] = bool(out["vender_id_seen"]) or _value_seen(data, vender_id)
            except Exception:
                counts["hook_read_errors"] += 1

        def on_response(resp):
            req = resp.request
            if parse_url(req.url)[1] != "api.m.jd.com" or len(tasks) >= 20:
                return
            name = func_id(req)
            if name in SHOP_FUNCTION_HOOKS:
                tasks.append(asyncio.create_task(read_hook(resp, name)))

        await install_policy(context, latch, audit, None, on_blocked)
        page.on("response", on_response)
        response = None
        try:
            response = await page.goto(entry, wait_until="domcontentloaded", timeout=int(max(3, budget - 2) * 1000))
        except Exception:
            counts["navigation_exceptions"] += 1
        out["main_http_status"] = response.status if response else None
        loop = asyncio.get_running_loop()
        deadline = loop.time() + budget
        while loop.time() < deadline and not gate:
            try:
                gate = (await page.evaluate(ACCESS_JS)) or gate
            except Exception:
                counts["document_transitions"] += 1
            host, path = parse_url(page.url)[1], urlsplit(page.url).path
            if (host, path) == APP_DOWNLOAD:
                break
            await asyncio.sleep(0.5)
        if gate:
            latch.gate = gate
        out["landing_route"] = landing_route(page.url, shop_id)
        if tasks:
            await asyncio.wait(tasks, timeout=5)
        if gate:
            out["status"] = gate
        elif (parse_url(page.url)[1], urlsplit(page.url).path) == APP_DOWNLOAD:
            out["status"] = "app_download_landing"
        elif response and response.status >= 400:
            out["status"] = "access_denied" if response.status in {403, 429} else "http_error"
        elif response is None:
            out["status"] = "navigation_error"
        else:
            out["status"] = "loaded"
            read = _links_and_hydration_once(evidence, counts)
            await read(page.main_frame, "shop_dom")
    except Exception:
        out["status"] = gate or "observation_error"
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        await context.close()
    if gate:
        evidence = Evidence()
    out["response_diagnostics"] = dict(sorted(counts.items()))
    out["limits_reached"] = sorted(evidence.truncated)
    return out, evidence, audit


def pick_candidate(evidence: Evidence) -> tuple[str | None, str]:
    ids = sorted(i for i in evidence.candidates if PUBLIC_LIVE_ID.fullmatch(i))
    if len(ids) == 1:
        return ids[0], "unique_live_candidate"
    return None, "ambiguous_live_candidates" if ids else "no_live_candidate"


def sku_control_verdict(sku, control_id, control_positive, candidates, prior_ids, truncated, loaded):
    """experiments/jd_sku_live/run.py interpret(), on the V2 audit fields."""
    candidates, prior_ids = set(candidates), set(prior_ids)
    if not sku:
        return "inconclusive_sku_unresolved"
    if not control_id:
        return "inconclusive_control_id_unresolved"
    if not control_positive:
        return "inconclusive_no_confirmed_live_control"
    if control_id not in candidates and control_id in prior_ids:
        return "matching_live_id_in_sku_response_before_redirect"
    if not loaded:
        return "inconclusive_no_product_page_loaded"
    if control_id in candidates:
        if candidates | prior_ids == {control_id} and not truncated:
            return "matching_live_id_uniquely_discovered_in_this_run"
        return "matching_live_id_among_candidates_or_partial_results"
    return "no_match_in_inspected_sources"


def _no_candidate(reason: str, audit: NetworkAudit, details: dict) -> Resolution:
    if audit.blocked_writes:
        return Resolution.failure(Code.POST_AUDIT_BLOCKED, reason + "_with_blocked_writes", audit=details)
    return Resolution.failure(Code.SCHEMA_MISMATCH, reason, audit=details)


class JdDiscovery(DiscoveryEngine):
    platforms = ("jd",)
    TIMEOUTS = {"direct": 45.0, "sku_discover": 110.0, "shop_discover": 40.0}

    async def resolve_all(self, targets: list[Target], ctx: RunContext) -> dict[str, Resolution]:
        ordered = [t for t in targets if t.canary] + [t for t in targets if not t.canary]
        results = {}
        for target in ordered[:1] if ordered and ordered[0].canary else []:
            results[target.key] = await self._guarded(target, ctx)
        rest = [t for t in ordered if t.key not in results]
        for target, result in zip(rest, await bounded_map(rest, ctx.settings.limits.max_concurrency,
                                                         lambda t: self._guarded(t, ctx))):
            results[target.key] = result
        return results

    async def _guarded(self, target: Target, ctx: RunContext) -> Resolution:
        if target.mode == "direct" and target.live_id:
            return Resolution(Code.OK, "configured_live_id", live_id=target.live_id,
                              room_url=JD_ROOM_URL.format(target.live_id), verification="config")
        if ctx.breaker.is_open(JD_GROUP):
            return Resolution.failure(Code.GROUP_CIRCUIT_OPEN, "group_circuit_open", networked=False)
        result = await guarded(lambda: self.resolve_one(target, ctx), self.TIMEOUTS.get(target.mode, 60.0),
                               lambda code, reason: Resolution.failure(code, reason))
        ctx.breaker.record(JD_GROUP, result.code, target_key=target.key, layer="discovery")
        return result

    async def resolve_one(self, target: Target, ctx: RunContext) -> Resolution:
        if target.mode == "direct":
            return await self._short_link(target, ctx, target.short_link_role or "clip")
        if target.mode == "sku_discover":
            sku = target.sku_id
            link_audit = {}
            if not sku:
                linked = await short_link.resolve(ctx.browser.browser, "product", target.short_link)
                code, why = short_link.map_resolve_status(linked)
                link_audit = {"product_link": {"status": linked.get("status"), "landing_route": linked.get("landing_route")}}
                if code is not Code.OK:
                    return Resolution.failure(code, "product_link_" + why, audit=link_audit)
                sku = linked["sku_id"]
            return await self._sku(target, ctx, sku, link_audit)
        if target.mode == "shop_discover":
            return await self._shop(target, ctx)
        return Resolution.failure(Code.SCHEMA_MISMATCH, "unsupported_mode", networked=False)

    async def _short_link(self, target, ctx, role) -> Resolution:
        linked = await short_link.resolve(ctx.browser.browser, role, target.short_link)
        code, why = short_link.map_resolve_status(linked)
        audit = {"short_link": {"status": linked.get("status"), "id_source": linked.get("id_source"),
                                "landing_route": linked.get("landing_route"), "http_status": linked.get("http_status")}}
        if code is not Code.OK:
            return Resolution.failure(code, why, audit=audit)
        live_id = linked["live_id"]
        return Resolution(Code.OK, "short_link_resolved", live_id=live_id, room_url=JD_ROOM_URL.format(live_id),
                          verification="resolved_link", networked=True, audit=audit)

    async def _sku(self, target, ctx, sku, link_audit) -> Resolution:
        out, evidence, prior, audit = await observe_h5(ctx.browser, sku)
        details = {**link_audit, "sku_id": sku, "h5": {k: out.get(k) for k in (
            "status", "main_http_status", "landing_route", "product_content_signals", "live_entry_signals",
            "limits_reached", "response_diagnostics", "prior_sku_public_json")}, "network": audit.report()}
        details["candidate_ids"] = sorted(evidence.candidates)[:10]
        details["prior_candidate_ids"] = sorted(prior.candidates)[:10]
        details["loaded_product_page"] = bool(out.get("loaded_product_page"))
        status = out["status"]
        if status in {"loaded", "product_content_unconfirmed"}:
            live_id, why = pick_candidate(evidence)
        elif status == "redirected_elsewhere":
            live_id, why = pick_candidate(prior)
            if live_id is None:
                return Resolution.failure(Code.REDIRECTED, "redirected_elsewhere", audit=details)
            why = "unique_live_candidate_before_redirect"
        else:
            code, why = STATUS_CODES.get(status, (Code.NAV_TIMEOUT, "observation_error"))
            return Resolution.failure(code, why, audit=details)
        if live_id is None:
            return _no_candidate(why, audit, details)
        return Resolution(Code.OK, why, live_id=live_id, room_url=JD_ROOM_URL.format(live_id),
                          verification="candidate_unverified", networked=True, audit=details)

    async def _shop(self, target, ctx) -> Resolution:
        out, evidence, audit = await observe_shop(ctx.browser, target.shop_id, target.vender_id, budget=ctx.budget)
        details = {"shop": {k: out.get(k) for k in (
            "entry", "status", "main_http_status", "landing_route", "hook_responses", "hook_key_summary",
            "vender_id_seen", "limits_reached", "response_diagnostics")}, "network": audit.report(),
            "candidate_ids": sorted(evidence.candidates)[:10], "calibrated": False}
        if out["status"] != "loaded":
            code, why = STATUS_CODES.get(out["status"], (Code.NAV_TIMEOUT, "observation_error"))
            return Resolution.failure(code, why, audit=details)
        live_id, why = pick_candidate(evidence)
        if live_id is None:
            return _no_candidate(why, audit, details)
        return Resolution(Code.OK, why, live_id=live_id, room_url=JD_ROOM_URL.format(live_id),
                          verification="candidate_unverified", networked=True, audit=details)
