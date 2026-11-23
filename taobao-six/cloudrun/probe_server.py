"""CloudBase 云托管风控对照测试：每个请求用真实 Google Chrome 以游客身份打开一次淘宝直播间。

记录直播间数据接口是否被拒（FAIL_SYS_ILLEGAL_ACCESS 等）、页面/视频流的 HTTP 状态和视频时间是否在走。
不登录、不点击、不手工构造接口请求。同一时间只跑一个测试，两次之间至少间隔 PROBE_MIN_GAP_SECONDS 秒。

环境变量：PROBE_TOKEN（必填，≥16 位）、PORT（默认 8080）、PROBE_MIN_GAP_SECONDS（默认 20）。
"""
import json
import os
import re
import threading
import time
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import probe_core as core

ROOT = Path(__file__).resolve().parent
SHOTS = Path(os.environ.get("PROBE_SHOTS", "/tmp/probe-shots"))
PORT = int(os.environ.get("PORT", "8080"))
MIN_GAP = float(os.environ.get("PROBE_MIN_GAP_SECONDS", "20"))
WATCH_SECONDS = 15
NAV_TIMEOUT_MS = 20000
MAX_RESULTS = 60
SHOT_NAME = re.compile(r"[0-9a-f]{32}\.jpg")
LOCK = threading.Lock()
STATE = {"last_finished": 0.0, "results": []}
VIDEO_JS = """() => { const v = document.querySelector('video');
  return v ? {t: v.currentTime, w: v.videoWidth, h: v.videoHeight, err: v.error && v.error.code, rs: v.readyState} : null; }"""


def utc():
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def run_probe(live_id, headless=False, launcher=None, prepare=None):
    """One guest load of one room. Tests may replace the Chrome launch (``launcher(pw)``) and
    answer requests locally (``prepare(context)``)."""
    from playwright.sync_api import Error, sync_playwright

    started = time.monotonic()
    result = {"liveId": live_id, "started_utc": utc(), "mode": "headless" if headless else "headed"}
    detail_rets, fields, streams, http_errors = [], {}, [], []

    def on_response(resp):
        parts = urlsplit(resp.url)
        host = parts.hostname or ""
        if core.is_detail(resp.url):
            try:
                body = resp.text()
            except Error:
                body = ""
            ret, values = core.read_detail(body)
            detail_rets.append(ret)
            for key, value in values.items():
                fields.setdefault(key, value)
        elif core.is_stream(host, parts.path):
            streams.append({"status": resp.status, "host": host, "path": parts.path[:80]})
        if resp.status >= 400:
            http_errors.append({"status": resp.status, "host": host, "path": parts.path[:80]})

    with sync_playwright() as pw:
        browser = launcher(pw) if launcher else pw.chromium.launch(
            channel="chrome", headless=headless, args=["--mute-audio", "--autoplay-policy=no-user-gesture-required"])
        try:
            result["browser"] = browser.version
            context = browser.new_context(viewport={"width": 1366, "height": 900}, locale="zh-CN",
                                          timezone_id="Asia/Shanghai")
            if prepare:
                prepare(context)
            page = context.new_page()
            page.on("response", on_response)
            try:
                response = page.goto(core.ROOM_URL.format(live_id), wait_until="domcontentloaded", timeout=NAV_TIMEOUT_MS)
                result["doc_status"] = response.status if response else None
            except Error as exc:
                result["doc_status"] = None
                result["navigation_error"] = type(exc).__name__
            samples = []
            deadline = time.monotonic() + WATCH_SECONDS
            while time.monotonic() < deadline:
                page.wait_for_timeout(1000)
                try:
                    samples.append(page.evaluate(VIDEO_JS))
                except Error:
                    samples.append(None)
                video = core.video_progress(samples)
                if video["advanced"] and len(samples) >= 4:
                    break
            try:
                text = page.evaluate("() => document.body ? document.body.innerText : ''")
                result["title"] = page.title()[:80]
            except Error:
                text, result["title"] = "", None
            markers = [m for m in core.PLAYER_MARKERS if m in text]
            SHOTS.mkdir(parents=True, exist_ok=True)
            shot = uuid.uuid4().hex + ".jpg"
            try:
                page.screenshot(path=str(SHOTS / shot), type="jpeg", quality=55)
                result["shot"] = shot
            except Error:
                result["shot"] = None
        finally:
            browser.close()

    video = core.video_progress(samples)
    verdict, reason = core.classify(detail_rets, streams, http_errors, video, markers)
    result.update(detail_rets=detail_rets[:6], room_status=fields.get("roomStatus"),
                  stream_status=fields.get("streamStatus"), streams=streams[:6], http_errors=http_errors[:10],
                  video=video, markers=markers, verdict=verdict, reason=reason,
                  elapsed_ms=int((time.monotonic() - started) * 1000))
    return result


