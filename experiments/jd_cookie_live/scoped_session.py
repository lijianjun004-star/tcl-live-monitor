"""In-memory Cookie fields for the three fixed HTTPS storefront requests."""

import json
import math
import re
import time
from dataclasses import dataclass
from urllib.parse import urlsplit

from .fixtures import FLAGSHIP, LIGHTING, SKU


_ITEM = "item.m.jd.com"
_SHOP = "shop.m.jd.com"
_PRODUCT_PATH = f"/product/{SKU}.html"
_TARGETS = {
    f"https://{_ITEM}{_PRODUCT_PATH}": (_ITEM, _PRODUCT_PATH),
    f"https://{_SHOP}/?shopId={FLAGSHIP}": (_SHOP, "/"),
    f"https://{_SHOP}/?shopId={LIGHTING}": (_SHOP, "/"),
}
# Dotted domains deliberately stop at the JD registrable domain.
_PARENT_DOMAINS = {".jd.com", ".m.jd.com", f".{_ITEM}", f".{_SHOP}"}
_TOKEN = re.compile(r"[!#$%&'*+.^_`|~0-9a-zA-Z-]+")
_DOMAIN = re.compile(r"\.?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*")
# Browser exports may contain ordinary punctuation in values. Delimiters and
# non-printable bytes must never become part of a generated HTTP field.
_FIELD_VALUE = re.compile(r"[\x20-\x3a\x3c-\x7e]*")
_PATH = re.compile(r"/[^\x00-\x20\x7f-\U0010ffff?#;\\]*")
_PLAYWRIGHT_FIELDS = {"name", "value", "url", "domain", "path", "secure", "httpOnly", "expires",
                      "sameSite", "partitionKey", "partition_key"}
_MAX_INPUT = 48 * 1024
_MAX_RECORDS = 512


class CookieConfigError(ValueError):
    @property
    def code(self):
        return self.args[0]


@dataclass(frozen=True, repr=False, slots=True)
class _Cookie:
    name: str
    value: str
    domain: str
    path: str
    expires: float

    def active(self, now):
        return self.expires == -1 or self.expires > now

    def matches(self, host, path):
        domain_match = host == self.domain or (
            self.domain in _PARENT_DOMAINS and (host == self.domain[1:] or host.endswith(self.domain))
        )
        prefix = self.path if self.path.endswith("/") else self.path + "/"
        return domain_match and (path == self.path or path.startswith(prefix))


@dataclass(frozen=True, repr=False, slots=True)
class ScopedSession:
    cookie_format_detected: str
    _cookies: tuple[_Cookie, ...]

    @property
    def cookie_injected_count(self):
        return len(self._cookies)

    def header_for(self, url: str) -> str | None:
        # Compare original spelling before any parser can normalize an unsafe URL.
        target = _TARGETS.get(url) if type(url) is str else None
        if target is None:
            return None
        now = time.time()
        return "; ".join(f"{c.name}={c.value}" for c in self._cookies
                         if c.active(now) and c.matches(*target)) or None


def _unique_object(pairs):
    obj = dict(pairs)
    if len(obj) != len(pairs):
        raise ValueError
    return obj


def _pair(name, value):
    if (not isinstance(name, str) or not _TOKEN.fullmatch(name)
            or not isinstance(value, str) or not _FIELD_VALUE.fullmatch(value)):
        raise ValueError
    return name, value


def _raw_cookies(raw, origin):
    if origin not in (_ITEM, _SHOP) or any(c in raw for c in "\r\n"):
        raise ValueError
    line = raw.strip(" ")
    if line[:7].lower() == "cookie:":
        line = line[7:].lstrip(" \t")
    pairs = line.removesuffix(";").split(";")
    if len(pairs) > _MAX_RECORDS:
        raise ValueError
    cookies = []
    for pair in pairs:
        name, sep, value = pair.strip(" \t").partition("=")
        if not sep:
            raise ValueError
        # Duplicate raw names can represent different source paths. Keep their order.
        cookies.append(_Cookie(*_pair(name, value), origin, "/", -1))
    return cookies


def _scope(record):
    if "url" in record:
        if "domain" in record or "path" in record:
            raise ValueError
        url = record["url"]
        if not isinstance(url, str) or not re.fullmatch(r"[\x21-\x7e]+", url):
            raise ValueError
        parts = urlsplit(url)
        if (parts.scheme != "https" or parts.netloc not in (_ITEM, _SHOP) or "#" in url
                or "?" in url and url not in _TARGETS):
            raise ValueError
        path = parts.path or "/"
        if (not _PATH.fullmatch(path) or "%" in path or any(part in (".", "..") for part in path.split("/"))):
            raise ValueError
        return parts.netloc, path[:path.rindex("/") + 1]
    domain, path = record["domain"], record["path"]
    if (not isinstance(domain, str) or not domain.isascii() or len(domain) > 254
            or not _DOMAIN.fullmatch(domain.lower()) or not isinstance(path, str) or not _PATH.fullmatch(path)):
        raise ValueError
    return domain.lower(), path


def _json_cookies(raw):
    records = json.loads(raw, object_pairs_hook=_unique_object)
    if not isinstance(records, list) or not 0 < len(records) <= _MAX_RECORDS:
        raise ValueError
    cookies = {}
    for record in records:
        if not isinstance(record, dict) or record.keys() - _PLAYWRIGHT_FIELDS:
            raise ValueError
        name, value = _pair(record["name"], record["value"])
        domain, path = _scope(record)
        expires = record.get("expires", -1)
        if (type(expires) not in (int, float) or not math.isfinite(expires) or expires < 0 and expires != -1
                or type(record.get("secure", False)) is not bool or type(record.get("httpOnly", False)) is not bool
                or record.get("sameSite", "Lax") not in ("Strict", "Lax", "None")):
            raise ValueError
        # HTTPS is the only transport in the destination list. Preserve stricter
        # constraints on records that a browser would reject at creation time.
        secure = record.get("secure", "url" in record)
        if (name.startswith(("__Secure-", "__Host-")) and not secure
                or name.startswith("__Host-") and (domain.startswith(".") or path != "/")
                or record.get("sameSite") == "None" and not secure):
            raise ValueError
        # A plain request cannot establish a browser partition. Skip such records.
        if record.get("partitionKey") is not None or record.get("partition_key") is not None:
            continue
        cookie = _Cookie(name, value, domain, path, expires)
        if any(cookie.matches(*target) for target in _TARGETS.values()):
            cookies[(name, domain, path)] = cookie
    # Cookie request order is most specific path first, then creation order.
    now = time.time()
    return sorted((c for c in cookies.values() if c.active(now)), key=lambda c: -len(c.path))


def load_session(raw: str | None, raw_origin: str = _ITEM) -> ScopedSession:
    if raw is None:
        raise CookieConfigError("missing_jd_cookie")
    if type(raw) is not str or len(raw) > _MAX_INPUT:
        raise CookieConfigError("invalid_jd_cookie")
    if not raw.strip():
        raise CookieConfigError("missing_jd_cookie")
    try:
        if raw.lstrip().startswith("["):
            fmt = "json_array"
            cookies = _json_cookies(raw)
        else:
            fmt = "raw_header"
            cookies = _raw_cookies(raw, raw_origin)
    except (KeyError, TypeError, ValueError, RecursionError, OverflowError):
        # Raise outside the handler: even the exception context may hold input.
        pass
    else:
        if cookies:
            return ScopedSession(fmt, tuple(cookies))
        raise CookieConfigError("no_scoped_jd_cookie")
    raise CookieConfigError("invalid_jd_cookie")
