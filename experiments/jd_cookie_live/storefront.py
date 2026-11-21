"""Observe the static HTML of the experiment's three fixed storefront entries."""

import http.client
import re
from html.parser import HTMLParser
from urllib.parse import urljoin, urlsplit

from .evidence import _gate, _room_id, inspect_page
from .fixtures import FLAGSHIP, LIGHTING, SKU
from .run import ENTRIES


_URLS = {entry_id: url for entry_id, _, url in ENTRIES}
_MAX_HTML = 1024 * 1024
_VOID = frozenset("area base br col embed hr img input link meta param source track wbr".split())
_INERT = {"head", "script", "style", "template", "noscript", "iframe", "svg", "textarea"}
# Only product/merchant text in the document body can establish guest readability.
_TARGET_TEXT = {
    SKU: re.compile(r"TCL.{0,80}空调|空调.{0,80}TCL", re.I),
    FLAGSHIP: re.compile(r"TCL官方旗舰店", re.I),
    LIGHTING: re.compile(r"TCL灯饰照明京东自营旗舰店", re.I),
}
_SHOP_CONTENT = ("全部商品", "商品分类", "店铺首页", "店铺商品", "店铺推荐", "热销商品")
_PRODUCT_CONTENT = ("商品详情", "规格参数", "加入购物车", "商品介绍", "立即购买", "商品评价")
_LOADING_TEXT = re.compile(r"加载中|正在加载|请(?:开启|启用)JavaScript|enableJavaScript|loading\.{2,}", re.I)


class StorefrontError(Exception):
    """A fixed, report-safe failure. Transport details can include header text."""


def _navigation_gate(base, destination):
    try:
        url = urljoin(base, destination)
        known = _gate({}, url)
        if known:
            return known
        path = urlsplit(url).path.casefold()
        if re.search(r"(?:^|/)(?:captcha|challenge|verify)(?:[./_-]|$)", path):
            return "CAPTCHA_X5SEC"
        if re.search(r"(?:^|/)(?:login|passport)(?:[./_-]|$)", path):
            return "LOGIN_REQUIRED"
    except (TypeError, ValueError):
        pass
    return None


def _refresh_gate(base, value):
    match = re.search(r"\burl\s*=\s*(.+)$", value, re.I)
    destination = match.group(1).strip(" \"'") if match else ""
    return _navigation_gate(base, destination) or "ACCESS_RESTRICTED"


class _Document(HTMLParser):
    """Read body text and labelled links only; never load an embedded resource."""

    def __init__(self, url):
        super().__init__(convert_charrefs=True)
        self.url = url
        self.base = None
        self.stack = []
        self.text = []
        self.titles = []
        self.links = []
        self.gate = None
        self.has_unread_frame = False

    def handle_starttag(self, tag, attributes):
        attrs = dict(attributes)
        if tag in {"iframe", "frame"}:
            self.has_unread_frame = True
            hint = " ".join(attrs.get(key) or "" for key in ("title", "srcdoc"))
            self.gate = self.gate or _navigation_gate(self.url, attrs.get("src") or "") or _gate({"visible_text": hint}, self.url)
        elif tag == "meta" and (attrs.get("http-equiv") or "").casefold() == "refresh":
            self.gate = self.gate or _refresh_gate(self.url, attrs.get("content") or "")
        elif tag == "input" and (attrs.get("type") or "").casefold() == "password":
            self.gate = self.gate or "LOGIN_REQUIRED"
        elif tag == "base" and self.base is None and attrs.get("href"):
            self.base = urljoin(self.url, attrs["href"])

        if tag in _VOID:
            return
        if len(self.stack) >= 256:
            raise ValueError("excessive HTML nesting")
        css = re.sub(r"\s+", "", attrs.get("style") or "").casefold()
        hidden = bool(self.stack and self.stack[-1][1]) or (
            tag in _INERT or "hidden" in attrs or (attrs.get("aria-hidden") or "").casefold() == "true"
            or "display:none" in css or "visibility:hidden" in css
        )
        anchor = attrs.get("href") if tag == "a" else (self.stack[-1][2] if self.stack else None)
        self.stack.append((tag, hidden, anchor))

    def handle_endtag(self, tag):
        for index in range(len(self.stack) - 1, -1, -1):
            if self.stack[index][0] == tag:
                del self.stack[index:]
                return

    def handle_data(self, data):
        if self.stack and self.stack[-1][0] == "title":
            self.titles.append(data)
        elif self.stack and not self.stack[-1][1] and data.strip():
            self.text.append(data)
            href = self.stack[-1][2]
            if href:
                self.links.append(href)