class Handler(BaseHTTPRequestHandler):
    server_version = "probe"
    probe = staticmethod(run_probe)

    def log_message(self, fmt, *args):  # keep tokens and query strings out of the platform log
        print(f"{utc()} {self.command} {urlsplit(self.path).path} {args[1] if len(args) > 1 else ''}", flush=True)

    def send(self, status, body, content_type="application/json; charset=utf-8"):
        data = body if isinstance(body, bytes) else body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def authorized(self):
        query = parse_qs(urlsplit(self.path).query)
        given = self.headers.get("x-probe-token") or (query.get("t") or [None])[0]
        return core.token_ok(given, os.environ.get("PROBE_TOKEN", ""))

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == "/healthz":
            return self.send(200, "ok", "text/plain; charset=utf-8")
        if path == "/":
            page = (ROOT / "control.html").read_text(encoding="utf-8")
            return self.send(200, page.replace("__DEFAULT_IDS__", "\n".join(core.DEFAULT_LIVE_IDS)),
                             "text/html; charset=utf-8")
        if not self.authorized():
            return self.send(401, core.dumps({"error": "unauthorized"}))
        if path == "/results":
            results = list(STATE["results"])
            return self.send(200, core.dumps({"summary": core.summarize(results), "results": results}))
        if path.startswith("/shot/"):
            name = path[len("/shot/"):]
            file = SHOTS / name
            if not SHOT_NAME.fullmatch(name) or not file.is_file():
                return self.send(404, core.dumps({"error": "not_found"}))
            return self.send(200, file.read_bytes(), "image/jpeg")
        return self.send(404, core.dumps({"error": "not_found"}))

    def do_POST(self):
        if urlsplit(self.path).path != "/probe":
            return self.send(404, core.dumps({"error": "not_found"}))
        if not os.environ.get("PROBE_TOKEN") or len(os.environ["PROBE_TOKEN"]) < 16:
            return self.send(503, core.dumps({"error": "probe_token_not_configured"}))
        if not self.authorized():
            return self.send(401, core.dumps({"error": "unauthorized"}))
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(min(length, 4096)) or b"{}")
        except ValueError:
            return self.send(400, core.dumps({"error": "invalid_json"}))
        live_id = body.get("liveId") if isinstance(body, dict) else None
        if not core.valid_live_id(live_id):
            return self.send(400, core.dumps({"error": "invalid_live_id"}))
        if not LOCK.acquire(blocking=False):
            return self.send(409, core.dumps({"error": "busy"}))
        try:
            wait = MIN_GAP - (time.monotonic() - STATE["last_finished"])
            if STATE["last_finished"] and wait > 0:
                return self.send(429, core.dumps({"error": "too_soon", "retry_after": round(wait, 1)}))
            try:
                result = self.probe(live_id, headless=bool(body.get("headless")))
            except Exception as exc:  # report the class only; never a page body or stack
                result = {"liveId": live_id, "started_utc": utc(), "verdict": "error", "reason": type(exc).__name__}
            STATE["last_finished"] = time.monotonic()
            STATE["results"] = (STATE["results"] + [result])[-MAX_RESULTS:]
            print(f"{utc()} probe liveId={live_id} verdict={result['verdict']} reason={result.get('reason')}", flush=True)
            return self.send(200, core.dumps(result))
        finally:
            LOCK.release()


def main():
    if len(os.environ.get("PROBE_TOKEN", "")) < 16:
        print("PROBE_TOKEN 未设置或少于 16 位：/probe 将返回 503", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
