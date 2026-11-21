"""Unified error codes shared by every layer (SPEC.md section 3)."""

from __future__ import annotations

import re
from enum import Enum


class Code(str, Enum):
    OK = "OK"
    OFFLINE = "OFFLINE"
    REDIRECTED = "REDIRECTED"
    LOGIN_REQUIRED = "LOGIN_REQUIRED"
    CAPTCHA_X5SEC = "CAPTCHA_X5SEC"
    GROUP_CIRCUIT_OPEN = "GROUP_CIRCUIT_OPEN"
    NAV_TIMEOUT = "NAV_TIMEOUT"
    POST_AUDIT_BLOCKED = "POST_AUDIT_BLOCKED"
    SCHEMA_MISMATCH = "SCHEMA_MISMATCH"

    def __str__(self) -> str:  # json.dumps(Code.OK) must stay "OK"
        return self.value


# Any of these, in any layer, trips the room's group breaker.
TRIPPING_CODES = frozenset({Code.LOGIN_REQUIRED, Code.CAPTCHA_X5SEC})
DETERMINED_CODES = frozenset({Code.OK, Code.OFFLINE})
LIVE_STATUSES = ("live", "offline", "replay", "unknown")

_REASON = re.compile(r"^[a-z0-9_]{1,64}$")
_REASON_CHARS = re.compile(r"[^a-z0-9_]+")


def reason(value: object) -> str | None:
    """Normalise a sub-code into the contract's reason format; never carries free text."""
    if value is None:
        return None
    text = _REASON_CHARS.sub("_", str(value).strip().lower()).strip("_")[:64]
    return text if _REASON.fullmatch(text) else None


def coerce_status(code: Code, live_status: str | None) -> str:
    """Enforce the snapshot invariant: only OK/OFFLINE may carry a determined status."""
    if code is Code.OK:
        if live_status != "live":
            raise ValueError("Code.OK requires live_status=live")
        return "live"
    if code is Code.OFFLINE:
        if live_status not in ("offline", "replay"):
            raise ValueError("Code.OFFLINE requires live_status offline or replay")
        return live_status
    return "unknown"
