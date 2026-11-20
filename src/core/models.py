"""Builders that always emit the frozen contract shapes (SPEC.md sections 5 and 6)."""

from __future__ import annotations

import statistics
from collections import Counter
from dataclasses import dataclass, field

from .config import Target
from .errors import DETERMINED_CODES, Code, coerce_status, reason as clean_reason
from .timeutil import iso

AUDIT_MAX_KEYS = 40


@dataclass
class Resolution:
    """Raw result of one discovery attempt, before cache degradation."""

    code: Code
    reason: str | None = None
    live_id: str | None = None
    room_url: str | None = None
    verification: str = "none"
    networked: bool = False
    audit: dict = field(default_factory=dict)

    @classmethod
    def failure(cls, code: Code, reason: str | None, *, networked: bool = True, audit: dict | None = None):
        return cls(code=code, reason=reason, networked=networked, audit=audit or {})


def bounded_audit(audit: dict | None) -> dict:
    audit = dict(audit or {})
    return {key: audit[key] for key in sorted(audit)[:AUDIT_MAX_KEYS]}


def resolved_room(target: Target, *, code: Code, reason: str | None, source: str, live_id: str | None,
                  room_url: str | None, resolved_at: str | None, cache_age_seconds: int | None,
                  verification: str, audit: dict | None) -> dict:
    return {
        "target_key": target.key,
        "platform": target.platform,
        "account_group": target.account_group,
        "discovery_mode": target.mode,
        "code": Code(code).value,
        "reason": clean_reason(reason),
        "source": source,
        "live_id": live_id,
        "room_url": room_url,
        "resolved_at": resolved_at,
        "cache_age_seconds": cache_age_seconds,
        "verification": verification,
        "audit": bounded_audit(audit),
    }


def keyword_hits(title: str | None, keywords: tuple[str, ...]) -> list[str]:
    if not title:
        return []
    folded = title.casefold()
    return sorted({word for word in keywords if word.casefold() in folded})


def snapshot_room(target: Target, resolved: dict, *, code: Code, reason: str | None,
                  live_status: str | None = None, observed_at: str | None = None, elapsed_ms: int = 0,
                  detect_ms: int | None = None, live_id: str | None = None, online_count: int | None = None,
                  item_title: str | None = None, item_price: float | None = None, thumbnail: str | None = None,
                  diagnostics: dict | None = None, keywords: tuple[str, ...] = ()) -> dict:
    code = Code(code)
    status = coerce_status(code, live_status)
    determined = code in DETERMINED_CODES
    return {
        "target_key": target.key,
        "platform": target.platform,
        "display_name": target.display_name,
        "account_group": target.account_group,
        "live_id": live_id if live_id is not None else resolved.get("live_id"),
        "room_url": resolved.get("room_url"),
        "code": code.value,
        "reason": clean_reason(reason),
        "live_status": status,
        "observed_at": observed_at or iso(),
        "elapsed_ms": max(0, int(elapsed_ms)),
        "detect_ms": None if detect_ms is None else max(0, int(detect_ms)),
        "online_count": online_count if determined else None,
        "item_title": item_title if determined else None,
        "item_price": item_price if determined else None,
        "keywords_hit": keyword_hits(item_title, keywords) if determined else [],
        "thumbnail": thumbnail if determined else None,
        "discovery": {
            "code": resolved["code"],
            "reason": resolved["reason"],
            "source": resolved["source"],
            "mode": resolved["discovery_mode"],
        },
        "diagnostics": bounded_audit(diagnostics),
    }


def inherited_room(target: Target, resolved: dict, code: Code | None = None, reason: str | None = None,
                   keywords: tuple[str, ...] = ()) -> dict:
    """A room that made no monitor request: inherits the discovery code or a breaker code."""
    if code is None:
        code, reason = Code(resolved["code"]), resolved["reason"]
        if code in DETERMINED_CODES:  # cannot happen per contract; never fabricate a state
            code, reason = Code.SCHEMA_MISMATCH, "room_url_missing"
    return snapshot_room(target, resolved, code=code, reason=reason, keywords=keywords,
                         diagnostics={"network_requests": 0})


def summarize(rooms: list[dict], open_groups: list[str]) -> dict:
    codes = Counter(room["code"] for room in rooms)
    detects = [room["detect_ms"] for room in rooms if room["detect_ms"] is not None]
    return {
        "total": len(rooms),
        "live": sum(room["live_status"] == "live" for room in rooms),
        "offline": sum(room["live_status"] in ("offline", "replay") for room in rooms),
        "abnormal": sum(room["code"] not in ("OK", "OFFLINE") for room in rooms),
        "by_code": dict(sorted(codes.items())),
        "by_platform": dict(sorted(Counter(room["platform"] for room in rooms).items())),
        "circuit_open_groups": sorted(set(open_groups)),
        "max_detect_ms": max(detects) if detects else None,
        "median_detect_ms": int(statistics.median(detects)) if detects else None,
    }
