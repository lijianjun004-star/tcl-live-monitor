"""One anonymous, read-only observation of the public JD Live room page."""

from __future__ import annotations

import argparse
import asyncio
import io
import json
import math
import os
import re
from datetime import datetime, timedelta, timezone
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
    r"token|cookie|authorization|secret|password|phone|mobile|email|openid|unionid|"
    r"session|credential|user.?id|user.?name|nick|\d{5,}",
    re.IGNORECASE,
)
DIAGNOSTIC_CODE = re.compile(r"^-?\d{1,8}$|^[A-Z][A-Z0-9_-]{0,23}$")
JSONP = re.compile(r"^[A-Za-z_$][\w$.]{0,99}\s*\(([\s\S]*)\)\s*;?$")
ROOM_FRAGMENT = re.compile(r"^/([1-9][0-9]{4,17})(?:/(live|replay))?(?:\?.*)?$")
MAX_BODY = 384 * 1024
MAX_RESPONSES = 40
MAX_FRAMES = 40
MAX_TARGET_REQUESTS = 40
MAX_FUNCTION_IDS = 80
MAX_TARGET_SAMPLES = 5
MAX_LIVE_DETAIL_RESPONSES = 8
TARGET_FUNCTION = "getImmediatePlayToM"
LIVE_DETAIL_FUNCTION = "liveDetailToM"
APP_PROMPT_TITLE = re.compile(r"^快来下载京东\s*APP$", re.IGNORECASE)
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


def safe_member_names(value: dict) -> list[str]:
    return sorted(key for key in value if SAFE_KEY.fullmatch(key) and not SENSITIVE_KEY.search(key))


def strict_function_ids(value: str) -> list[str] | None:
    if re.search(r"%(?![0-9A-Fa-f]{2})", value):
        return None
    try:
        return parse_qs(
            value, keep_blank_values=True, strict_parsing=True, max_num_fields=120, errors="strict"
        ).get("functionId", [])
    except ValueError:
        return None


def detail_request_rejection(request, target_function: str = TARGET_FUNCTION) -> str | None:
    """Admit exactly one target identity on the official HTTPS detail endpoint."""
    parts = urlsplit(request.url)
    if parts.scheme != "https" or parts.netloc != "api.m.jd.com" or parts.path != "/api":
        return "path_not_api"
    query_ids = strict_function_ids(parts.query)
    if query_ids is None:
        return "malformed_query"
    if len(query_ids) > 1:
        return "duplicate_query_function_id"
    if request.method == "GET":
        return None if query_ids == [target_function] else "function_id_not_in_query"
    if request.method != "POST":
        return "method_not_allowed"
    form_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if form_type != "application/x-www-form-urlencoded":
        return "post_form_required"
    try:
        body = request.post_data or ""
        if not body.strip() or len(body) > 64 * 1024 or len(body.encode("utf-8")) > 64 * 1024:
            return "invalid_post_form"
    except (PlaywrightError, UnicodeError):
        return "invalid_post_form"
    if body.lstrip().startswith(("{", "[")):
        return "invalid_post_form"
    post_ids = strict_function_ids(body)
    if post_ids is None:
        return "invalid_post_form"
    if len(post_ids) > 1:
        return "duplicate_post_function_id"
    if any(ids and ids != [target_function] for ids in (query_ids, post_ids)):
        return "function_id_conflict"
    return None if query_ids or post_ids else "function_id_missing"


def is_network_gate(response) -> bool:
    request = response.request
    return response.status in {401, 403, 429} and (
        request.is_navigation_request()
        or (response.url == request.url and detail_request_rejection(request) is None)
    )


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
        return "schema_mismatch", {"http_status": http_status, "top_level_keys": safe_member_names(envelope)[:16]}
    if str(data["liveId"]) != room_id:
        return "room_mismatch", {}
    return "matched", {}


def live_detail_key_observation(payload, room_id: str) -> tuple[str, list[str]]:
    if not isinstance(payload, dict):
        return "schema_mismatch", []
    if str(payload.get("code")) != "0" or str(payload.get("subCode")) != "0":
        return "envelope_not_accepted", []
    data = payload.get("data")
    if not isinstance(data, dict) or str(data.get("liveId")) != room_id:
        return "room_not_matched", []
    if data.get("secret") is not None and str(data["secret"]) != "0":
        return "restricted", []
    return "accepted", safe_member_names(data)[:40]


