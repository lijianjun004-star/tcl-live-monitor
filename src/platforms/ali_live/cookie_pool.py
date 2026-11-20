"""Optional per-group cookies (guest mode when a group has none). Values never leave memory.

Secrets: ``ALI_COOKIE_GROUP_1`` .. ``ALI_COOKIE_GROUP_3``, each a raw ``k=v; k2=v2`` header.
A group that holds any Tmall target receives the same cookies on ``.taobao.com`` and
``.tmall.com`` so a hop between the two domains does not fall into a login wall.
"""

from __future__ import annotations

import re
from typing import Iterable, Mapping

GROUPS = (1, 2, 3)
ENV_NAME = "ALI_COOKIE_GROUP_{}"
TAOBAO_DOMAIN = ".taobao.com"
TMALL_DOMAIN = ".tmall.com"
NAME = re.compile(r"^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$")
VALUE = re.compile(r'^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E"]{0,4096}$')
MAX_HEADER = 16 * 1024
MAX_COOKIES = 80


class CookieError(ValueError):
    """A cookie secret is malformed. The message names the group only, never the value."""


class CookieGroup:
    __slots__ = ("group", "_pairs")

    def __init__(self, group: int, pairs: tuple[tuple[str, str], ...]):
        self.group = group
        self._pairs = pairs

    def __repr__(self) -> str:
        return f"CookieGroup(group={self.group}, cookies={len(self._pairs)}, values=<redacted>)"

    __str__ = __repr__

    @property
    def names(self) -> list[str]:
        return sorted({name for name, _ in self._pairs})

    def playwright_cookies(self, domains: Iterable[str]) -> list[dict]:
        return [
            {"name": name, "value": value, "domain": domain, "path": "/", "secure": True,
             "httpOnly": False, "sameSite": "None"}
            for domain in domains for name, value in self._pairs
        ]


def parse_cookie_header(raw: str, group: int) -> CookieGroup:
    if len(raw) > MAX_HEADER or any(ch in raw for ch in "\r\n\x00"):
        raise CookieError(f"ALI_COOKIE_GROUP_{group} is too long or contains control characters")
    pairs = []
    for chunk in raw.split(";"):
        chunk = chunk.strip()
        if not chunk:
            continue
        name, sep, value = chunk.partition("=")
        name, value = name.strip(), value.strip()
        if not sep or not NAME.fullmatch(name) or not VALUE.fullmatch(value):
            raise CookieError(f"ALI_COOKIE_GROUP_{group} has a malformed cookie pair")
        pairs.append((name, value))
    if not pairs or len(pairs) > MAX_COOKIES:
        raise CookieError(f"ALI_COOKIE_GROUP_{group} must hold 1..{MAX_COOKIES} cookies")
    return CookieGroup(group, tuple(pairs))


def domains_for(platforms: Iterable[str]) -> tuple[str, ...]:
    platforms = set(platforms)
    return (TAOBAO_DOMAIN, TMALL_DOMAIN) if "tmall" in platforms else (TAOBAO_DOMAIN,)


class CookiePool:
    def __init__(self, groups: Mapping[int, CookieGroup] | None = None):
        self._groups = dict(groups or {})

    @classmethod
    def from_env(cls, env: Mapping[str, str]) -> "CookiePool":
        groups = {}
        for group in GROUPS:
            raw = (env.get(ENV_NAME.format(group)) or "").strip()
            if raw:
                groups[group] = parse_cookie_header(raw, group)
        return cls(groups)

    def __repr__(self) -> str:
        return f"CookiePool(groups={sorted(self._groups)})"

    def mode(self, group: int) -> str:
        return "cookie" if group in self._groups else "guest"

    def cookies_for(self, group: int, platforms: Iterable[str]) -> list[dict]:
        cookie_group = self._groups.get(group)
        return cookie_group.playwright_cookies(domains_for(platforms)) if cookie_group else []
