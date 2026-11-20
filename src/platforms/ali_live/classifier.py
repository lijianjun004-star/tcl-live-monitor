"""Python port of the verified Tmall/Taobao guest classifiers. Semantics follow the JS sources:

* probes/lib/tmall.mjs            classifyTmall, pickBest, parseJSONOrJSONP
* probes/r329/tmall-receipt.mjs   isAccessLimit, isLimitUrl
* probes/r334/tmall-network.mjs   isLiveDetailUrl, responseLimit, endpointEvidence

Only fields those files already read are used. JS truthiness, ``??`` and ``String()`` are
reproduced by small helpers so that e.g. ``Number(null)`` can never prove OFFLINE.
"""

from __future__ import annotations

import json
import math
import re
from datetime import datetime, timezone
from urllib.parse import urlsplit

from core.errors import Code

LIVE_PAGE = "https://h5.m.taobao.com/taolive/video.html?userId="
DETAIL_HOST = "h5api.m.taobao.com"
DETAIL_PATH = "/h5/mtop.mediaplatform.live.livedetail/4.0"
_MISSING = object()
LIMIT = re.compile(r"RGV587|USER_VALIDATE|ILLEGAL_ACCESS|FLOW_LIMIT|TRAFFIC_LIMIT|SESSION_EXPIRED|NEED_LOGIN", re.I)
LOGIN_LIMIT = re.compile(r"SESSION_EXPIRED|NEED_LOGIN", re.I)
MTOP_PATH = re.compile(r"^/h5/mtop\.[a-z0-9._-]{1,160}/\d+\.\d+/?$")


# --- JS semantics helpers -------------------------------------------------------------------
def js_truthy(value) -> bool:
    if value is _MISSING or value is None or value is False:
        return False
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return value != 0 and not (isinstance(value, float) and math.isnan(value))
    if isinstance(value, str):
        return value != ""
    return True  # objects and arrays are always truthy in JS


def js_string(value) -> str:
    if value is _MISSING:
        return "undefined"
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, float):
        if math.isnan(value):
            return "NaN"
        if math.isinf(value):
            return "Infinity" if value > 0 else "-Infinity"
        return str(int(value)) if value.is_integer() else repr(value)
    if isinstance(value, int):
        return str(value)
    if isinstance(value, dict):
        return "[object Object]"
    if isinstance(value, list):
        return ",".join("" if item is None else js_string(item) for item in value)
    return str(value)


def get(obj, key):
    return obj.get(key, _MISSING) if isinstance(obj, dict) else _MISSING


def coalesce(*values):
    """JS ``a ?? b ?? c``."""
    for value in values:
        if value is not _MISSING and value is not None:
            return value
    return values[-1]


def clean(value) -> str:
    return re.sub(r"\s+", "", js_string(coalesce(value, ""))).strip()


def status_enum(value, maximum: int):
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        if isinstance(value, float) and (not math.isfinite(value) or not value.is_integer()):
            return None
        value = int(value)
        return value if 0 <= value <= maximum else None
    if isinstance(value, str) and re.fullmatch(r"[012]", value):
        status = int(value)
        return status if status <= maximum else None
    return None
# --- end helpers ----------------------------------------------------------------------------


def parse_json_or_jsonp(raw):
    text = js_string(raw if raw is not None else "").strip()
    try:
        return json.loads(text)
    except ValueError:
        pass
    left, right = text.find("("), text.rfind(")")
    if left < 1 or right <= left or not re.fullmatch(r"[a-zA-Z_$][\w.$]{0,63}", text[:left].strip()):
        raise ValueError("Unrecognized JSON/JSONP")
    return json.loads(text[left + 1:right])


