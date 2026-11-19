"""One anonymous, read-only observation of the public JD Live room page."""

from __future__ import annotations

import argparse
import asyncio
import io
import json
import math
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

from PIL import Image
from playwright.async_api import Error as PlaywrightError, async_playwright

DEFAULT_URL = "https://lives.jd.com/#/49620440"
PUBLIC_HOSTS = {"lives.jd.com", "api.m.jd.com"}
LOGIN_HOSTS = {"plogin.m.jd.com", "passport.jd.com", "login.jd.com"}
GATE_TEXT = (
    "京东登录注册", "账号密码登录", "请登录后观看", "拖动滑块",
    "安全验证", "沿图中轨迹", "请按照图中轨迹绘制", "人机验证",
    "访问受限", "访问已被拒绝",
)
MEDIA_SUFFIX = (".flv", ".m3u8", ".mp4", ".ts", ".m4s", ".aac", ".fmp4")
STATIC_SUFFIX = (".js", ".css", ".png", ".jpg", ".jpeg", ".webp", ".woff2", ".svg")
SOURCE_PATH = re.compile(r"^/(?:[A-Za-z][A-Za-z0-9_.-]{0,23}/)*[A-Za-z][A-Za-z0-9_.-]{0,23}$")
SAFE_HOST = re.compile(r"^[a-z0-9-]{1,31}(?:\.[a-z0-9-]{1,31}){0,8}$")
FUNCTION_ID = re.compile(r"^[A-Za-z0-9_.-]{1,48}$")
SAFE_KEY = re.compile(r"^[A-Za-z_][A-Za-z0-9_.-]{0,40}$")
SENSITIVE_KEY = re.compile(
    r"token|cookie|authorization|secret|password|phone|email|openid|unionid|\d{5,}",
    re.IGNORECASE,
)
DIAGNOSTIC_CODE = re.compile(r"^-?\d{1,8}$|^[A-Z][A-Z0-9_-]{0,23}$")
JSONP = re.compile(r"^[A-Za-z_$][\w$.]{0,99}\s*\(([\s\S]*)\)\s*;?$")
ROOM_FRAGMENT = re.compile(r"^/([1-9][0-9]{4,17})(?:/live)?(?:\?.*)?$")
MAX_BODY = 384 * 1024
MAX_RESPONSES = 40
MAX_FRAMES = 40
MAX_TARGET_REQUESTS = 40
MAX_FUNCTION_IDS = 80
MAX_TARGET_SAMPLES = 5
TARGET_FUNCTION = "getImmediatePlayToM"
KNOWN_FRAGMENT_SEGMENTS = {"detail", "home", "index", "live", "live-room", "player", "replay", "room"}


def canonical_room(url: str) -> tuple[str, str]:
    parts = urlsplit(url)
    room = ROOM_FRAGMENT.fullmatch(parts.fragment)
    if (
        parts.scheme != "https" or parts.netloc != "lives.jd.com"
        or parts.path not in {"", "/"} or parts.query or not room
    ):
        raise ValueError("ROOM_URL must be an exact https://lives.jd.com/#/<numeric-room-id> URL")
    room_id = room.group(1)
    return f"https://lives.jd.com/#/{room_id}", room_id


def timestamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def redact_path(path: str) -> str:
    path = unquote(path) or "/"
    if path == "/" or (SOURCE_PATH.fullmatch(path) and not re.search(r"\d{5,}", path)):
        return path
    return "/[redacted]"


def source_label(url: str) -> str:
    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.hostname}{redact_path(parts.path)}"


def redacted_fragment_shape(fragment: str) -> str:
    route = unquote(fragment).split("?", 1)[0].split("#", 1)[0]
    if not route:
        return ""
    segments = []
    for segment in route.split("/", 9)[:9]:
        if not segment or segment in KNOWN_FRAGMENT_SEGMENTS:
            segments.append(segment)
            continue
        # Unknown segment values can contain tokens, so retain only route shape.
        if re.fullmatch(r"[0-9]{1,4}", segment):
            segments.append(segment)
            continue
        chunks = re.split(r"([0-9]{5,})", segment[:160], maxsplit=4)
        segments.append("".join("<id>" if index % 2 else "<segment>"
                                for index, chunk in enumerate(chunks) if chunk))
    return "/".join(segments)


