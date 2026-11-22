"""Remote slider practice: can a phone finger drag reach a cloud browser as a real mouse drag?

One-shot experiment. A headless Chromium shows a local practice slider (no third-party site).
A tiny token-protected web page, published through a temporary Cloudflare quick tunnel,
streams the browser view and turns the viewer's pointer down/move/up into mouse down/move/up.
The link is pushed through the project's Bark webhook. The run ends 60 s after a pass,
or after 15 minutes. Only the practice page is ever opened; every other request is blocked.
"""
from __future__ import annotations

import json
import os
import queue
import re
import secrets
import subprocess
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from playwright.sync_api import sync_playwright

PORT = 8765
WIDTH, HEIGHT = 400, 300
LIFETIME = int(os.environ.get("PRACTICE_LIFETIME", 15 * 60))
LOCAL = os.environ.get("PRACTICE_LOCAL") == "1"  # offline check: no tunnel, no push
TOKEN = secrets.token_urlsafe(24)

PRACTICE = """<!doctype html><meta charset=utf-8><body style="margin:0;font:14px sans-serif;background:#fff">
<p style="text-align:center;margin:56px 0 0;color:#333">练习滑块（不是淘宝页面）</p>
<div id=track style="position:relative;width:340px;height:44px;background:#e8e8e8;margin:40px auto;user-select:none">
<div id=fill style="position:absolute;left:0;top:0;height:44px;width:0;background:#7ac23c"></div>
<span id=tip style="position:absolute;width:100%;text-align:center;line-height:44px;color:#666">请按住滑块，拖动到最右边</span>
<div id=knob style="position:absolute;left:0;top:0;width:44px;height:44px;background:#fff;border:1px solid #bbb;box-sizing:border-box;line-height:42px;text-align:center;cursor:pointer">&gt;&gt;</div>
</div><script>
const W=340-44;let sx=null,moves=0,t0=0,trusted=true,attempts=0;
window.__result={passed:false,attempts:0};
knob.addEventListener('mousedown',e=>{sx=e.clientX;moves=0;t0=performance.now();trusted=e.isTrusted;});
document.addEventListener('mousemove',e=>{if(sx===null)return;moves++;trusted=trusted&&e.isTrusted;
 const d=Math.max(0,Math.min(W,e.clientX-sx));knob.style.left=d+'px';fill.style.width=(d+22)+'px';
 if(d>=W){sx=null;tip.textContent='验证通过';tip.style.color='#fff';
  window.__result={passed:true,attempts:attempts+1,moves,trusted,ms:Math.round(performance.now()-t0)};}});
document.addEventListener('mouseup',()=>{if(sx===null)return;sx=null;attempts++;knob.style.left='0';fill.style.width='0';
 window.__result={passed:false,attempts};});
</script></body>"""

