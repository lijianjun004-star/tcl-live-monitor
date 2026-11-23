"""Let a person finish a platform's own verification (slider or drawn path) from a phone.

When a monitored page shows a challenge, the engine may hand that page to this helper. It
streams the page's viewport to a token-protected viewer, published through a Cloudflare quick
tunnel, and pushes the link to the operator through the project's Bark webhook. The viewer
forwards finger or mouse press / move / release in order, so a slider can be dragged and a path
can be drawn; on a touch context the input arrives as touch events. Nothing here solves a
challenge by itself: without a person the page stays gated and the room keeps its challenge code.

Limits: one person-session at a time, a bounded number per run, a bounded wait each, no pushes
outside the configured Beijing hours. The link and token are never printed or stored.
"""

from __future__ import annotations

import asyncio
import json
import queue
import re
import secrets
import subprocess
import threading
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Awaitable, Callable

BEIJING = timezone(timedelta(hours=8))
TUNNEL_URL = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")
FRAME_INTERVAL = 0.15
RELOAD_AFTER_GESTURE = 5.0

VIEWER = """<!doctype html><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>巡检人工验证</title>
<style>html,body{margin:0;background:#111;color:#eee;font:16px system-ui;overscroll-behavior:none}
#v{display:block;width:100%;touch-action:none;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none}
#s{padding:10px 12px;line-height:1.5}</style>
<div id=s>正在连接云端浏览器……</div><img id=v alt="云端浏览器画面" draggable=false>
<script>
const base=location.pathname.replace(/\\/$/,''),v=document.getElementById('v'),s=document.getElementById('s');
let q=[],busy=false;
function frame(){const i=new Image();i.onload=()=>{v.src=i.src;setTimeout(frame,150)};i.onerror=()=>setTimeout(frame,800);
 i.src=base+'/frame.jpg?'+Date.now()}
frame();
function pt(e){const r=v.getBoundingClientRect();return{x:(e.clientX-r.left)/r.width,y:(e.clientY-r.top)/r.height}}
function push(t,e){e.preventDefault();q.push({t,...pt(e)});flush()}
v.addEventListener('pointerdown',e=>{v.setPointerCapture(e.pointerId);push('down',e)});
v.addEventListener('pointermove',e=>{if(e.buttons||v.hasPointerCapture(e.pointerId))push('move',e)});
v.addEventListener('pointerup',e=>push('up',e));
v.addEventListener('pointercancel',e=>push('up',e));
['touchstart','touchmove','touchend'].forEach(n=>v.addEventListener(n,e=>e.preventDefault(),{passive:false}));
v.addEventListener('contextmenu',e=>e.preventDefault());
async function flush(){if(busy||!q.length)return;busy=true;const b=q;q=[];
 try{await fetch(base+'/input',{method:'POST',body:JSON.stringify(b)})}catch(e){}
 busy=false;if(q.length)flush()}
async function status(){try{s.textContent=(await (await fetch(base+'/status')).json()).status}catch(e){}setTimeout(status,1500)}
status();
</script>"""


class _Live:
    """State shared between the HTTP threads and the event loop for the current session only."""

    def __init__(self):
        self.lock = threading.Lock()
        self.token: str | None = None
        self.frame = b""
        self.status = ""
        self.events: queue.Queue = queue.Queue()

    def open(self, token: str) -> None:
        with self.lock:
            self.token, self.frame, self.status = token, b"", "请按页面提示完成验证（拖动滑块或按轨迹画线）"
            self.events = queue.Queue()

    def close(self) -> None:
        with self.lock:
            self.token = None


