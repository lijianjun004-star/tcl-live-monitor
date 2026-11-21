"""Classify synthetic JD page and room observations without issuing requests."""

import re
from types import SimpleNamespace
from urllib.parse import parse_qs, urlsplit

import single_room_probe as legacy
from platforms.jd.discovery import HTTP_SAMPLE_FUNCTIONS, PUBLIC_LIVE_ID
from platforms.jd.policy import API_HOST, DISPLAY_NOUN, PRODUCT_READ, func_id

SKU = "100133134399"
SHOP_IDS = {"721631", "1000194977"}
ENTRY_IDS = {SKU, *SHOP_IDS}
LOGIN_HOSTS = legacy.LOGIN_HOSTS | {"passport.m.jd.com"}
CHALLENGE_HOSTS = {"safe.jd.com", "jcap.jd.com", "jcap.m.jd.com"}
ENTRY_HOSTS = {"item.m.jd.com", "shop.m.jd.com"}
DISPLAY_KEYS = {"data", "result", "page", "floor", "floors", "module", "modules", "items",
                "product", "shop", "live", "liveInfo", "liveEntry", "liveRoom", "liveRooms", "cards"}
REPORT_HOSTS = ENTRY_HOSTS | LOGIN_HOSTS | CHALLENGE_HOSTS | {API_HOST, "lives.jd.com"}
GATE_CODES = ("LOGIN_REQUIRED", "CAPTCHA_X5SEC", "ACCESS_RESTRICTED")
CHALLENGE_TEXT = ("拖动滑块", "滑动验证", "完成拼图", "安全验证", "沿图中轨迹", "请按照图中轨迹绘制", "人机验证")


def _url(value):
    if not isinstance(value, str):
        return None
    try:
        parts = urlsplit(value)
        if parts.scheme == "https" and parts.netloc.lower() in REPORT_HOSTS:
            return parts
    except ValueError:
        pass
    return None


def _entry_matches(parts, target_id):
    if not parts:
        return False
    if target_id == SKU:
        return parts.hostname == "item.m.jd.com" and parts.path == f"/product/{SKU}.html"
    return (target_id in SHOP_IDS and parts.hostname == "shop.m.jd.com"
            and parts.path in ("", "/")
            and parse_qs(parts.query, keep_blank_values=True).get("shopId") == [target_id])


def _gate(sample, final_url):
    for url in [*sample.get("redirect_chain", []), final_url]:
        parts = _url(url)
        if parts and parts.hostname in LOGIN_HOSTS:
            return "LOGIN_REQUIRED"
        if parts and parts.hostname in CHALLENGE_HOSTS:
            return "CAPTCHA_X5SEC"
    marker = sample.get("gate")
    if marker in GATE_CODES:
        return marker
    text = sample.get("visible_text", "")
    if any(word in text for word in CHALLENGE_TEXT):
        return "CAPTCHA_X5SEC"
    if any(word in text for word in legacy.GATE_TEXT[:3]):
        return "LOGIN_REQUIRED"
    if any(word in text for word in ("访问受限", "访问已被拒绝", "访问过于频繁")):
        return "ACCESS_RESTRICTED"
    return None


def _http_gate(status):
    if status in (401, 403, 429):
        return "ACCESS_RESTRICTED"
    return None


def _request(row):
    return SimpleNamespace(url=row.get("url", ""), method=row.get("method", "GET"),
                           post_data=row.get("post_data", ""),
                           headers={"content-type": row.get("content_type", "")})


def _public_name(request):
    name = func_id(request)
    if name and (name.lower() in HTTP_SAMPLE_FUNCTIONS or PRODUCT_READ.fullmatch(name)
                 or DISPLAY_NOUN.fullmatch(name) and not re.search(r"[0-9]{3}", name)):
        return name
    return None


def _room_id(url):
    if not isinstance(url, str):
        return None
    try:
        return legacy.canonical_room(url)[1]
    except ValueError:
        return None


def _payload_entries(payload):
    """Follow only page display structures; arbitrary text and private fields never leave memory."""
    stack = [payload]
    while stack:
        item = stack.pop()
        if isinstance(item, list):
            stack.extend(item)
        elif isinstance(item, dict):
            for key, value in item.items():
                if key in {"liveId", "liveRoomId", "live_id", "live_room_id"}:
                    yield "public_live_id_field", value
                elif key in {"liveUrl", "liveRoomUrl", "live_url"}:
                    yield "public_room_link", _room_id(value)
                elif key in DISPLAY_KEYS:
                    stack.append(value)