class ProbeDiagnostics:
    """Keep bounded, non-identifying metadata for requests observed in this browser."""

    def __init__(self) -> None:
        self.function_ids: set[str] = set()
        self.targets: dict = {}
        self.sources: dict = {}
        self.samples: dict = {}
        self.detail_keys: set[str] = set()
        self.live_detail_keys: set[str] = set()
        self.live_detail_outcomes: set[str] = set()
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
            if category not in {"json", "javascript"}:
                reason = "mime_not_allowed"
            elif arrival_count >= MAX_RESPONSES:
                reason = "max_responses_reached"
            else:
                reason = detail_request_rejection(request)
        self.samples[request] = {
            "method": request.method,
            "safe_path": parts.path or "/",
            "function_id_source": self.sources[request],
            "mime_category": category,
            "eligible_probe": eligible_probe,
            "response_count_at_arrival": arrival_count,
            "rejected_reason": reason,
        }

    def accepted_detail(self, request, data: dict) -> None:
        if request in self.samples:
            self.samples[request]["rejected_reason"] = "accepted"
        self.detail_keys.update(safe_member_names(data)[:40])

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
            "detail_data_keys": sorted(self.detail_keys)[:40],
            "live_detail_data_keys": sorted(self.live_detail_keys)[:40],
            "live_detail_outcomes": sorted(self.live_detail_outcomes),
            "truncated": self.truncated,
        }


