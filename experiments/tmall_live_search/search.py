"""What does the Taobao live search page (query "TCL") return?

Default: one anonymous read in Playwright's Chromium, Alibaba hosts only (run 45090743621: the
page redirected to login.taobao.com and returned no results).

SEARCH_USE_CHROME=1 (on the operator's own computer): opens the installed Google Chrome with a
dedicated profile (SEARCH_PROFILE_DIR, default ~/.tcl-live-monitor/chrome-profile), in a window.
If Taobao asks for a login, the operator logs in by hand in that window; the script waits up to
SEARCH_LOGIN_WAIT seconds (default 300) and never reads or stores the password. The profile keeps
the login for later runs. Challenges are left to the operator in the same window.

Prints, for each result: anchor name, live-status fields, the public session liveId, and whether
the anchor matches a registered Tmall target (config/probe-targets.json). Account ids are never printed.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import sys
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "src"))

from playwright.async_api import async_playwright  # noqa: E402

from platforms.ali_live.classifier import limit_url_kind  # noqa: E402
from platforms.ali_live.policy import ali_host  # noqa: E402

URL = "https://tbzb.taobao.com/search?liveSource=pc_live.anchor&searchQuery=TCL"
DESKTOP_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36")
GATE = re.compile(r"punish|captcha|_____tmd_____|x5sec|baxia", re.I)
ROSTER = {t["accountId"]: t["key"] for t in json.loads((ROOT / "config/probe-targets.json").read_text())["tmall"]}
ID_KEYS = ("accountId", "anchorId", "userId", "broadcasterId", "sellerId")
NAME_KEYS = ("accountName", "anchorName", "nick", "userNick", "broadCasterName", "title")
STATUS_KEYS = ("roomStatus", "streamStatus", "status", "liveStatus", "isLive", "living")


def records(node, out, depth=0):
    """Collect dict nodes that look like one live-room result."""
    if depth > 12 or len(out) > 200:
        return
    if isinstance(node, dict):
        if "liveId" in node or "liveid" in node:
            out.append(node)
        for value in list(node.values())[:200]:
            records(value, out, depth + 1)
    elif isinstance(node, list):
        for value in node[:100]:
            records(value, out, depth + 1)


def pick(node, keys):
    for key in keys:
        if key in node and node[key] not in (None, ""):
            return node[key]
        for nest in ("broadCaster", "anchor", "accountInfo", "liveInfo"):
            inner = node.get(nest)
            if isinstance(inner, dict) and inner.get(key) not in (None, ""):
                return inner[key]
    return None


def summarize(node):
    account = str(pick(node, ID_KEYS) or "")
    status = {k: node.get(k) for k in STATUS_KEYS if k in node and isinstance(node.get(k), (int, str, bool))}
    name = pick(node, NAME_KEYS)
    return {
        "name": str(name)[:24] if name is not None else None,
        "live_id": str(node.get("liveId") or node.get("liveid") or "")[:20],
        "status": status,
        "registered": ROSTER.get(account),
        "has_account_id": bool(account),
    }


async def main():
    found, functions, gate_hits = [], set(), []
    use_chrome = os.environ.get("SEARCH_USE_CHROME") == "1"
    async with async_playwright() as pw:
        if use_chrome:
            profile = Path(os.environ.get("SEARCH_PROFILE_DIR") or Path.home() / ".tcl-live-monitor" / "chrome-profile")
            profile.mkdir(parents=True, exist_ok=True)
            # The operator's own Chrome, windowed, with a profile used only for this monitor.
            context = await pw.chromium.launch_persistent_context(
                str(profile), channel="chrome", headless=False, locale="zh-CN", viewport={"width": 1280, "height": 900})
            browser = None
            print("CHROME_PROFILE", "dedicated profile in use")
        else:
            browser = await pw.chromium.launch(executable_path=os.environ.get("PATH_TEST_CHROMIUM") or None)
            context = await browser.new_context(user_agent=DESKTOP_UA, locale="zh-CN", viewport={"width": 1280, "height": 900})

            async def route(r):
                host = (urlsplit(r.request.url).hostname or "").lower()
                if r.request.resource_type in ("media", "font") or not ali_host(host):
                    await r.abort()
                else:
                    await r.fallback()
            await context.route("**/*", route)

        async def on_response(res):
            try:
                parts = urlsplit(res.url)
                if GATE.search(res.url):
                    gate_hits.append(f"{parts.netloc}{parts.path}"[:80])
                api = re.search(r"/h5/(mtop\.[a-z0-9._-]+)/", parts.path, re.I)
                if api:
                    functions.add(api.group(1)[:80])
                if res.request.resource_type not in ("xhr", "fetch", "script"):
                    return
                text = await res.text()
                if "liveId" not in text:
                    return
                body = text.strip()
                match = re.match(r"^[\w$.]+\s*\((.*)\)\s*;?\s*$", body, re.S)
                data = json.loads(match.group(1) if match else body)
                ret = data.get("ret") if isinstance(data, dict) else None
                if isinstance(ret, list) and ret and not str(ret[0]).startswith("SUCCESS"):
                    gate_hits.append("api_ret:" + re.sub(r"[^A-Z0-9_:]", "", str(ret[0]).upper())[:40])
                out = []
                records(data, out)
                found.extend(out)
            except Exception:
                pass
        context.on("response", lambda res: asyncio.ensure_future(on_response(res)))

        page = await context.new_page()
        try:
            await page.goto(URL, wait_until="domcontentloaded", timeout=30000)
        except Exception as error:
            print("NAVIGATION_ERROR", type(error).__name__)
        if use_chrome and limit_url_kind(page.url) == "login":
            wait = int(os.environ.get("SEARCH_LOGIN_WAIT") or 300)
            print(f"LOGIN_NEEDED 请在打开的 Chrome 窗口里登录淘宝，最多等 {wait} 秒", flush=True)
            for _ in range(wait // 3):
                await page.wait_for_timeout(3000)
                if limit_url_kind(page.url) != "login":
                    break
            print("LOGIN_DONE" if limit_url_kind(page.url) != "login" else "LOGIN_TIMEOUT", flush=True)
            if limit_url_kind(page.url) != "login":
                found.clear()
                try:
                    await page.goto(URL, wait_until="domcontentloaded", timeout=30000)
                except Exception as error:
                    print("NAVIGATION_ERROR", type(error).__name__)
        for _ in range(4):
            await page.wait_for_timeout(2500)
            try:
                await page.mouse.wheel(0, 1500)
            except Exception:
                pass
        final = urlsplit(page.url)
        print("FINAL", f"{final.netloc}{final.path}", "limit_kind", limit_url_kind(page.url))
        print("TITLE", (await page.title())[:40])
        try:
            cards = await page.evaluate("""() => Array.from(document.querySelectorAll('a[href*="liveId="]'))
                .slice(0, 40).map(a => ({text: (a.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 30),
                                         live: (a.href.match(/liveId=(\\d{6,20})/) || [])[1] || ''}))""")
        except Exception:
            cards = []
        if browser is not None:
            await browser.close()
        else:
            await context.close()
    print("GATE_HITS", json.dumps(sorted(set(gate_hits))[:10]))
    print("MTOP", json.dumps(sorted(functions)[:20]))
    seen, rows = set(), []
    for node in found:
        row = summarize(node)
        if row["live_id"] and row["live_id"] not in seen:
            seen.add(row["live_id"])
            rows.append(row)
    print("RESULTS", len(rows))
    for row in rows[:40]:
        print("ROW", json.dumps(row, ensure_ascii=False))
    print("CARDS", len(cards))
    for card in cards[:40]:
        print("CARD", json.dumps(card, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