def inspect_page(sample, target_id):
    """Read one fixture. A matching landing URL establishes the entrance, not login or merchant identity."""
    url = sample.get("final_url")
    gate = _gate(sample, url) or _http_gate(sample.get("http_status"))
    matched = _entry_matches(_url(url), target_id)
    names, errors = set(), []
    document = _url(url)
    status = sample.get("http_status")
    if document and type(status) is int and 400 <= status <= 599:
        errors.append({"function_id": None, "http_status": status, "host": document.hostname})
    payloads = list(sample.get("payloads", []))
    for row in sample.get("responses", []):
        parts = _url(row.get("url"))
        if not parts:
            continue
        api = parts.hostname == API_HOST and parts.path in {"", "/", "/api", "/client.action"}
        name = _public_name(_request(row)) if api else None
        if name:
            names.add(name)
        status = row.get("http_status")
        if type(status) is not int:
            continue
        if 400 <= status <= 599:
            errors.append({"function_id": name, "http_status": status, "host": parts.hostname})
        elif 200 <= status < 300 and api and name:
            payloads.append(row.get("payload"))

    candidates, signals = set(), set()
    status = sample.get("http_status")
    has_document = sample.get("document_observed") is True or any(
        sample.get(key) for key in ("visible_text", "dom_live_ids", "dom_hrefs", "payloads"))
    page_observed = bool(matched and not gate and type(status) is int and 200 <= status < 300 and has_document)
    signal = {"LOGIN_REQUIRED": "login_gate", "CAPTCHA_X5SEC": "challenge_gate",
              "ACCESS_RESTRICTED": "access_restricted"}.get(gate)
    signal = signal or ("target_page_observed" if page_observed else "target_page_unverified")
    if page_observed:
        text = sample.get("visible_text", "")
        for word, label in (("当前商品直播中", "current_product_live"), ("商品直播切片", "product_live_clip"),
                            ("进入直播间", "watch_live"), ("看直播", "watch_live"), ("正在直播", "live_now")):
            if word in text:
                signals.add(label)
        entries = [("dom_live_id_field", value) for value in sample.get("dom_live_ids", [])]
        entries.extend(("dom_room_link", _room_id(href)) for href in sample.get("dom_hrefs", []))
        for body in payloads:
            entries.extend(_payload_entries(body))
        for label, value in entries:
            if type(value) in (str, int) and PUBLIC_LIVE_ID.fullmatch(str(value)) and str(value) not in ENTRY_IDS:
                candidates.add(str(value))
                signals.add(label)
    return {"gate": gate, "target_identity_matched": matched, "page_observed": page_observed,
            "login_state_signal": signal, "observed_function_ids": sorted(names),
            "http_error_samples": errors, "live_entry_signals": sorted(signals),
            "candidate_live_ids": sorted(candidates)}


def classify_candidate(live_id, sample):
    """Apply the production getImmediatePlayToM admission and status rules to a mock response."""
    sample = sample or {}
    valid_id = isinstance(live_id, str) and PUBLIC_LIVE_ID.fullmatch(live_id) and live_id not in ENTRY_IDS
    result = {"live_id": live_id if valid_id else None, "code": "UNVERIFIED", "live_status": "unknown", "detect_ms": None,
              "room_id_matched": False, "elapsed_ms": None, "gate": None, "observed_function_ids": [], "http_error_samples": []}
    if not valid_id:
        return result
    page_url = sample.get("page_url")
    gate = _gate(sample, page_url)
    request = _request(sample)
    parts = _url(request.url)
    admitted = (parts and request.url == sample.get("response_url", request.url)
                and legacy.detail_request_rejection(request) is None)
    status = sample.get("http_status")
    if admitted:
        elapsed = sample.get("detect_ms")
        if _room_id(page_url) == live_id and type(elapsed) is int and elapsed >= 0:
            result["elapsed_ms"] = elapsed
        result["observed_function_ids"].append(legacy.TARGET_FUNCTION)
        if type(status) is int and 400 <= status <= 599:
            result["http_error_samples"].append({"function_id": legacy.TARGET_FUNCTION, "http_status": status,
                                                 "host": API_HOST})
        gate = gate or _http_gate(status)
    if gate:
        result.update(code=gate, gate=gate)
        return result
    if (not admitted or type(status) is not int or not 200 <= status < 300
            or _room_id(page_url) != live_id):
        return result
    detail = legacy.public_detail(request, sample.get("payload"), live_id)
    if not detail:
        return result
    if detail.get("restricted"):
        result.update(code="ACCESS_RESTRICTED", gate="ACCESS_RESTRICTED")
        return result
    state = detail["state"]
    result.update(code={"live": "OK", "offline": "OFFLINE", "replay": "OFFLINE"}.get(state, "SCHEMA_MISMATCH"),
                  live_status=state, room_id_matched=True,
                  detect_ms=result["elapsed_ms"] if state != "unknown" else None)
    return result