def classify_tmall(payload, target: dict) -> dict:
    """``target`` keys: account_id, display_name, room_number (optional)."""
    ret_raw = get(payload, "ret")
    ret = [x for x in ret_raw if isinstance(x, str)][:3] if isinstance(ret_raw, list) else []
    if not any(x.startswith("SUCCESS") for x in ret):
        return {"state": "UNKNOWN", "reason": "API_ERROR", "apiRet": [x.split("::")[0] for x in ret]}
    d = get(payload, "data")
    b = get(d, "broadCaster")
    if not js_truthy(d) or not js_truthy(b):
        return {"state": "UNKNOWN", "reason": "MISSING_BROADCASTER"}
    room_number = js_string(coalesce(get(b, "roomNum"), get(d, "roomNum"), ""))
    name = get(b, "accountName")
    observed = {"accountId": js_string(coalesce(get(b, "accountId"), "")),
                "name": js_string(name if js_truthy(name) else ""), "roomNumber": room_number}
    if observed["accountId"] != target["account_id"] or clean(observed["name"]) != clean(target["display_name"]):
        return {"state": "UNKNOWN", "reason": "IDENTITY_MISMATCH", "observed": observed}
    if target.get("room_number") and str(target["room_number"]) != room_number:
        return {"state": "UNKNOWN", "reason": "ROOM_MISMATCH", "observed": observed}
    if js_string(coalesce(get(d, "roomNum"), "")) != room_number:
        return {"state": "UNKNOWN", "reason": "CONFLICTING_ROOM_NUMBERS", "observed": observed}
    room, stream = status_enum(get(d, "roomStatus"), 2), status_enum(get(d, "streamStatus"), 1)
    if room is None or stream is None:
        return {"state": "UNKNOWN", "reason": "UNRECOGNIZED_STATUS", "observed": observed}
    live_id = js_string(coalesce(get(d, "liveId"), ""))
    start = js_string(coalesce(get(d, "startTime"), ""))
    source_start = None
    if re.fullmatch(r"\d{13}", start) and int(start) > 0:
        source_start = datetime.fromtimestamp(int(start) / 1000, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    base = {"state": "UNKNOWN", "reason": "AMBIGUOUS_STATUS", "observed": observed, "roomStatus": room,
            "streamStatus": stream, "liveId": live_id or None, "sourceStartTime": source_start}
    if (room == 1 and stream == 1 and js_string(get(d, "accountId")) == target["account_id"]
            and re.fullmatch(r"\d{5,24}", live_id) and int(live_id) > 0):
        return {**base, "state": "LIVE", "reason": None}
    if room in (0, 2) and stream == 0 and (not live_id or live_id == "0"):
        return {**base, "state": "OFFLINE", "reason": None, "offlineEvidence": True}
    return base


def pick_best(samples: list[dict]) -> dict | None:
    return (next((x for x in samples if x.get("state") in ("LIVE", "OFFLINE")), None)
            or next((x for x in samples if x.get("reason") == "IDENTITY_MISMATCH"), None)
            or (samples[-1] if samples else None))


def is_access_limit(sample: dict | None) -> bool:
    api_ret = (sample or {}).get("apiRet")
    return isinstance(api_ret, list) and any(LIMIT.search(str(x)) for x in api_ret)


def _host(url: str):
    try:
        parts = urlsplit(url)
        return parts, (parts.hostname or "").rstrip(".").lower()
    except ValueError:
        return None, ""


def limit_url_kind(url: str) -> str | None:
    """isLimitUrl(), split into login vs challenge. ``x5sec`` is an added challenge marker."""
    parts, host = _host(url)
    if not parts or parts.scheme not in ("https", "http") or not re.search(r"(^|\.)(taobao|tmall)\.com$", host):
        return None
    if re.search(r"(^|\.)login\.(?:m\.)?(taobao|tmall)\.com$", host):
        return "login"
    path_query = parts.path + ("?" + parts.query if parts.query else "")
    if re.search(r"(^|\.)sec\.taobao\.com$", host) or re.search(r"punish|captcha|_____tmd_____|x5sec", path_query, re.I):
        return "challenge"
    return None


def is_limit_url(url: str) -> bool:
    return limit_url_kind(url) is not None


def is_live_detail_url(url: str) -> bool:
    parts, host = _host(url)
    return bool(parts) and host == DETAIL_HOST and parts.path.rstrip("/") == DETAIL_PATH


def response_limit(url: str, status: int, navigation: bool = False) -> str | None:
    return f"HTTP_{status}" if status in (401, 403, 429) and (navigation or is_live_detail_url(url)) else None


def endpoint_evidence(url: str, status: int) -> dict | None:
    parts, host = _host(url)
    if not parts or host != DETAIL_HOST or not MTOP_PATH.fullmatch(parts.path):
        return None
    return {"path": parts.path, "http": status}


def map_sample(sample: dict | None) -> tuple[Code, str]:
    """Classifier verdict -> unified code (SPEC.md 3.2)."""
    if not sample:
        return Code.NAV_TIMEOUT, "signal_not_observed_within_budget"
    state, why = sample.get("state"), sample.get("reason")
    if state == "LIVE":
        return Code.OK, "live_detail_room_and_stream_on"
    if state == "OFFLINE":
        return Code.OFFLINE, "live_detail_room_and_stream_off"
    if why in ("IDENTITY_MISMATCH", "ROOM_MISMATCH", "CONFLICTING_ROOM_NUMBERS"):
        return Code.REDIRECTED, why.lower()
    if why == "API_ERROR" and is_access_limit(sample):
        if any(LOGIN_LIMIT.search(str(x)) for x in sample.get("apiRet", [])):
            return Code.LOGIN_REQUIRED, "api_need_login"
        return Code.CAPTCHA_X5SEC, "api_access_limit"
    return Code.SCHEMA_MISMATCH, (why or "unclassified").lower()