def eligible(url: str) -> bool:
    parts = urlsplit(url)
    if parts.scheme not in {"https", "wss"} or parts.netloc not in PUBLIC_HOSTS:
        return False
    path = unquote(parts.path).casefold()
    return not path.endswith(STATIC_SUFFIX + MEDIA_SUFFIX) and not re.search(
        r"(?:^|/)(?:login|passport|captcha|oauth|verify|account|token)(?:/|$)", path
    )


def decode_json(text: str):
    source = text.strip().lstrip("\ufeff")
    if not source.startswith(("{", "[")):
        wrapper = JSONP.fullmatch(source)
        if not wrapper:
            return None
        source = wrapper.group(1)
    try:
        return json.loads(source)
    except (ValueError, RecursionError):
        return None


def form_function_ids(value: str) -> list:
    try:
        return parse_qs(value, max_num_fields=120).get("functionId", [])
    except ValueError:
        return []


def request_function_ids(request) -> tuple[set[str], str | None]:
    parts = urlsplit(request.url)
    if (
        parts.scheme != "https" or parts.netloc != "api.m.jd.com"
        or (parts.path or "/") not in {"/", "/api"}
        or request.method not in {"GET", "POST"}
    ):
        return set(), None
    query_ids = form_function_ids(parts.query)
    post_ids = []
    post_source = None
    if request.method == "POST":
        try:
            body = request.post_data or ""
        except (PlaywrightError, UnicodeError):
            body = ""
        if len(body) <= 64 * 1024:
            decoded = decode_json(body)
            if isinstance(decoded, dict):
                post_ids = [decoded.get("functionId")]
                post_source = "post_json"
            elif not body.lstrip().startswith(("{", "[")):
                post_ids = form_function_ids(body)
                post_source = "post_form"
    in_query = TARGET_FUNCTION in query_ids
    in_post = TARGET_FUNCTION in post_ids
    source = "both" if in_query and in_post else "query" if in_query else post_source if in_post else None
    valid = {value for value in query_ids + post_ids if isinstance(value, str) and FUNCTION_ID.fullmatch(value)}
    return valid, source


def mime_category(mime: str) -> str:
    if not mime:
        return "missing"
    if mime == "application/json" or mime.endswith("+json"):
        return "json"
    if mime in {"text/javascript", "application/javascript"}:
        return "javascript"
    if mime == "text/plain":
        return "text_plain"
    return "other"


def safe_code(value):
    if value is None:
        return None
    # Codes may be strings in the public envelope; free-form messages never leave memory.
    return value if type(value) in (int, str) and DIAGNOSTIC_CODE.fullmatch(str(value)) else "[redacted]"


def diagnose_target(http_status: int, payload, room_id: str) -> tuple[str, dict]:
    envelope = payload if isinstance(payload, dict) else {}
    codes = [envelope.get(key) for key in ("code", "subCode")]
    has_error_code = any(type(code) in (int, str) and str(code) != "0" for code in codes)
    if not 200 <= http_status < 300 or has_error_code:
        return "error", {"http_status": http_status, "code": safe_code(envelope.get("code")),
                         "subCode": safe_code(envelope.get("subCode"))}
    data = envelope.get("data")
    if (
        not all(type(code) in (int, str) and str(code) == "0" for code in codes)
        or not isinstance(data, dict) or type(data.get("liveId")) not in (int, str)
        or not re.fullmatch(r"[1-9][0-9]{4,17}", str(data["liveId"]))
        or type(data.get("status")) not in (int, str)
    ):
        return "schema_mismatch", {"http_status": http_status, "top_level_keys": sorted(
            key for key in envelope if SAFE_KEY.fullmatch(key) and not SENSITIVE_KEY.search(key)
        )[:16]}
    if str(data["liveId"]) != room_id:
        return "room_mismatch", {}
    return "matched", {}