def public_detail(request, payload, room_id: str) -> dict | None:
    """Only the documented JD page detail's response can establish a state."""
    if (
        detail_request_rejection(request) is not None
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


HISTORY_LIMIT_BYTES = 1024 * 1024
HISTORY_LIMIT_RECORDS = 2_000
OBSERVED_TIME_FIELDS = (
    "observed_live_since", "observed_last_live_at", "observed_ended_at", "observed_window_seconds",
)
HISTORY_FIELDS = {
    "room_id", "generated_at", "live_status", "page_loaded",
    "room_id_matched", "login_or_captcha_blocked",
}


def verified_history_observation(value: object) -> tuple[str, datetime, str] | None:
    if not isinstance(value, dict):
        return None
    room = value.get("room_id")
    generated = value.get("generated_at")
    status = value.get("live_status")
    if (
        not isinstance(room, str) or not re.fullmatch(r"[1-9][0-9]{4,17}", room)
        or not isinstance(generated, str) or len(generated) > 40
        or not isinstance(status, str) or status not in {"live", "offline", "replay"}
        or value.get("page_loaded") is not True or value.get("room_id_matched") is not True
        or value.get("login_or_captcha_blocked") is not False
    ):
        return None
    try:
        when = datetime.fromisoformat(generated)
    except ValueError:
        return None
    if when.utcoffset() != timedelta(0):
        return None
    return room, when, status


def history_line(observation: tuple[str, datetime, str]) -> bytes:
    room, when, status = observation
    return (json.dumps({
        "room_id": room, "generated_at": when.isoformat(), "live_status": status,
        "page_loaded": True, "room_id_matched": True, "login_or_captcha_blocked": False,
    }, separators=(",", ":")) + "\n").encode("utf-8")


def append_state_history(path: Path, result: dict) -> None:
    """Append verified evidence and derive observation times for this room only."""
    result.update(dict.fromkeys(OBSERVED_TIME_FIELDS))
    observation = verified_history_observation(result)
    if observation is None and not path.exists():
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    guard = path.with_name(path.name + ".lock")
    temporary = path.with_name(path.name + ".tmp")
    guard.touch(exist_ok=False)
    try:
        raw = b""
        if path.exists():
            with path.open("rb") as history:
                raw = history.read(HISTORY_LIMIT_BYTES + 1)
        lines = raw.splitlines()
        if len(raw) > HISTORY_LIMIT_BYTES or len(lines) > HISTORY_LIMIT_RECORDS or (raw and not raw.endswith(b"\n")):
            raise ValueError("State history is over its limit or incomplete")
        previous_observations = []
        for line in lines:
            try:
                row = json.loads(line)
            except (ValueError, RecursionError) as error:
                raise ValueError("State history contains an invalid JSONL record") from error
            previous = verified_history_observation(row)
            if previous is None or set(row) != HISTORY_FIELDS:
                raise ValueError("State history contains an unexpected record")
            previous_observations.append(previous)
        appended = False
        if observation is not None:
            room, when, status = observation
            since = last_live = last_seen = None
            for previous in previous_observations:
                if previous[0] != room or (last_seen and previous[1] <= last_seen):
                    continue
                _, last_seen, previous_status = previous
                if previous_status == "live":
                    since = since or last_seen
                    last_live = last_seen
                else:
                    since = last_live = None
            if not last_seen or when > last_seen:
                previous_observations.append(observation)
                appended = True
        canonical = b"".join(history_line(row) for row in previous_observations)
        if len(previous_observations) > HISTORY_LIMIT_RECORDS or len(canonical) > HISTORY_LIMIT_BYTES:
            raise ValueError("State history is full")
        if canonical != raw:
            temporary.write_bytes(canonical)
            temporary.replace(path)
        if not appended:
            return
        if status == "live":
            result["observed_live_since"] = (since or when).isoformat()
            result["observed_last_live_at"] = when.isoformat()
        elif since and last_live:
            result["observed_live_since"] = since.isoformat()
            result["observed_last_live_at"] = last_live.isoformat()
            result["observed_ended_at"] = when.isoformat()
            result["observed_window_seconds"] = (when - last_live).total_seconds()
    finally:
        temporary.unlink(missing_ok=True)
        guard.unlink()


def self_test_history() -> None:
    from tempfile import TemporaryDirectory

    def item(minute: int, status: str, room: str = "49620440", **overrides) -> dict:
        return {
            "room_id": room, "generated_at": f"2026-11-20T02:{minute:02d}:00+00:00",
            "page_loaded": True, "room_id_matched": True, "login_or_captcha_blocked": False,
            "start_time": None, "end_time": None, "live_status": status, **overrides,
        }

    with TemporaryDirectory() as temporary:
        history = Path(temporary) / "state_history.jsonl"
        first, last = item(10, "live"), item(12, "live")
        for obs in (first, item(11, "unknown"), item(11, "offline", room_id_matched=False),
                    item(13, "replay", "49620441"), last, item(11, "offline"), item(12, "replay")):
            append_state_history(history, obs)
        end = item(15, "replay")
        append_state_history(history, end)
        assert end["observed_live_since"] == first["generated_at"]
        assert end["observed_last_live_at"] == last["generated_at"]
        assert end["observed_ended_at"] == end["generated_at"]
        assert end["observed_window_seconds"] == 180
        assert end["start_time"] is None and end["end_time"] is None
        repeated = item(16, "replay")
        append_state_history(history, repeated)
        assert not any(repeated[field] is not None for field in OBSERVED_TIME_FIELDS)
        append_state_history(history, end)
        assert end["observed_ended_at"] is None
        restarted = item(17, "live")
        append_state_history(history, restarted)
        finish = item(18, "offline")
        append_state_history(history, finish)
        assert finish["observed_live_since"] == restarted["generated_at"]
        assert finish["observed_ended_at"] == finish["generated_at"]
        rows = [json.loads(line) for line in history.read_text().splitlines()]
        assert len(rows) == 7 and all("start_time" not in row and "end_time" not in row for row in rows)
        prior = history.read_bytes()
        append_state_history(history, item(19, "unknown"))
        assert history.read_bytes() == prior
        invalid = Path(temporary) / "invalid.jsonl"
        invalid.write_text(json.dumps({**rows[0], "not_an_evidence_field": "private"})+"\n")
        try:
            append_state_history(invalid, item(20, "unknown"))
        except ValueError:
            pass
        else:
            raise AssertionError("Unverified imported history was accepted")


def initial_result(room_id: str) -> dict:
    return {
        "generated_at": timestamp(),
        "room_id": room_id,
        "page_loaded": False,
        "final_host": None,
        "final_path_redacted": None,
        "fragment_matched": False,
        "final_fragment_shape": None,
        "route_mode": None,
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
        "app_prompt_cleanup": "not_attempted",
        "reasons": [],
        **dict.fromkeys(OBSERVED_TIME_FIELDS),
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
    elif (
        parts.scheme != "https" or parts.netloc != "lives.jd.com"
        or parts.path not in {"", "/"} or not fragment_matched
    ):
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
        "route_mode": (match.group(2) or "root") if parts.scheme == "https" and parts.netloc == "lives.jd.com" and match else None,
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


async def dismiss_app_prompt(page) -> str:
    """Use only the public opt-out button attached to the known App promotion."""
    prompt = page.get_by_text(APP_PROMPT_TITLE)
    button = page.get_by_text("继续查看", exact=True)
    try:
        if not await asyncio.wait_for(prompt.is_visible(), timeout=1.5):
            return "not_visible"
        if await asyncio.wait_for(button.count(), timeout=1.5) != 1:
            return "not_dismissed"
        await button.click(timeout=1500)
        visible = await asyncio.wait_for(prompt.is_visible(), timeout=1.5)
        return "still_visible" if visible else "dismissed"
    except (PlaywrightError, TimeoutError):
        return "not_dismissed"


async def collect(url: str, room_id: str, output: Path, result: dict) -> None:
    sources = set()
    records = []
    tasks = []
    diagnostics = ProbeDiagnostics()
    response_count = 0
    live_detail_response_count = 0
    frame_count = 0
    network_blocked = False
    accepting = True

    async def inspect_response(
        response, seq: int, target: bool, eligible_probe: bool, inspect_live_detail: bool,
    ) -> None:
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
            if inspect_live_detail:
                outcome, keys = live_detail_key_observation(payload, room_id)
                diagnostics.live_detail_outcomes.add(outcome)
                diagnostics.live_detail_keys.update(keys)
            if not eligible_probe or not isinstance(payload, (dict, list)):
                return
            label = source_label(response.url)
            sources.add(label)
            match = public_detail(response.request, payload, room_id) if response.url == response.request.url else None
            if match is not None:
                records.append((seq, match))
                if target and "state" in match:
                    diagnostics.accepted_detail(response.request, payload["data"])
        except (ValueError, TimeoutError, PlaywrightError):
            return
        finally:
            if inspect_live_detail and not read_body:
                diagnostics.live_detail_outcomes.add("body_unavailable")
            if target and (read_body or not 200 <= response.status < 300):
                diagnostics.finish(response.request, diagnose_target(response.status, payload, room_id))

    def on_request(request) -> None:
        if accepting:
            diagnostics.register(request)

    def on_response(response) -> None:
        nonlocal response_count, live_detail_response_count, network_blocked
        if not accepting or not eligible(response.url):
            return
        target = diagnostics.register(response.request)
        if is_network_gate(response):
            network_blocked = True
        mime = response.headers.get("content-type", "").split(";", 1)[0].strip().lower()
        json_mime = mime_category(mime) in {"json", "javascript"}
        eligible_probe = (
            200 <= response.status < 300 and response_count < MAX_RESPONSES and json_mime
        )
        inspect_live_detail = False
        ids, _ = request_function_ids(response.request)
        if LIVE_DETAIL_FUNCTION in ids and live_detail_response_count < MAX_LIVE_DETAIL_RESPONSES:
            live_detail_response_count += 1
            if response.url != response.request.url or detail_request_rejection(
                response.request, LIVE_DETAIL_FUNCTION
            ) is not None:
                diagnostics.live_detail_outcomes.add("request_not_admitted")
            elif not 200 <= response.status < 300:
                diagnostics.live_detail_outcomes.add("http_not_2xx")
            elif not json_mime:
                diagnostics.live_detail_outcomes.add("mime_not_admitted")
            else:
                inspect_live_detail = True
        if target:
            diagnostics.sample_response(response, mime, eligible_probe, response_count)
        if eligible_probe:
            response_count += 1
        if target or eligible_probe or inspect_live_detail:
            tasks.append(asyncio.create_task(inspect_response(
                response, response_count, target, eligible_probe, inspect_live_detail
            )))

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
                    result["app_prompt_cleanup"] = await dismiss_app_prompt(page)
                    snapshot_gate = await gate_state(page, room_id)
                    if snapshot_gate["page_gate_reason"] != "ok":
                        result["snapshot_status"] = "omitted_page_changed"
                        return
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

    class Request:
        def __init__(self, url, method="GET", post_data=None, content_type="", navigation=False):
            self.url, self.method, self.post_data = url, method, post_data
            self.headers = {"content-type": content_type}
            self.navigation = navigation

        def is_navigation_request(self):
            return self.navigation

    query_get = Request(endpoint)
    post_endpoint = "https://api.m.jd.com/api"
    post_type = "application/x-www-form-urlencoded; charset=UTF-8"
    form_data = "functionId=getImmediatePlayToM&body=%7B%7D"
    form_request = Request(post_endpoint, "POST", form_data, post_type)
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
    assert public_detail(Request(endpoint.replace(TARGET_FUNCTION, "list")), payload, room) is None
    assert public_detail(query_get, payload, "49620441") is None
    assert public_detail(query_get, {"code": 0, "data": payload["data"]}, room) is None
    live = public_detail(query_get, payload, room)
    assert public_detail(form_request, payload, room) == live
    assert public_detail(Request(endpoint, "POST", form_data, post_type), payload, room) == live
    assert public_detail(Request(endpoint, "POST", "body=%7B%7D", post_type), payload, room) == live
    discovery = Request(
        post_endpoint, "POST", "functionId=liveDetailToM&body=%7B%7D", post_type
    )
    assert detail_request_rejection(discovery, LIVE_DETAIL_FUNCTION) is None
    assert detail_request_rejection(discovery) == "function_id_conflict"
    assert public_detail(discovery, payload, room) is None
    assert detail_request_rejection(Request(
        endpoint, "POST", "functionId=liveDetailToM", post_type
    ), LIVE_DETAIL_FUNCTION) == "function_id_conflict"
    assert detail_request_rejection(Request(
        "https://api.m.jd.com/", "POST", "functionId=liveDetailToM", post_type
    ), LIVE_DETAIL_FUNCTION) == "path_not_api"
    assert live_detail_key_observation({"code": 0, "subCode": 0, "data": {
        "liveId": room, "startTime": "a value must not leave the probe",
        "userName": "private", "credential": "private", "token": "private",
    }}, room) == ("accepted", ["liveId", "startTime"])
    assert live_detail_key_observation(payload, "49620441") == ("room_not_matched", [])
    assert live_detail_key_observation({"code": 9, "subCode": 0, "data": {}}, room) == (
        "envelope_not_accepted", []
    )
    assert live_detail_key_observation({"code": 0, "subCode": 0, "data": {
        "liveId": room, "secret": 1, "endTime": "also private",
    }}, room) == ("restricted", [])
    for request, reason in (
        (Request(endpoint, "POST", "functionId=otherFunction", post_type), "function_id_conflict"),
        (Request(endpoint.replace(TARGET_FUNCTION, "otherFunction"), "POST", form_data, post_type), "function_id_conflict"),
        (Request(endpoint + "&functionId="), "duplicate_query_function_id"),
        (Request(post_endpoint, "POST", form_data + "&functionId=", post_type), "duplicate_post_function_id"),
        (Request(post_endpoint, "POST", form_data + "&functionId=" + TARGET_FUNCTION, post_type), "duplicate_post_function_id"),
        (Request(post_endpoint, "POST", form_data + "&bad=%ZZ", post_type), "invalid_post_form"),
        (Request(post_endpoint, "POST", form_data + "&bad=%FF", post_type), "invalid_post_form"),
        (Request(post_endpoint, "POST", form_data + "&long=" + "臨"*22000, post_type), "invalid_post_form"),
        (Request(post_endpoint, "POST", form_data), "post_form_required"),
        (Request(endpoint, "POST", '{"functionId":"getImmediatePlayToM"}', "application/json"), "post_form_required"),
        (Request(post_endpoint, "POST", '{"functionId":"getImmediatePlayToM"}', post_type), "invalid_post_form"),
        (Request("https://api.m.jd.com/", "POST", form_data, post_type), "path_not_api"),
        (Request(post_endpoint + "/", "POST", form_data, post_type), "path_not_api"),
        (Request(endpoint, "OPTIONS"), "method_not_allowed"),
    ):
        assert detail_request_rejection(request) == reason
        assert public_detail(request, payload, room) is None
    result = initial_result(room)
    final_evidence(result, [live], False)
    assert result["room_id_matched"] and result["live_status"] == "live"
    assert result["start_time"] is None and result["end_time"] is None
    result = initial_result(room)
    final_evidence(result, [live], True)
    assert result["live_status"] == "unknown" and result["login_or_captcha_blocked"]
    payload["data"]["status"] = 2
    offline = public_detail(query_get, payload, room)
    result = initial_result(room)
    final_evidence(result, [offline], False)
    assert result["live_status"] == "offline"
    result = initial_result(room)
    final_evidence(result, [live, offline], False)
    assert result["live_status"] == "unknown"
    assert "conflicting_detail_states" in result["reasons"]
    payload["data"]["status"] = 3
    assert public_detail(form_request, payload, room)["state"] == "replay"
    payload["data"]["secret"] = 1
    assert public_detail(form_request, payload, room) == {"restricted": True}

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
    assert public_detail(root_post, payload, room) is None

    class Response:
        def __init__(self, request, status=200):
            self.request, self.status, self.url = request, status, request.url

    assert all(is_network_gate(Response(form_request, denied)) for denied in (401, 403, 429))
    assert not is_network_gate(Response(root_post, 403))
    assert not is_network_gate(Response(form_request, 200))
    assert is_network_gate(Response(Request(DEFAULT_URL, navigation=True), 429))

    post_api = Request("https://api.m.jd.com/api", "POST", '{"functionId":"getImmediatePlayToM"}')
    repeated = Request(endpoint + "&functionId=getImmediatePlayToM")
    sample_cases = (
        (root_post, "application/json", True, 1, "path_not_api"),
        (post_api, "application/problem+json", True, 2, "post_form_required"),
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
    another.accepted_detail(extra, {
        "liveId": room, "status": 3, "nowTime": 123, "accessToken": "private",
        "secret": 1, "invalid-key-123456": "hidden",
    })
    assert another.report()["target_request_samples"][0]["rejected_reason"] == "accepted"
    assert another.report()["detail_data_keys"] == ["liveId", "nowTime", "status"]
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
                         "fragment_matched": False, "final_fragment_shape": "", "route_mode": None,
                         "body_text_len": 2, "page_gate_reason": "login_host"}
        altered = await gate_state(GatePage("https://lives.jd.com/12345678/#/49620441", "请按照图中轨迹绘制"), room)
        assert altered["page_gate_reason"] == "gate_text_hit"
        assert altered["final_path_redacted"] == "/[redacted]"
        for url, body, expected in (
            ("https://lives.jd.com/#/49620441", "常规页面", "url_or_fragment_changed"),
            ("https://lives.jd.com/#/49620441/replay", "常规页面", "url_or_fragment_changed"),
            ("http://lives.jd.com/#/49620440/replay", "常规页面", "url_or_fragment_changed"),
            (DEFAULT_URL, "  ", "empty_body"),
            (DEFAULT_URL, "常规页面", "ok"),
        ):
            state = await gate_state(GatePage(url, body), room)
            assert state["page_gate_reason"] == expected
            assert state["body_text_len"] == len(body)
        replay = await gate_state(GatePage(DEFAULT_URL + "/replay", "常规页面"), room)
        assert replay["route_mode"] == "replay" and replay["fragment_matched"]
        assert replay["page_gate_reason"] == "ok"
        result = initial_result(room)
        result.update(replay)
        final_evidence(result, [], False)
        assert result["live_status"] == "unknown"
        final_evidence(result, [live], False)
        assert result["live_status"] == "live"
        assert result["start_time"] is None and result["end_time"] is None

    class AppPage:
        def __init__(self, visible=True, fail=False):
            self.visible, self.fail, self.clicks = visible, fail, 0

        def get_by_text(self, text, *, exact=False):
            if isinstance(text, re.Pattern):
                assert text.fullmatch("快来下载京东 APP")
            else:
                assert text == "继续查看" and exact
            return self

        async def is_visible(self):
            return self.visible

        async def count(self):
            return 1

        async def click(self, *, timeout):
            assert timeout == 1500
            if self.fail:
                raise PlaywrightError("expected offline fixture")
            self.clicks += 1
            self.visible = False

    async def verify_app_prompt() -> None:
        page = AppPage()
        assert await dismiss_app_prompt(page) == "dismissed" and page.clicks == 1
        no_modal = AppPage(visible=False)
        assert await dismiss_app_prompt(no_modal) == "not_visible" and no_modal.clicks == 0
        assert await dismiss_app_prompt(AppPage(fail=True)) == "not_dismissed"

    asyncio.run(verify_gates())
    asyncio.run(verify_app_prompt())
    self_test_history()
    print("Passed strict admission, gates, isolated key discovery, App prompt opt-out and state history.")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--state-history", type=Path, help="Optional local JSONL for accepted observations.")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return 0
    if args.state_history is not None and args.state_history.suffix != ".jsonl":
        parser.error("--state-history requires a .jsonl file")
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
        if exit_code == 0 and args.state_history is not None:
            try:
                append_state_history(args.state_history, result)
            except (OSError, ValueError):
                result["reasons"].append("state_history_unavailable")
                exit_code = 1
        (output / "result.json").write_text(
            json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        print(json.dumps(result, ensure_ascii=False))
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
