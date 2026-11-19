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
JSONP = re.compile(r"^[A-Za-z_$][\w$.]{0,99}\s*\(([\s\S]*)\)\s*;?$")
ROOM_FRAGMENT = re.compile(r"^/([1-9][0-9]{4,17})(?:/live)?(?:\?.*)?$")
MAX_BODY = 384 * 1024
MAX_RESPONSES = 40
MAX_FRAMES = 40


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


def source_label(url: str) -> str:
    parts = urlsplit(url)
    path = unquote(parts.path)
    if path != "/" and (not SOURCE_PATH.fullmatch(path) or re.search(r"\d{5,}", path)):
        path = "/[redacted]"
    return f"{parts.scheme}://{parts.hostname}{path or '/'}"


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


def public_detail(url: str, payload, room_id: str) -> dict | None:
    """Only the documented JD page detail's response can establish a state."""
    parts = urlsplit(url)
    if (
        parts.scheme != "https" or parts.netloc != "api.m.jd.com" or parts.path != "/api"
        or parse_qs(parts.query).get("functionId") != ["getImmediatePlayToM"]
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


async def gate_state(page, room_id: str) -> tuple[bool, bool]:
    parts = urlsplit(page.url)
    if parts.hostname in LOGIN_HOSTS:
        return False, True
    match = ROOM_FRAGMENT.fullmatch(parts.fragment)
    if parts.hostname != "lives.jd.com" or not match or match.group(1) != room_id:
        return False, False
    try:
        title = (await page.title())[:300]
        visible = (await page.locator("body").inner_text(timeout=1500))[:9000]
    except PlaywrightError:
        return False, False
    if any(word in title or word in visible for word in GATE_TEXT):
        return False, True
    return bool(visible.strip()), False


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
    response_count = 0
    frame_count = 0
    network_blocked = False
    accepting = True

    async def inspect_response(response, seq: int) -> None:
        try:
            length = response.headers.get("content-length", "")
            if re.fullmatch(r"\d{1,12}", length) and int(length) > MAX_BODY:
                return
            body = await asyncio.wait_for(response.body(), timeout=3)
            if len(body) > MAX_BODY:
                return
            payload = decode_json(body.decode("utf-8"))
            if not isinstance(payload, (dict, list)):
                return
            label = source_label(response.url)
            sources.add(label)
            match = public_detail(response.url, payload, room_id)
            if match is not None:
                records.append((seq, match))
        except (ValueError, TimeoutError, PlaywrightError):
            return

    def on_response(response) -> None:
        nonlocal response_count, network_blocked
        if not accepting or not eligible(response.url):
            return
        parts = urlsplit(response.url)
        relevant = (
            parts.hostname == "api.m.jd.com" and parts.path == "/api"
            and parse_qs(parts.query).get("functionId") == ["getImmediatePlayToM"]
        )
        if response.status in {401, 403, 429} and (
            relevant or response.request.is_navigation_request()
        ):
            network_blocked = True
            return
        if not 200 <= response.status < 300:
            return
        mime = response.headers.get("content-type", "").split(";", 1)[0].strip().lower()
        if (
            response_count >= MAX_RESPONSES
            or (mime not in {"application/json", "text/javascript", "application/javascript"}
                and not mime.endswith("+json"))
        ):
            return
        response_count += 1
        tasks.append(asyncio.create_task(inspect_response(response, response_count)))

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
            page.on("response", on_response)
            page.on("websocket", on_socket)
            await page.route("**/*", media_filter)
            try:
                await page.goto(url, wait_until="domcontentloaded", timeout=16000)
            except PlaywrightError:
                result["reasons"].append("navigation_timeout_or_error")
            visible_gate = False
            for _ in range(7):
                _, visible_gate = await gate_state(page, room_id)
                if visible_gate or network_blocked:
                    break
                await asyncio.sleep(1)
            accepting = False
            if tasks:
                await asyncio.gather(*tasks)
            loaded, final_gate = await gate_state(page, room_id)
            blocked = visible_gate or final_gate or network_blocked
            ordered = [record for _, record in sorted(records, key=lambda pair: pair[0])]
            final_evidence(result, ordered, blocked)
            result["page_loaded"] = loaded and not result["login_or_captcha_blocked"]
            result["evidence_endpoints"] = sorted(sources)[:15]
            if result["login_or_captcha_blocked"]:
                result["reasons"].append("login_or_access_gate")
                result["snapshot_status"] = "omitted_access_gate"
            elif result["page_loaded"] and result["room_id_matched"] and result["live_status"] != "unknown":
                try:
                    await snapshot(page, output / "snapshot.jpg")
                    still_loaded, later_gate = await gate_state(page, room_id)
                    if later_gate or not still_loaded:
                        (output / "snapshot.jpg").unlink(missing_ok=True)
                        result["snapshot_status"] = "omitted_page_changed"
                        result["page_loaded"] = False
                        result["login_or_captcha_blocked"] = later_gate
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
    print("Passed local JSON/JSONP, anonymous scope, identity, state and gate checks.")


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