class ProbeDiagnostics:
    """Keep bounded, non-identifying metadata for requests observed in this browser."""

    def __init__(self) -> None:
        self.function_ids: set[str] = set()
        self.targets: dict = {}
        self.sources: dict = {}
        self.samples: dict = {}
        self.truncated = False

    def register(self, request) -> bool:
        if request in self.targets:
            return True
        function_ids, source = request_function_ids(request)
        for function_id in sorted(function_ids - self.function_ids):
            if len(self.function_ids) >= MAX_FUNCTION_IDS:
                self.truncated = True
                break
            self.function_ids.add(function_id)
        if TARGET_FUNCTION not in function_ids:
            return False
        if len(self.targets) >= MAX_TARGET_REQUESTS:
            self.truncated = True
            return False
        self.targets[request] = None
        self.sources[request] = source
        return True

    def sample_response(self, response, content: str, eligible_probe: bool, arrival_count: int) -> None:
        request = response.request
        if request in self.samples or len(self.samples) >= MAX_TARGET_SAMPLES:
            return
        parts = urlsplit(request.url)
        category = mime_category(content)
        reason = None
        if 200 <= response.status < 300:
            ids = form_function_ids(parts.query)
            if category not in {"json", "javascript"}:
                reason = "mime_not_allowed"
            elif arrival_count >= MAX_RESPONSES:
                reason = "max_responses_reached"
            elif parts.path != "/api":
                reason = "path_not_api"
            elif len(ids) > 1:
                reason = "duplicate_query_function_id"
            elif ids != [TARGET_FUNCTION]:
                reason = "function_id_not_in_query"
        self.samples[request] = {
            "method": request.method,
            "safe_path": parts.path or "/",
            "function_id_source": self.sources[request],
            "mime_category": category,
            "eligible_probe": eligible_probe,
            "response_count_at_arrival": arrival_count,
            "rejected_reason": reason,
        }

    def accepted_by_original_rule(self, request) -> None:
        if request in self.samples:
            self.samples[request]["rejected_reason"] = "accepted"

    def finish(self, request, outcome: tuple[str, dict]) -> None:
        if request in self.targets and self.targets[request] is None:
            self.targets[request] = outcome

    def report(self) -> dict:
        outcomes = [outcome or ("unclassified", {}) for outcome in self.targets.values()]
        return {
            "observed_function_ids": sorted(self.function_ids),
            "target_request_seen": len(self.targets),
            "target_error_count": sum(kind == "error" for kind, _ in outcomes),
            "target_schema_mismatch_count": sum(kind == "schema_mismatch" for kind, _ in outcomes),
            "target_room_mismatch_count": sum(kind == "room_mismatch" for kind, _ in outcomes),
            "target_matched_count": sum(kind == "matched" for kind, _ in outcomes),
            "target_unclassified_count": sum(kind == "unclassified" for kind, _ in outcomes),
            "target_error_samples": [detail for kind, detail in outcomes if kind == "error"][:10],
            "target_schema_samples": [detail for kind, detail in outcomes if kind == "schema_mismatch"][:10],
            "target_request_samples": list(self.samples.values()),
            "truncated": self.truncated,
        }


def public_detail(url: str, payload, room_id: str) -> dict | None:
    """Only the documented JD page detail's response can establish a state."""
    parts = urlsplit(url)
    if (
        parts.scheme != "https" or parts.netloc != "api.m.jd.com" or parts.path != "/api"
        or form_function_ids(parts.query) != [TARGET_FUNCTION]
        or not isinstance(payload, dict)
        or str(payload.get("code")) != "0" or str(payload.get("subCode")) != "0"
    ):
        return None
    data = payload.get("data")
    if not isinstance(data, dict) or str(data.get("liveId")) != room_id:
        return None
    if data.get("secret") is not None and str(data["secret"]) != "0":
        return {"restricted": True}
    state = {"1": "live", "2": "offline", "3": "replay"}.get(str(data.get("status")), "unknown")
    viewers = data.get("onlineCount")
    if type(viewers) is not int or not 0 <= viewers <= 1_000_000_000:
        viewers = None
    current = data.get("currentItem")
    title, price = None, None
    if isinstance(current, dict):
        value = current.get("title")
        if (
            isinstance(value, str) and 0 < len(value) <= 100
            and re.fullmatch(r"[\w\s.,+/（）()，、【】\-]+", value)
            and not re.search(r"\d{7,}", value)
        ):
            title = value
        value = current.get("price")
        if type(value) in {int, float} and 0 <= value <= 1_000_000:
            price = value if math.isfinite(value) else None
    return {"state": state, "online_count": viewers, "item_title": title, "item_price": price}


def final_evidence(result: dict, records: list[dict], blocked: bool) -> None:
    result["login_or_captcha_blocked"] = blocked or any(
        record.get("restricted") for record in records
    )
    matches = [record for record in records if "state" in record]
    result["room_id_matched"] = bool(matches)
    if result["login_or_captcha_blocked"] or not matches:
        return
    states = {match["state"] for match in matches if match["state"] != "unknown"}
    if len(states) > 1:
        result["reasons"].append("conflicting_detail_states")
        return
    result["live_status"] = matches[-1]["state"]
    for key in ("online_count", "item_title", "item_price"):
        result[key] = matches[-1][key]
    # This public detail does not establish actual broadcast start/end.
    # Its nowTime is a server clock, so both event times stay null.


