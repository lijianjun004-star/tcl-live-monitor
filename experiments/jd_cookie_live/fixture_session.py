"""Offline cookie fixture. Accepted pairs are fixed test vectors, never account credentials."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from urllib.parse import urlsplit


_VALUES = {"fixture_one": "example-a", "fixture_two": "example-b="}
_HOSTS = {"item.m.jd.com", "shop.m.jd.com"}
RAW_COOKIE_FIXTURE = "; ".join(f"{name}={value}" for name, value in _VALUES.items())
JSON_COOKIE_FIXTURE = json.dumps([
    {"name": "fixture_one", "value": _VALUES["fixture_one"], "domain": "item.m.jd.com", "path": "/"},
    {"name": "fixture_two", "value": _VALUES["fixture_two"], "domain": "shop.m.jd.com", "path": "/"},
])


class FixtureCookieError(ValueError):
    """Only a fixed reason, safe to include in a report."""


def _scope(url: str) -> tuple[str, str]:
    parsed = urlsplit(url)
    if parsed.scheme != "https" or parsed.netloc not in _HOSTS:
        raise FixtureCookieError("invalid_fixture_origin")
    return parsed.netloc, parsed.path or "/"


@dataclass(frozen=True)
class FixtureSession:
    cookie_format_detected: str
    # Only host, path and dummy name are needed to model replacement / visibility.
    _keys: frozenset[tuple[str, str, str]] = field(repr=False)

    @property
    def cookie_injected_count(self) -> int:
        return len(self._keys)

    def count_for(self, url: str) -> int:
        """Simulate the number visible to this exact HTTPS host and matching path."""
        try:
            host, path = _scope(url)
        except ValueError:
            return 0
        return sum(
            host == cookie_host and (path == prefix or path.startswith(prefix.rstrip("/") + "/"))
            for cookie_host, prefix, _ in self._keys
        )


def load_fixture_session(raw: str | None, *, origin: str = "https://item.m.jd.com") -> FixtureSession:
    if raw is None or (isinstance(raw, str) and not raw.strip()):
        raise FixtureCookieError("missing_jd_cookie")
    if not isinstance(raw, str) or len(raw) > 16_384:
        raise FixtureCookieError("invalid_cookie_fixture")
    raw = raw.strip()
    keys = set()
    try:
        if raw.startswith("["):
            cookie_format = "json_array"
            records = json.loads(raw)
        else:
            cookie_format = "raw_header"
            # A header carries no domain information. Bind it only to the stated origin.
            origin_host, origin_path = _scope(origin)
            if origin_path != "/" or any(c in raw for c in "\n\r\x00"):
                raise ValueError
            records = []
            for pair in raw.split(";"):
                name, separator, value = pair.strip().partition("=")
                if not separator:
                    raise ValueError
                records.append({"name": name, "value": value, "domain": origin_host, "path": "/"})
        if not isinstance(records, list) or not records:
            raise ValueError
        for record in records:
            name = record["name"]
            if name not in _VALUES or record["value"] != _VALUES[name]:
                raise ValueError
            if "url" in record:
                if "domain" in record or "path" in record:
                    raise ValueError
                host, path = _scope(record["url"])
                # Match Playwright's URL form: directory through the rightmost slash.
                path = path[:path.rfind("/") + 1]
            else:
                host, path = record["domain"], record["path"]
            if host not in _HOSTS or not isinstance(path, str) or not path.startswith("/"):
                raise ValueError
            keys.add((host, path, name))
    except (AttributeError, KeyError, TypeError, ValueError, RecursionError):
        # Parsing exceptions can otherwise reproduce the input in logs or tracebacks.
        pass
    else:
        return FixtureSession(cookie_format, frozenset(keys))
    raise FixtureCookieError("invalid_cookie_fixture")