def _handler(live: _Live):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):  # request paths contain the token
            pass

        def _send(self, code, body=b"", ctype="text/plain; charset=utf-8"):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Cache-Control", "no-store")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _route(self):
            with live.lock:
                token = live.token
            path = self.path.split("?", 1)[0]
            prefix = "/" + token if token else None
            if not prefix or not (path == prefix or path.startswith(prefix + "/")):
                return None
            return path[len(prefix):] or "/"

        def do_GET(self):
            route = self._route()
            if route == "/":
                self._send(200, VIEWER.encode(), "text/html; charset=utf-8")
            elif route == "/frame.jpg":
                with live.lock:
                    frame = live.frame
                self._send(200, frame, "image/jpeg")
            elif route == "/status":
                with live.lock:
                    status = live.status
                self._send(200, json.dumps({"status": status}, ensure_ascii=False).encode(), "application/json")
            else:
                self._send(404)

        def do_POST(self):
            if self._route() != "/input":
                return self._send(404)
            length = min(int(self.headers.get("Content-Length") or 0), 64 * 1024)
            try:
                batch = json.loads(self.rfile.read(length) or b"[]")
            except ValueError:
                return self._send(400)
            with live.lock:
                events = live.events
            for item in batch[:500] if isinstance(batch, list) else []:
                if (isinstance(item, dict) and item.get("t") in ("down", "move", "up")
                        and all(isinstance(item.get(k), (int, float)) for k in ("x", "y"))):
                    events.put((item["t"], min(max(float(item["x"]), 0.0), 1.0), min(max(float(item["y"]), 0.0), 1.0)))
            self._send(204)

    return Handler