def initial_result(room_id: str) -> dict:
    return {
        "generated_at": timestamp(),
        "room_id": room_id,
        "page_loaded": False,
        "final_host": None,
        "final_path_redacted": None,
        "fragment_matched": False,
        "final_fragment_shape": None,
        "body_text_len": None,
        "page_gate_reason": None,
        "diagnostics": ProbeDiagnostics().report(),
        "login_or_captcha_blocked": False,
        "live_status": "unknown",
        "room_id_matched": False,
        "start_time": None,
        "end_time": None,
        "online_count": None,
        "item_title": None,
        "item_price": None,
        "evidence_endpoints": [],
        "snapshot_status": "not_taken",
        "reasons": [],
    }


async def gate_state(page, room_id: str) -> dict:
    title = ""
    visible = None
    try:
        title = await asyncio.wait_for(page.title(), timeout=1.5)
    except (PlaywrightError, TimeoutError):
        pass
    try:
        visible = await page.locator("body").inner_text(timeout=1500)
    except PlaywrightError:
        pass
    parts = urlsplit(page.url)
    host = parts.hostname
    match = ROOM_FRAGMENT.fullmatch(parts.fragment)
    fragment_matched = bool(match and match.group(1) == room_id)
    if host in LOGIN_HOSTS:
        reason = "login_host"
    elif any(word in title or word in (visible or "") for word in GATE_TEXT):
        reason = "gate_text_hit"
    elif parts.netloc != "lives.jd.com" or parts.path not in {"", "/"} or not fragment_matched:
        reason = "url_or_fragment_changed"
    elif not visible or not visible.strip():
        reason = "empty_body"
    else:
        reason = "ok"
    return {
        "final_host": host if host and SAFE_HOST.fullmatch(host) else None,
        "final_path_redacted": redact_path(parts.path) if parts.scheme in {"http", "https"} else None,
        "fragment_matched": fragment_matched,
        "final_fragment_shape": redacted_fragment_shape(parts.fragment),
        "body_text_len": len(visible) if visible is not None else None,
        "page_gate_reason": reason,
    }


async def snapshot(page, output: Path) -> None:
    masks = [
        page.locator("input,textarea,iframe,canvas"),
        page.locator("[class*='chat' i],[class*='comment' i],[class*='danmu' i]"),
    ]
    jpeg = await page.screenshot(type="jpeg", quality=75, timeout=5000, mask=masks)
    with Image.open(io.BytesIO(jpeg)) as image:
        image.thumbnail((480, 900))
        image.convert("RGB").save(output, "JPEG", quality=60)


