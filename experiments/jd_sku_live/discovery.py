"""Anonymous SKU observations. The control ID is compared after collecting both pages."""
import asyncio
import json
import re
from collections import Counter
from urllib.parse import parse_qs, urljoin, urlsplit

DIGITS = re.compile(r"[1-9][0-9]{3,19}\Z")
NUMBERS = re.compile(r"(?<![0-9])[1-9][0-9]{3,19}(?![0-9])")
FUNCTION = re.compile(r"[A-Za-z][A-Za-z0-9_.-]{0,95}\Z")
JSONP = re.compile(r"(?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$][\w$]*\s*\((.*)\)\s*;?\s*\Z", re.S)
MEDIA = re.compile(r"\.(?:mp[34]|m3u8|flv|aac|ts|m4s|mpd|webm)(?:$|/)", re.I)
PRIVATE = re.compile(r"comment|review|address|(?:nick|user|member|customer|account|order)(?:name|id|info|list|profile)?$|passport|cookie|token|phone|mobileNo|email|tracking|encrypted|pin$|avatar|recommendReason", re.I)
ACCESS_HOSTS = {"passport.jd.com", "plogin.m.jd.com", "passport.m.jd.com", "safe.jd.com", "jcap.m.jd.com", "jcap.jd.com"}
# A natural browser POST can carry one of these public product-information reads.
PRODUCT_READ = re.compile(r"(?:pc_detailpage_|detailpage_)?(?:wareBusiness|wareInfo|shopInfo|wareBusinessV2)|(?:get|query)(?:Product|Ware|Sku)(?:Detail|BaseInfo|LiveInfo)|(?:get|query)(?:Live|SkuLive)(?:Info|Room|Status)", re.I)
PUBLIC_STATIC_DOMAINS = ('360buyimg.com', 'jdcdn.com', 'jdstatic.com', '3.cn')
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
LINKS_JS = """() => Array.from(document.querySelectorAll('a[href], area[href], [data-live-id], [data-liveid], [data-live-room-id]'))
 .slice(0, 2000).flatMap(el => {
  const rows = [];
  if (el.href && typeof el.href === 'string' && el.href.length < 8192) rows.push(['href', el.href]);
  for(const key of ['data-live-id','data-liveid','data-live-room-id']) {
   if(el.hasAttribute(key)) rows.push([key, el.getAttribute(key)]);
  }
  return rows;
 })"""


def jd_host(host):
    return bool(host and (host == 'jd.com' or host.endswith('.jd.com')))


def parse_url(value):
    try:
        parts = urlsplit(value)
        return parts, (parts.hostname or '').lower()
    except ValueError:
        return None, ''


def func_id(request):
    parts, _ = parse_url(request.url)
    if parts is None:
        return None
    values = parse_qs(parts.query).get('functionId', [])
    if not values and request.method == 'POST':
        body = request.post_data or ''
        if len(body) <= 100_000:
            values = parse_qs(body).get('functionId', [])
    return values[0] if values and FUNCTION.fullmatch(values[0]) else None


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


