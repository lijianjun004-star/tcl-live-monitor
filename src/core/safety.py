"""Classify API names (JD functionId, MTOP api) that must never be let through discovery.

The vocabulary is the union of the verified SKU experiment's PROHIBITED_FUNCTION and PRIVATE
expressions (experiments/jd_sku_live/discovery.py), regrouped by category. Short verbs that are
also substrings of ordinary read names (``add`` in ``loadData``, ``pin`` in ``shipping``,
``log`` in ``catalog``, ``pay`` in ``repay``) are matched as whole tokens instead of substrings.
"""

from __future__ import annotations

import re

_PART = re.compile(r"[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+")
_SEPARATORS = re.compile(r"[^A-Za-z0-9]+")

# (category, substrings matched anywhere in the lower-cased name, whole tokens)
CATEGORIES: tuple[tuple[str, tuple[str, ...], frozenset[str]], ...] = (
    ("order", ("order", "purchase", "checkout", "payment", "settle"), frozenset({"pay", "buy"})),
    ("cart", ("cart",), frozenset()),
    ("auth", ("password", "passport", "login", "logout", "captcha", "fingerprint", "signin", "signup",
              "register", "account", "token", "risk", "verify", "bind"), frozenset()),
    ("telemetry", ("track", "report", "telemetry", "collect", "beacon", "click", "expose", "impress",
                   "record"), frozenset({"log", "logs"})),
    # "review" is a token so a live "preview" (直播预告) read is not mistaken for user reviews.
    ("privacy", ("address", "personal", "member", "comment", "cookie", "phone", "email",
                 "encrypted", "avatar", "nick", "mobileno", "customer", "recommendreason", "userinfo",
                 "userdata", "userprofil", "username", "userid", "userlist"),
     frozenset({"pin", "review", "reviews"})),
    ("state_change", ("upload", "submit", "create", "update", "delete", "remove", "modify", "follow",
                      "receive", "redeem", "claim", "send", "write", "save", "award", "favorite",
                      "subscribe"), frozenset({"add"})),
)
# A leading verb marks a write even when the noun looks harmless (``setLiveFlag``).
LEADING_WRITE_VERBS = frozenset({"add", "set", "del", "do", "put", "save", "submit", "create", "update",
                                 "remove", "delete", "modify", "send", "receive", "claim", "redeem", "buy",
                                 "bind", "sign", "follow", "join"})
# Prefixes long enough to be unambiguous inside all-lowercase compound names (``addcart``).
LOWERCASE_WRITE_PREFIXES = ("add", "submit", "create", "update", "remove", "delete", "modify", "receive",
                            "claim", "redeem", "follow", "save", "join")


def tokens(name: str) -> list[str]:
    found = []
    for chunk in _SEPARATORS.split(name):
        found.extend(part.lower() for part in _PART.findall(chunk))
    return found


def classify_unsafe_name(name: str | None) -> str | None:
    """Return the blocking category for an API name, or None when it may pass with an audit."""
    if not name:
        return None
    lowered = name.lower()
    parts = tokens(name)
    for category, substrings, whole in CATEGORIES:
        if any(word in lowered for word in substrings) or any(part in whole for part in parts):
            return category
    chunks = [chunk for chunk in _SEPARATORS.split(name) if chunk]
    for chunk in chunks:
        chunk_parts = tokens(chunk)
        if chunk_parts and chunk_parts[0] in LEADING_WRITE_VERBS and len(chunk_parts) > 1:
            return "state_change"
        if chunk.islower() and chunk.startswith(LOWERCASE_WRITE_PREFIXES):
            return "state_change"
    return None