async def collect(url: str, room_id: str, output: Path, result: dict) -> None:
    sources = set()
    records = []
    tasks = []
    diagnostics = ProbeDiagnostics()
    response_count = 0
    frame_count = 0
    network_blocked = False
    accepting = True

    async def inspect_response(response, seq: int, target: bool, eligible_probe: bool) -> None:
        payload = None
        read_body = False
        try:
            length = response.headers.get("content-length", "")
            if re.fullmatch(r"\d{1,12}", length) and int(length) > MAX_BODY:
                return
            body = await asyncio.wait_for(response.body(), timeout=3)
            if len(body) > MAX_BODY:
                return
            read_body = True
            payload = decode_json(body.decode("utf-8"))
            if not eligible_probe or not isinstance(payload, (dict, list)):
                return
            label = source_label(response.url)
            sources.add(label)
            match = public_detail(response.url, payload, room_id)
            if match is not None:
                records.append((seq, match))
                if target and "state" in match:
                    diagnostics.accepted_by_original_rule(response.request)
        except (ValueError, TimeoutError, PlaywrightError):
            return
        finally:
            if target and (read_body or not 200 <= response.status < 300):
                diagnostics.finish(response.request, diagnose_target(response.status, payload, room_id))

    def on_request(request) -> None:
        if accepting:
            diagnostics.register(request)

    def on_response(response) -> None:
        nonlocal response_count, network_blocked
        if not accepting or not eligible(response.url):
            return
        target = diagnostics.register(response.request)
        parts = urlsplit(response.url)
        relevant = (
            parts.hostname == "api.m.jd.com" and parts.path == "/api"
            and form_function_ids(parts.query) == [TARGET_FUNCTION]
        )
        if response.status in {401, 403, 429} and (
            relevant or response.request.is_navigation_request()
        ):
            network_blocked = True
        mime = response.headers.get("content-type", "").split(";", 1)[0].strip().lower()
        eligible_probe = (
            200 <= response.status < 300 and response_count < MAX_RESPONSES
            and (mime in {"application/json", "text/javascript", "application/javascript"}
                 or mime.endswith("+json"))
        )
        if target:
            diagnostics.sample_response(response, mime, eligible_probe, response_count)
        if eligible_probe:
            response_count += 1
        if target or eligible_probe:
            tasks.append(asyncio.create_task(inspect_response(response, response_count, target, eligible_probe)))

    def on_socket(socket) -> None:
        if not eligible(socket.url):
            return

        def on_frame(frame) -> None:
            nonlocal frame_count
            if not accepting or frame_count >= MAX_FRAMES or not isinstance(frame, str):
                return
            frame_count += 1
            if len(frame) <= MAX_BODY and isinstance(decode_json(frame), (dict, list)):
                sources.add(source_label(socket.url))

        socket.on("framereceived", on_frame)

    async def media_filter(route) -> None:
        if route.request.resource_type == "media" or urlsplit(route.request.url).path.lower().endswith(MEDIA_SUFFIX):
            await route.abort()
        else:
            await route.continue_()

    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=True)
        try:
            context = await browser.new_context(viewport={"width": 1280, "height": 820})
            page = await context.new_page()
            page.on("request", on_request)
            page.on("response", on_response)
            page.on("websocket", on_socket)
            await page.route("**/*", media_filter)
            try:
                await page.goto(url, wait_until="domcontentloaded", timeout=25000)
            except PlaywrightError:
                result["reasons"].append("navigation_timeout_or_error")
            visible_gate = False
            gate_reasons = {"login_host", "gate_text_hit"}
            for _ in range(7):
                state = await gate_state(page, room_id)
                visible_gate = state["page_gate_reason"] in gate_reasons
                if visible_gate or network_blocked:
                    break
                await asyncio.sleep(1)
            accepting = False
            if tasks:
                await asyncio.gather(*tasks)
            state = await gate_state(page, room_id)
            result.update(state)
            blocked = visible_gate or state["page_gate_reason"] in gate_reasons or network_blocked
            ordered = [record for _, record in sorted(records, key=lambda pair: pair[0])]
            final_evidence(result, ordered, blocked)
            result["page_loaded"] = state["page_gate_reason"] == "ok" and not result["login_or_captcha_blocked"]
            result["evidence_endpoints"] = sorted(sources)[:15]
            if result["login_or_captcha_blocked"]:
                result["reasons"].append("login_or_access_gate")
                result["snapshot_status"] = "omitted_access_gate"
            elif result["page_loaded"] and result["room_id_matched"] and result["live_status"] != "unknown":
                try:
                    await snapshot(page, output / "snapshot.jpg")
                    state = await gate_state(page, room_id)
                    result.update(state)
                    if state["page_gate_reason"] != "ok":
                        (output / "snapshot.jpg").unlink(missing_ok=True)
                        result["snapshot_status"] = "omitted_page_changed"
                        result["page_loaded"] = False
                        result["login_or_captcha_blocked"] = state["page_gate_reason"] in gate_reasons
                        result["live_status"] = "unknown"
                        for key in ("online_count", "item_title", "item_price"):
                            result[key] = None
                    else:
                        result["snapshot_status"] = "saved"
                except (OSError, PlaywrightError):
                    (output / "snapshot.jpg").unlink(missing_ok=True)
                    result["snapshot_status"] = "screenshot_failed"
            else:
                result["snapshot_status"] = "omitted_unverified_page"
            if not result["room_id_matched"]:
                result["reasons"].append("no_independent_room_match")
        finally:
            accepting = False
            for task in tasks:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            result["diagnostics"] = diagnostics.report()
            await browser.close()