VIEWER = """<!doctype html><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>远程滑块练习</title>
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
function pt(e){const r=v.getBoundingClientRect();return{x:(e.clientX-r.left)/r.width,y:(e.clientY-r.top)/r.height,p:e.pointerType}}
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

events: queue.Queue = queue.Queue()
state = {"frame": b"", "status": "等待你按住滑块往右拖", "received": 0, "pointer_types": set()}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # never log request paths (they contain the token)
        pass

    def _send(self, code, body=b"", ctype="text/plain; charset=utf-8"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _route(self):
        prefix = "/" + TOKEN
        path = self.path.split("?", 1)[0]
        if not (path == prefix or path.startswith(prefix + "/")):
            return None
        return path[len(prefix):] or "/"

    def do_GET(self):
        route = self._route()
        if route in ("/", ""):
            self._send(200, VIEWER.encode(), "text/html; charset=utf-8")
        elif route == "/frame.jpg":
            self._send(200, state["frame"], "image/jpeg")
        elif route == "/status":
            self._send(200, json.dumps({"status": state["status"]}, ensure_ascii=False).encode(), "application/json")
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
        for item in batch[:500] if isinstance(batch, list) else []:
            if (isinstance(item, dict) and item.get("t") in ("down", "move", "up")
                    and all(isinstance(item.get(k), (int, float)) for k in ("x", "y"))):
                events.put((item["t"], min(max(float(item["x"]), 0), 1), min(max(float(item["y"]), 0), 1)))
                state["pointer_types"].add(str(item.get("p"))[:8])
        self._send(204)


def start_tunnel():
    proc = subprocess.Popen(["./cloudflared", "tunnel", "--no-autoupdate", "--url", f"http://127.0.0.1:{PORT}"],
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    deadline = time.time() + 90
    for line in proc.stdout:
        found = re.search(r"https://[a-z0-9-]+\.trycloudflare\.com", line)
        if found:
            threading.Thread(target=lambda: [None for _ in proc.stdout], daemon=True).start()
            return proc, found.group(0)
        if time.time() > deadline:
            break
    raise SystemExit("TUNNEL_NOT_READY")


def push_link(link):
    url, kind = os.environ.get("WEBHOOK_URL", ""), os.environ.get("WEBHOOK_KIND", "")
    if not url.startswith("https://") or kind != "bark":
        print("PUSH_SKIPPED (no Bark webhook)")
        return
    body = json.dumps({"title": "远程滑块练习", "body": "点开后按住滑块往右拖到底（15 分钟内有效）",
                       "group": "tcl-live-monitor", "url": link}, ensure_ascii=False).encode()
    request = urllib.request.Request(url, data=body, method="POST",
                                     headers={"Content-Type": "application/json; charset=utf-8"})
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            print("PUSH_STATUS", response.status)
    except Exception as error:  # noqa: BLE001 - only the class name is printed
        print("PUSH_FAILED", type(error).__name__)


def main():
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=os.environ.get("PRACTICE_CHROMIUM") or None)
        page = browser.new_page(viewport={"width": WIDTH, "height": HEIGHT})
        page.route("**/*", lambda route: route.abort())  # the practice page is inline; block everything else
        page.set_content(PRACTICE)
        state["frame"] = page.screenshot(type="jpeg", quality=60)
        if LOCAL:
            tunnel, link = None, f"http://127.0.0.1:{PORT}/{TOKEN}/"
            print("LOCAL_LINK", link, flush=True)
        else:
            tunnel, public = start_tunnel()
            link = public + "/" + TOKEN + "/"
            push_link(link)
        print("VIEWER_READY", time.strftime("%H:%M:%S", time.gmtime()), "UTC")
        started, passed_at, result, pressed = time.time(), None, {}, False
        while time.time() - started < LIFETIME and (passed_at is None or time.time() - passed_at < 60):
            while True:
                try:
                    kind, x, y = events.get_nowait()
                except queue.Empty:
                    break
                state["received"] += 1
                page.mouse.move(x * WIDTH, y * HEIGHT)
                if kind == "down" and not pressed:
                    page.mouse.down()
                    pressed = True
                elif kind == "up" and pressed:
                    page.mouse.up()
                    pressed = False
            result = page.evaluate("window.__result")
            if result.get("passed") and passed_at is None:
                passed_at = time.time()
                state["status"] = "验证通过 ✅ 手机拖动已经变成云端的鼠标拖动。可以关掉这个页面了。"
            elif not result.get("passed"):
                tries = result.get("attempts", 0)
                state["status"] = ("等待你按住滑块往右拖" if not state["received"] else
                                   f"收到你的操作 {state['received']} 次，已尝试 {tries} 次，还没拖到底")
            state["frame"] = page.screenshot(type="jpeg", quality=60)
            time.sleep(0.05)
        browser.close()
        if tunnel:
            tunnel.terminate()
    server.shutdown()
    print("RESULT", json.dumps({**result, "input_events": state["received"],
                                "pointer_types": sorted(state["pointer_types"]),
                                "waited_s": round(time.time() - started)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
