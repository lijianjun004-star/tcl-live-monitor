"""JD network policies. Discovery and monitoring use two separate classes (SPEC.md 7.1).

Defect B fix: the SKU experiment blocked every api.m.jd.com POST that was not on a narrow
allow-list (``non_allowlisted_writes_blocked``). Discovery now blocks only unsafe names
(order / cart / auth / telemetry / privacy / state change) and lets the remaining POST reads
through with a functionId audit.
"""

from __future__ import annotations

import json
import re
from urllib.parse import parse_qs, urlsplit

from core.network import Decision, NetworkPolicy, RequestInfo
from core.safety import classify_unsafe_name

# --- verbatim from experiments/jd_sku_live/discovery.py -------------------------------------
FUNCTION = re.compile(r"[A-Za-z][A-Za-z0-9_.-]{0,95}\Z")
MEDIA = re.compile(r"\.(?:mp[34]|m3u8|flv|aac|ts|m4s|mpd|webm)(?:$|/)", re.I)
PRIVATE = re.compile(r"comment|review|address|(?:nick|user|member|customer|account|order)(?:name|id|info|list|profile)?$|passport|cookie|token|phone|mobileNo|email|tracking|encrypted|pin$|avatar|recommendReason", re.I)
ACCESS_HOSTS = {"passport.jd.com", "plogin.m.jd.com", "passport.m.jd.com", "safe.jd.com", "jcap.m.jd.com", "jcap.jd.com"}
PRODUCT_READ = re.compile(r"(?:pc_detailpage_|detailpage_)?(?:wareBusiness|wareInfo|shopInfo|wareBusinessV2)|(?:get|query)(?:Product|Ware|Sku)(?:Detail|BaseInfo|LiveInfo)|(?:get|query)(?:Live|SkuLive)(?:Info|Room|Status)", re.I)
EXPLICIT_READS = {
    "graphic_detail", "getpageconfig", "ware_category_list", "batchgetshopinfobyvenderid",
    "yinliu_service_display", "pc_detailpage_warebusiness",
}
PROHIBITED_FUNCTION = re.compile(
    r"cart|address|account|personal|member|user(?:info|data|profil)|order|password|passport|login|"
    r"captcha|risk|fingerprint|token|sign(?:in|up)|track|report|telemetry|collect|beacon|"
    r"click|expose|impress|upload|record|submit|create|update|delete|remove|modify|"
    r"add|follow|receive|redeem|claim|purchase|checkout|payment|bind|register|send|write|save|award", re.I)
PRODUCT_SUBJECT = re.compile(r"product|ware|sku|shop|category|catalog|brand|graphic|detailpage|live|floor|pageconfig|goods", re.I)
READ_PREFIX = re.compile(r"^(?:batch)?(?:get|query|fetch|list|load)", re.I)
DISPLAY_NOUN = re.compile(
    r"(?:(?:h5|pc|m)_?)?(?:product|ware|sku|shop|category|catalog|brand|graphic|detailpage|live|goods)"
    r"(?:_?(?:room|page|base|live|product|category|card|detail|graphic|shop)){0,3}"
    r"_?(?:detail|config|display|list|info|status|entry|overview|content|view|modules|floor)(?:v[0-9]+)?", re.I)
PUBLIC_STATIC_DOMAINS = ("360buyimg.com", "jdcdn.com", "jdstatic.com", "3.cn")


def public_post_read(name):
    if not name or not FUNCTION.fullmatch(name) or PRIVATE.search(name) or PROHIBITED_FUNCTION.search(name):
        return False
    return bool(name.lower() in EXPLICIT_READS or PRODUCT_READ.fullmatch(name)
                or PRODUCT_SUBJECT.search(name) and READ_PREFIX.match(name) or DISPLAY_NOUN.fullmatch(name))


def jd_host(host):
    return bool(host and (host == "jd.com" or host.endswith(".jd.com")))