async def observe(browser, sku, mobile, mobile_device=None):
    host = 'item.m.jd.com' if mobile else 'item.jd.com'
    page_url = f'https://{host}/' + ('product/' if mobile else '') + f'{sku}.html'
    evidence = Evidence()
    out = {'variant': 'h5' if mobile else 'pc', 'product_url': page_url, 'status': 'navigation_error',
           'main_http_status': None, 'loaded_product_page': False, 'login_wall': False,
           'challenge': False, 'product_content_signals': [], 'observed_function_ids': [], 'response_diagnostics': {}}
    options = {'is_mobile': mobile, 'has_touch': mobile, 'locale': 'zh-CN',
               'viewport': {'width': 390 if mobile else 1280, 'height': 844 if mobile else 800},
               'service_workers': 'block', 'accept_downloads': False}
    if mobile:
        options['user_agent'] = ('Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 '
                                 '(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36')
    if mobile and mobile_device:
        options.update({key: value for key, value in mobile_device.items() if key in {
            'viewport', 'screen', 'user_agent', 'is_mobile', 'has_touch', 'device_scale_factor'}})
    context = await browser.new_context(**options)
    counts = Counter()
    functions = set()
    finished = []
    gate = None
    try:
        page = await context.new_page()

        async def intercept(route):
            nonlocal gate
            req = route.request
            parts, req_host = parse_url(req.url)
            if req_host == 'api.m.jd.com':
                fn = func_id(req)
                if fn:
                    if len(functions) < 300:
                        functions.add(fn)
                    elif fn not in functions:
                        evidence.truncated.add('function_list_limit')
            if req.is_navigation_request() and req.frame == page.main_frame and req_host in ACCESS_HOSTS:
                gate = 'challenge' if req_host.startswith(('jcap', 'safe.')) else 'login_wall'
            if gate or not parts or req.resource_type == 'media' or MEDIA.search(parts.path):
                await route.abort()
                return
            static = any(req_host == domain or req_host.endswith('.' + domain) for domain in PUBLIC_STATIC_DOMAINS)
            if parts.scheme not in {'http', 'https'} or not (jd_host(req_host) or static):
                counts['external_requests_blocked'] += 1
                await route.abort()
                return
            if req.is_navigation_request() and req.frame == page.main_frame and not jd_host(req_host):
                counts['external_navigations_blocked'] += 1
                await route.abort()
                return
            if req.method not in {'GET', 'HEAD', 'OPTIONS'} and not (
                req_host == 'api.m.jd.com' and req.method == 'POST' and PRODUCT_READ.fullmatch(func_id(req) or '')
            ):
                counts['non_allowlisted_writes_blocked'] += 1
                await route.abort()
                return
            await route.continue_()

        def finished_request(req):
            if gate or parse_url(req.url)[1] != 'api.m.jd.com' or req.resource_type not in {'xhr', 'fetch', 'script', 'document'}:
                return
            if PRIVATE.search(func_id(req) or ''):
                counts['private_responses_skipped'] += 1
            elif len(finished) < MAX_RESPONSES:
                finished.append(req)
            else:
                evidence.truncated.add('response_count_limit')

        await context.route('**/*', intercept)
        page.on('requestfinished', finished_request)
        response = None
        try:
            response = await page.goto(page_url, wait_until='domcontentloaded', timeout=25_000)
        except Exception:
            counts['navigation_exceptions'] += 1
        if response:
            out['main_http_status'] = response.status
        for _ in range(10):
            if gate or (response and response.status >= 400):
                break
            try:
                gate = await page.evaluate(ACCESS_JS)
            except Exception:
                counts['document_transitions'] += 1
            if gate:
                break
            await asyncio.sleep(0.5)
        if not gate:
            try:
                gate = await page.evaluate(ACCESS_JS)
            except Exception:
                counts['document_unavailable'] += 1
        out['login_wall'] = gate == 'login_wall' or bool(response and response.status == 401)
        out['challenge'] = gate == 'challenge'
        parts, landing_host = parse_url(page.url)
        out['landing_host'] = landing_host if landing_host in {host, 'item.jd.com', 'item.m.jd.com', *ACCESS_HOSTS} else None
        product_origin = landing_host in {'item.jd.com', 'item.m.jd.com'}
        product_sku = parts and (re.search(r'(?<!\d)' + re.escape(sku) + r'(?!\d)', parts.path)
                             or sku in parse_qs(parts.query).get('wareId', []))
        if gate or out['login_wall']:
            out['status'] = gate or 'login_wall'
        elif response and response.status >= 400:
            out['status'] = 'access_denied' if response.status in {403, 429} else 'http_error'
        elif not response:
            out['status'] = 'navigation_error'
        elif not (product_origin and product_sku):
            out['status'] = 'redirected_elsewhere'
        else:
            out['product_content_signals'] = await page.evaluate(PRODUCT_JS)
            out['loaded_product_page'] = bool(out['product_content_signals'])
            out['status'] = 'loaded' if out['loaded_product_page'] else 'product_content_unconfirmed'
            for frame in page.frames:
                if not jd_host(parse_url(frame.url)[1]):
                    continue
                surface = 'dom' if frame == page.main_frame else 'jd_iframe_dom'
                try:
                    rows = await frame.evaluate(LINKS_JS)
                    if len(rows) >= 2000:
                        evidence.truncated.add('dom_element_limit_possible')
                    for key, val in rows:
                        if key == 'href':
                            evidence.link(val, (surface, ''), frame.url)
                        elif isinstance(val, str):
                            evidence.record(val, (surface, '', key), candidate=True)
                except Exception:
                    counts['dom_frame_read_errors'] += 1
            for req in list(finished):
                try:
                    resp = await req.response()
                    if not resp or resp.status != 200:
                        continue
                    sizes = await req.sizes()
                    if sizes.get('responseBodySize', 0) > LIMIT_BODY:
                        evidence.truncated.add('response_size_limit')
                        continue
                    raw = await resp.body()
                    if len(raw) > LIMIT_BODY:
                        evidence.truncated.add('response_size_limit')
                        continue
                    data = json_value(raw)
                    if isinstance(data, (dict, list)):
                        evidence.payload(data, ('public_api_json', func_id(req) or ''))
                        counts['public_json_responses_parsed'] += 1
                except (UnicodeError, ValueError, RecursionError):
                    counts['non_json_responses'] += 1
                except Exception:
                    counts['response_read_errors'] += 1
    except Exception:
        out['status'] = gate or 'observation_error'
        out['login_wall'] = gate == 'login_wall'
        out['challenge'] = gate == 'challenge'
    finally:
        await context.close()
    out['observed_function_ids'] = sorted(functions)
    out['response_diagnostics'] = dict(sorted(counts.items()))
    out['limits_reached'] = sorted(evidence.truncated)
    return out, evidence


async def discover(browser, sku_id, true_live_id, *, mobile_device=None):
    sku = str(sku_id or '')
    if not DIGITS.fullmatch(sku):
        raise ValueError('Invalid SKU ID')
    observations = [await observe(browser, sku, mobile, mobile_device) for mobile in (False, True)]
    control = str(true_live_id or '')
    control_available = bool(DIGITS.fullmatch(control))
    pages = []
    for out, evidence in observations:
        matches = evidence.candidates.get(control, set()) if control_available else set()
        exact_sources = matches | evidence.numbers.get(control, set()) if control_available else set()
        out['live_candidates'] = [{'live_id': item, 'sources': sources(origins)}
                                  for item, origins in sorted(evidence.candidates.items())]
        inspected = control_available and out['status'] in {'loaded', 'product_content_unconfirmed'}
        out['control_id_observed'] = bool(exact_sources) if inspected else None
        out['control_id_discovered'] = bool(matches) if inspected else None
        out['control_id_sources'] = sources(exact_sources)
        pages.append(out)
    inspected_pages = [p for p in pages if p['control_id_observed'] is not None]
    return {'sku_id': sku, 'control_id_available': control_available, 'pages': pages,
            'control_id_observed': any(p['control_id_observed'] for p in inspected_pages) if inspected_pages else None,
            'control_id_discovered': any(p['control_id_discovered'] for p in inspected_pages) if inspected_pages else None,
            'observed_function_ids': sorted({fn for p in pages for fn in p['observed_function_ids']})}