def _read(entry_id, cookie_header=None):
    url = _URLS[entry_id]
    endpoint = urlsplit(url)
    target = endpoint.path + ("?" + endpoint.query if endpoint.query else "")
    headers = {"Accept": "text/html", "Accept-Encoding": "identity"}
    if cookie_header:
        headers["Cookie"] = cookie_header
    connection = http.client.HTTPSConnection(endpoint.hostname, timeout=15)
    try:
        connection.set_debuglevel(0)
        connection.request("GET", target, headers=headers)
        response = connection.getresponse()
        status = response.status
        sample = {"final_url": url, "http_status": status}
        if 300 <= status < 400:
            sample["gate"] = _navigation_gate(url, response.getheader("Location") or "") or "ACCESS_RESTRICTED"
            sample["final_url"] = ""
        elif status in {407, 451, 511}:
            sample["gate"] = "ACCESS_RESTRICTED"
        elif response.getheader("Refresh") is not None:
            sample["gate"] = _refresh_gate(url, response.getheader("Refresh"))
        elif (status == 200 and response.headers.get_content_type() in {"text/html", "application/xhtml+xml"}
              and (response.getheader("Content-Encoding") or "identity").lower() == "identity"):
            body = response.read(_MAX_HTML + 1)
            if len(body) <= _MAX_HTML:
                charset = (response.headers.get_content_charset() or "utf-8").lower()
                if charset in {"utf-8", "utf8", "us-ascii", "gb2312", "gbk", "gb18030"}:
                    try:
                        _inspect_html(sample, entry_id, body.decode(charset, errors="strict"))
                    except (ValueError, AssertionError):
                        # An undecodable or malformed document cannot establish access.
                        pass
    except (OSError, http.client.HTTPException, ValueError):
        pass
    else:
        return inspect_page(sample, entry_id)
    finally:
        connection.close()
    # Outside the handler so an exception carrying field text is not chained.
    raise StorefrontError("STOREFRONT_READ_FAILED")


def _inspect_html(sample, entry_id, html):
    doc = _Document(sample["final_url"])
    doc.feed(html)
    doc.close()
    body = "".join(doc.text)
    text = re.sub(r"\s+", "", body)
    labels = re.sub(r"\s+", "", "".join(doc.titles)) + "\n" + text
    gate = doc.gate or _gate({"visible_text": labels}, sample["final_url"])
    if not gate and re.search(r"验证码|滑块验证|安全校验|请完成验证|captcha|verifyyouarehuman", labels, re.I):
        gate = "CAPTCHA_X5SEC"
    if not gate and re.search(r"请先登录|请登录|登录后(?:可见|查看)|signinto(?:view|continue)", labels, re.I):
        gate = "LOGIN_REQUIRED"
    if not gate and re.search(r"accessdenied|forbidden|toomanyrequests|拒绝访问", labels, re.I):
        gate = "ACCESS_RESTRICTED"
    if gate:
        sample["gate"] = gate
    elif not doc.has_unread_frame and not _LOADING_TEXT.search(text) and _TARGET_TEXT[entry_id].search(text):
        # Raw text, untrusted link destinations and response headers never leave inspect_page.
        sections = _PRODUCT_CONTENT if entry_id == SKU else _SHOP_CONTENT
        links = [urljoin(doc.base or sample["final_url"], href) for href in doc.links]
        if any(section in text for section in sections) or any(_room_id(href) for href in links):
            sample.update(visible_text=text, dom_hrefs=links, document_observed=True)


def observe_entry(entry_id, session):
    """Return classified evidence, checking the public document before using scoped credentials."""
    if entry_id not in _URLS:
        raise StorefrontError("UNKNOWN_STOREFRONT_ENTRY")
    observation = _read(entry_id)
    scope_available = None
    count = 0
    if observation["page_observed"] and not observation["gate"]:
        header = session.header_for(_URLS[entry_id])
        scope_available = bool(header)
        if header:
            observation = _read(entry_id, header)
            pairs = [item.strip().partition("=") for item in header.split(";") if item.strip()]
            count = len(pairs)
            # Suppress any public room number echoed from this header into an anchor.
            sensitive = {part for name, _, value in pairs for part in (name, value)}
            candidates = [number for number in observation["candidate_live_ids"] if number not in sensitive]
            observation["candidate_live_ids"] = candidates
            if not candidates:
                observation["live_entry_signals"] = [s for s in observation["live_entry_signals"] if s != "dom_room_link"]
    return {**observation, "html_only": True, "scope_available": scope_available,
            "authenticated_request_sent": count > 0, "cookie_injected_count": count}