def self_test() -> None:
    room = "49620440"
    endpoint = "https://api.m.jd.com/api?functionId=getImmediatePlayToM&private=hidden"
    payload = {"code": "0", "subCode": 0, "data": {"liveId": room, "status": 1, "nowTime": 123}}
    assert canonical_room(DEFAULT_URL)[1] == room
    for invalid in ("https://example.com/#/49620440", "https://lives.jd.com@else.example/#/49620440"):
        try:
            canonical_room(invalid)
        except ValueError:
            pass
        else:
            raise AssertionError("Outside URL was accepted")
    assert decode_json('callback({"liveId":"49620440"})') == {"liveId": room}
    assert decode_json('doUnsafeThing(); callback({"liveId":"49620440"})') is None
    assert eligible(endpoint) and not eligible("https://evil.jd.com/api")
    assert source_label(endpoint) == "https://api.m.jd.com/api"
    assert public_detail(endpoint.replace("getImmediatePlayToM", "list"), payload, room) is None
    assert public_detail(endpoint, payload, "49620441") is None
    assert public_detail(endpoint, {"code": 0, "data": payload["data"]}, room) is None
    live = public_detail(endpoint, payload, room)
    result = initial_result(room)
    final_evidence(result, [live], False)
    assert result["room_id_matched"] and result["live_status"] == "live"
    assert result["start_time"] is None and result["end_time"] is None
    result = initial_result(room)
    final_evidence(result, [live], True)
    assert result["live_status"] == "unknown" and result["login_or_captcha_blocked"]
    payload["data"]["status"] = 2
    offline = public_detail(endpoint, payload, room)
    result = initial_result(room)
    final_evidence(result, [offline], False)
    assert result["live_status"] == "offline"
    result = initial_result(room)
    final_evidence(result, [live, offline], False)
    assert result["live_status"] == "unknown"
    assert "conflicting_detail_states" in result["reasons"]
    payload["data"]["status"] = 3
    assert public_detail(endpoint, payload, room)["state"] == "replay"
    payload["data"]["secret"] = 1
    assert public_detail(endpoint, payload, room) == {"restricted": True}

    class Request:
        def __init__(self, url, method="GET", post_data=None):
            self.url, self.method, self.post_data = url, method, post_data

    root_post = Request("https://api.m.jd.com/", "POST", 'functionId=getImmediatePlayToM&a=redact-me')
    json_post = Request("https://api.m.jd.com/api", "POST", '{"functionId":"metadata.test","other":"private"}')
    no_response = Request(endpoint)
    assert request_function_ids(root_post) == ({TARGET_FUNCTION}, "post_form")
    assert request_function_ids(json_post) == ({"metadata.test"}, None)
    assert request_function_ids(Request(endpoint, "POST", '{"functionId":"getImmediatePlayToM"}')) == (
        {TARGET_FUNCTION}, "both"
    )
    assert request_function_ids(Request(endpoint, "OPTIONS")) == (set(), None)
    assert request_function_ids(Request("https://api.m.jd.com/api?functionId=not%20valid")) == (set(), None)
    assert request_function_ids(Request("https://example.com/api?functionId=getImmediatePlayToM")) == (set(), None)
    diag = ProbeDiagnostics()
    assert diag.report()["target_request_seen"] == 0
    assert diag.register(root_post) and diag.register(root_post)
    assert diag.register(no_response) and not diag.register(json_post)
    diag.finish(root_post, diagnose_target(403, {"code": 7, "subCode": "ACCESS_DENIED"}, room))
    diag.finish(root_post, diagnose_target(200, {}, room))
    bad_schema = Request(endpoint)
    diag.register(bad_schema)
    diag.finish(bad_schema, diagnose_target(200, {"code": 0, "subCode": 0, "accessToken": "private"}, room))
    wrong_room = Request(endpoint)
    diag.register(wrong_room)
    diag.finish(wrong_room, diagnose_target(200, {
        "code": 0, "subCode": 0, "data": {"liveId": "49620441", "status": 1}
    }, room))
    present = Request(endpoint)
    diag.register(present)
    diag.finish(present, diagnose_target(200, payload, room))
    report = diag.report()
    assert report["observed_function_ids"] == [TARGET_FUNCTION, "metadata.test"]
    assert report["target_request_seen"] == 5
    assert all(report[f"target_{key}_count"] == 1 for key in (
        "error", "schema_mismatch", "room_mismatch", "matched", "unclassified"
    ))
    assert report["target_error_samples"] == [{"http_status": 403, "code": 7, "subCode": "ACCESS_DENIED"}]
    assert report["target_schema_samples"] == [{"http_status": 200, "top_level_keys": ["code", "subCode"]}]
    assert diagnose_target(200, {"code": 0, "subCode": 10}, room)[0] == "error"
    assert public_detail(root_post.url, payload, room) is None

    class Response:
        def __init__(self, request, status=200):
            self.request, self.status = request, status

    post_api = Request("https://api.m.jd.com/api", "POST", '{"functionId":"getImmediatePlayToM"}')
    repeated = Request(endpoint + "&functionId=getImmediatePlayToM")
    sample_cases = (
        (root_post, "application/json", True, 1, "path_not_api"),
        (post_api, "application/problem+json", True, 2, "function_id_not_in_query"),
        (repeated, "application/javascript", True, 3, "duplicate_query_function_id"),
        (Request(endpoint), "text/plain", False, 4, "mime_not_allowed"),
        (Request(endpoint), "application/json", False, MAX_RESPONSES, "max_responses_reached"),
    )
    diag = ProbeDiagnostics()
    for req, mime, usable, count, reason in sample_cases:
        assert diag.register(req)
        diag.sample_response(Response(req), mime, usable, count)
        sample = diag.report()["target_request_samples"][-1]
        assert sample["rejected_reason"] == reason
        assert sample["eligible_probe"] == usable and sample["response_count_at_arrival"] == count
    assert diag.report()["target_request_samples"][1]["function_id_source"] == "post_json"
    assert diag.report()["target_request_samples"][1]["mime_category"] == "json"
    extra = Request(endpoint)
    assert diag.register(extra)
    diag.sample_response(Response(extra), "application/json", True, 1)
    assert len(diag.report()["target_request_samples"]) == MAX_TARGET_SAMPLES
    another = ProbeDiagnostics()
    assert another.register(extra)
    another.sample_response(Response(extra), "application/json", True, 0)
    assert another.report()["target_request_samples"][0]["rejected_reason"] is None
    another.accepted_by_original_rule(extra)
    assert another.report()["target_request_samples"][0]["rejected_reason"] == "accepted"
    assert redacted_fragment_shape("/49620440/live?private=hide-me") == "/<id>/live"
    assert redacted_fragment_shape("/room/opaque-123456-token?foo=hide-me") == "/room/<segment><id><segment>"
    assert redacted_fragment_shape("") == ""

    class GatePage:
        def __init__(self, url, body, visible_title=""):
            self.url, self.body, self.visible_title = url, body, visible_title

        async def title(self):
            return self.visible_title

        def locator(self, _):
            return self

        async def inner_text(self, **_):
            return self.body

    async def verify_gates() -> None:
        login = await gate_state(GatePage("https://plogin.m.jd.com/login/login?a=secret", "欢迎"), room)
        assert login == {"final_host": "plogin.m.jd.com", "final_path_redacted": "/login/login",
                         "fragment_matched": False, "final_fragment_shape": "",
                         "body_text_len": 2, "page_gate_reason": "login_host"}
        altered = await gate_state(GatePage("https://lives.jd.com/12345678/#/49620441", "请按照图中轨迹绘制"), room)
        assert altered["page_gate_reason"] == "gate_text_hit"
        assert altered["final_path_redacted"] == "/[redacted]"
        for url, body, expected in (
            ("https://lives.jd.com/#/49620441", "常规页面", "url_or_fragment_changed"),
            (DEFAULT_URL, "  ", "empty_body"),
            (DEFAULT_URL, "常规页面", "ok"),
        ):
            state = await gate_state(GatePage(url, body), room)
            assert state["page_gate_reason"] == expected
            assert state["body_text_len"] == len(body)

    asyncio.run(verify_gates())
    print("Passed original evidence gates, URL metadata, GET/POST and independent request outcomes.")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return 0
    output = Path("output")
    output.mkdir(exist_ok=True)
    (output / "snapshot.jpg").unlink(missing_ok=True)
    result = initial_result("")
    exit_code = 0
    try:
        url, room_id = canonical_room(os.environ.get("ROOM_URL") or DEFAULT_URL)
        result["room_id"] = room_id
        asyncio.run(collect(url, room_id, output, result))
    except ValueError:
        result["reasons"].append("invalid_room_url")
        exit_code = 2
    except (OSError, PlaywrightError):
        result["reasons"].append("browser_start_or_runtime_failure")
        exit_code = 1
    finally:
        result["generated_at"] = timestamp()
        (output / "result.json").write_text(
            json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        print(json.dumps(result, ensure_ascii=False))
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