def func_id(request):
    """``request`` needs ``url``, ``method`` and ``post_data`` (RequestInfo or Playwright Request)."""
    try:
        parts = urlsplit(request.url)
    except ValueError:
        return None
    values = parse_qs(parts.query, keep_blank_values=True).get("functionId", [])
    if request.method == "POST":
        body = request.post_data or ""
        if len(body) > 100_000:
            return None
        if body.lstrip().startswith("{"):
            try:
                # Preserve duplicated selectors so a disagreement is never treated as an allowed read.
                pairs = json.loads(body, object_pairs_hook=lambda items: items)
                values.extend(value for key, value in pairs if key == "functionId")
            except (ValueError, TypeError, RecursionError):
                return None
        else:
            values.extend(parse_qs(body, keep_blank_values=True).get("functionId", []))
    if not values or not all(isinstance(x, str) and FUNCTION.fullmatch(x) for x in values):
        return None
    return values[0] if len(set(values)) == 1 else None
# --- end of verbatim block ------------------------------------------------------------------

FONT = re.compile(r"\.(?:woff2?|ttf|otf|eot)(?:$|\?)", re.I)
# src/single_room_probe.py MEDIA_SUFFIX, used by the legacy monitor's media_filter.
MONITOR_MEDIA_SUFFIX = (".flv", ".m3u8", ".mp4", ".ts", ".m4s", ".aac", ".fmp4")
MONITOR_FONT_SUFFIX = (".woff", ".woff2", ".ttf", ".otf", ".eot")
API_HOST = "api.m.jd.com"
API_WRITE_PATHS = {"", "/", "/api", "/client.action"}


def unsafe_function_category(name: str | None) -> str | None:
    if not name:
        return None
    if not FUNCTION.fullmatch(name):
        return "unparseable"
    return classify_unsafe_name(name)


class JdDiscoveryPolicy(NetworkPolicy):
    """Discovery layer (B): safe-write blocking with a read-only POST audit."""

    name = "jd_discovery"

    def decide(self, request: RequestInfo) -> Decision:
        try:
            parts = urlsplit(request.url)
            host = (parts.hostname or "").lower()
        except ValueError:
            return Decision(False, "unparseable_url")
        if parts.scheme not in {"http", "https"}:
            return Decision(False, "non_http_scheme")
        if request.is_navigation and request.is_main_frame and host in ACCESS_HOSTS:
            gate = "challenge" if host.startswith(("jcap", "safe.")) else "login_wall"
            return Decision(False, "access_gate_navigation", gate=gate)
        if request.resource_type == "media" or MEDIA.search(parts.path):
            return Decision(False, "media_blocked")
        if request.resource_type == "font" or FONT.search(parts.path):
            return Decision(False, "font_blocked")
        static = any(host == domain or host.endswith("." + domain) for domain in PUBLIC_STATIC_DOMAINS)
        if not (jd_host(host) or static):
            return Decision(False, "external_requests_blocked")
        name = func_id(request) if host == API_HOST else None
        known = public_post_read(name) if name else None
        category = unsafe_function_category(name)
        if category:
            return Decision(False, "unsafe_function_blocked", name=name, category=category, known_read=known)
        if request.method in {"GET", "HEAD", "OPTIONS"}:
            return Decision(True, "read_allowed", name=name, known_read=known)
        if request.method == "POST" and host == API_HOST:
            if parts.scheme != "https" or parts.path not in API_WRITE_PATHS:
                return Decision(False, "api_write_path_not_allowed", name=name)
            if not name:
                return Decision(False, "post_without_function_id")
            return Decision(True, "readonly_post_audited", name=name, known_read=known)
        return Decision(False, "non_api_write_blocked")


class JdMonitorPolicy(NetworkPolicy):
    """Monitor layer (A): defect A fix. Drop stream media and fonts; everything else as before."""

    name = "jd_monitor"

    def __init__(self, block_images: bool = False):
        self.block_images = block_images

    def decide(self, request: RequestInfo) -> Decision:
        try:
            path = urlsplit(request.url).path.lower()
        except ValueError:
            return Decision(False, "unparseable_url")
        if request.resource_type == "media" or path.endswith(MONITOR_MEDIA_SUFFIX):
            return Decision(False, "media_blocked")
        if request.resource_type == "font" or path.endswith(MONITOR_FONT_SUFFIX):
            return Decision(False, "font_blocked")
        if self.block_images and request.resource_type == "image":
            return Decision(False, "image_blocked")
        return Decision(True, "allowed")