def start_quick_tunnel(binary: str, port: int, timeout: float = 60.0):
    """Start `cloudflared tunnel --url` and return (process, public base URL). Blocking."""
    proc = subprocess.Popen([str(Path(binary).resolve()), "tunnel", "--no-autoupdate", "--url", f"http://127.0.0.1:{port}"],
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    deadline = time.monotonic() + timeout
    for line in proc.stdout:
        found = TUNNEL_URL.search(line)
        if found:
            threading.Thread(target=lambda: [None for _ in proc.stdout], daemon=True).start()
            return proc, found.group(0)
        if time.monotonic() > deadline:
            break
    proc.terminate()
    raise RuntimeError("TUNNEL_NOT_READY")


def bark_push(url: str, title: str, body: str, link: str) -> int:
    data = json.dumps({"title": title, "body": body, "group": "tcl-live-monitor", "url": link,
                       "level": "timeSensitive"}, ensure_ascii=False).encode()
    request = urllib.request.Request(url, data=data, method="POST",
                                     headers={"Content-Type": "application/json; charset=utf-8"})
    with urllib.request.urlopen(request, timeout=10) as response:  # noqa: S310 (https checked by caller)
        return response.status


class HumanVerifier:
    def __init__(self, webhook_url: str, *, tunnel_binary: str = "./cloudflared", max_wait: float = 300.0,
                 max_sessions: int = 3, hours: tuple[int, int] = (8, 24), port: int = 8765, settle_seconds: float = 2.0,
                 start_tunnel: Callable = start_quick_tunnel, push: Callable = bark_push,
                 now: Callable[[], datetime] = lambda: datetime.now(BEIJING)):
        self.webhook_url = webhook_url
        self.tunnel_binary = tunnel_binary
        self.max_wait = float(max_wait)
        self.max_sessions = int(max_sessions)
        self.hours = hours
        self.port = port
        self.settle_seconds = settle_seconds
        self._start_tunnel, self._push, self._now = start_tunnel, push, now
        self._lock = asyncio.Lock()
        self._live = _Live()
        self._server = None
        self._tunnel = None
        self._public: str | None = None
        self._tunnel_failed = False
        self.counts = {"sessions": 0, "solved": 0, "timeouts": 0, "push_failed": 0, "input_events": 0}

    @classmethod
    def from_env(cls, env: dict) -> "HumanVerifier | None":
        if env.get("HUMAN_VERIFY") != "1":
            return None
        url = env.get("WEBHOOK_URL") or ""
        kind = (env.get("WEBHOOK_KIND") or "").lower()
        host_bark = re.match(r"https://(api\.day\.app|bark\.)", url)
        if not url.startswith("https://") or (kind != "bark" and not (not kind and host_bark)):
            return None
        binary = env.get("HUMAN_VERIFY_TUNNEL") or "./cloudflared"
        if not Path(binary).is_file():
            return None
        return cls(url, tunnel_binary=binary,
                   max_wait=float(env.get("HUMAN_VERIFY_WAIT_SECONDS") or 300),
                   max_sessions=int(env.get("HUMAN_VERIFY_MAX_SESSIONS") or 3))

    @property
    def timeout_allowance(self) -> float:
        """Extra time a room may need: waiting for another room's session, then its own."""
        return 2 * self.max_wait + 90

    def in_hours(self) -> bool:
        start, end = self.hours
        return start <= self._now().hour < end

    def can_start(self) -> bool:
        return not self._tunnel_failed and self.counts["sessions"] < self.max_sessions and self.in_hours()

    def report(self) -> dict:
        return {**self.counts, "tunnel": "failed" if self._tunnel_failed else "ok" if self._public else "not_started"}

    async def _ensure_tunnel(self) -> bool:
        if self._public:
            return True
        if self._tunnel_failed:
            return False
        try:
            self._server = ThreadingHTTPServer(("127.0.0.1", self.port), _handler(self._live))
            threading.Thread(target=self._server.serve_forever, daemon=True).start()
            port = self._server.server_address[1]
            self._tunnel, self._public = await asyncio.to_thread(self._start_tunnel, self.tunnel_binary, port)
            return True
        except Exception:
            self._tunnel_failed = True
            return False

    async def verify(self, page, *, label: str, solved: Callable[[], bool],
                     gate_present: Callable[[], Awaitable[bool]] | None = None, touch: bool = True) -> bool:
        """Hold the page for a person. True only when `solved()` turned true while waiting."""
        await asyncio.sleep(self.settle_seconds)  # a reload may already pass without anyone
        if solved():
            return True
        try:
            await asyncio.wait_for(self._lock.acquire(), timeout=self.max_wait)
        except asyncio.TimeoutError:
            return False
        try:
            if solved():
                return True
            if not self.can_start() or not await self._ensure_tunnel():
                return False
            self.counts["sessions"] += 1
            token = secrets.token_urlsafe(24)
            self._live.open(token)
            try:
                await asyncio.to_thread(self._push, self.webhook_url, "巡检需要人工验证",
                                        f"{label[:30]}：点开后按提示拖动滑块或画线（{int(self.max_wait // 60)} 分钟内有效）",
                                        f"{self._public}/{token}/")
            except Exception:
                self.counts["push_failed"] += 1
                return False
            ok = await self._hold(page, solved, gate_present, touch)
            self.counts["solved" if ok else "timeouts"] += 1
            with self._live.lock:
                self._live.status = "验证通过，巡检已继续。可以关掉这个页面。" if ok else "已超时，本轮记为人机验证。"
            await asyncio.sleep(3.0 if ok else 0)
            return ok
        finally:
            self._live.close()
            self._lock.release()

    async def _hold(self, page, solved, gate_present, touch) -> bool:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + self.max_wait
        size = page.viewport_size or {"width": 390, "height": 844}
        width, height = size["width"], size["height"]
        cdp = await page.context.new_cdp_session(page) if touch else None
        pressed, last_up, reloaded = False, None, False
        received = 0
        while loop.time() < deadline:
            if solved():
                return True
            while True:
                try:
                    kind, x, y = self._live.events.get_nowait()
                except queue.Empty:
                    break
                received += 1
                self.counts["input_events"] += 1
                point = {"x": x * width, "y": y * height}
                try:
                    if touch:
                        if kind == "down" and not pressed:
                            await cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [point]})
                            pressed = True
                        elif kind == "move" and pressed:
                            await cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [point]})
                        elif kind == "up" and pressed:
                            await cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
                            pressed, last_up = False, loop.time()
                    else:
                        await page.mouse.move(point["x"], point["y"])
                        if kind == "down" and not pressed:
                            await page.mouse.down()
                            pressed = True
                        elif kind == "up" and pressed:
                            await page.mouse.up()
                            pressed, last_up = False, loop.time()
                except Exception:
                    pressed = False
            if (last_up is not None and not reloaded and gate_present is not None
                    and loop.time() - last_up > RELOAD_AFTER_GESTURE and not solved()):
                # The challenge may be gone without the page asking for its data again.
                if not await gate_present():
                    reloaded = True
                    try:
                        await page.reload(wait_until="domcontentloaded", timeout=15000)
                    except Exception:
                        pass
            try:
                frame = await page.screenshot(type="jpeg", quality=55, scale="css", timeout=3000)
                with self._live.lock:
                    self._live.frame = frame
                    if received:
                        self._live.status = f"已收到你的操作 {received} 次，验证通过后会自动继续"
            except Exception:
                pass
            await asyncio.sleep(FRAME_INTERVAL)
        return solved()

    async def close(self) -> None:
        self._live.close()
        if self._tunnel is not None:
            try:
                self._tunnel.terminate()
            except Exception:
                pass
        if self._server is not None:
            try:
                await asyncio.to_thread(self._server.shutdown)
            except Exception:
                pass
