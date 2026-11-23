"""One-shot: can the PC path shop -> live entry -> tbzb live page find TCL电视官方旗舰店's current session?

Path from the user's screenshots: the Taobao/Tmall PC shop, a product page whose shop header
shows a live badge, then the PC live page tbzb.taobao.com/live?liveId=<session>. Any slider or
drawn-path challenge on the way is handed to a person through core.human_verify (desktop mouse).
Only Alibaba hosts are loaded; media and fonts are blocked. Prints page shapes, live-id evidence
and verification counts only: no cookies, query strings of the verification link, or page text.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import sys
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from playwright.async_api import async_playwright  # noqa: E402

from core.human_verify import HumanVerifier  # noqa: E402
from platforms.ali_live.classifier import limit_url_kind  # noqa: E402
from platforms.ali_live.policy import ali_host  # noqa: E402

SELLER_ID = "395601843"  # config/probe-targets.json tmall-tcl-tv-official
SHOP_ENTRY = f"https://store.taobao.com/shop/view_shop.htm?user_number_id={SELLER_ID}"
DESKTOP_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36")
LIVE_LINK = re.compile(r"tbzb\.taobao\.com/live|liveId=\d{6,}|taolive", re.I)
GATE_FRAME = re.compile(r"punish|captcha|_____tmd_____|x5sec|baxia", re.I)
GATE_TEXT = ("滑块", "拖动", "请按照", "安全验证", "人机验证", "验证码")
LIVE_KEYS = re.compile(r"liveid|living|anchor|accountid|roomstatus|streamstatus|broadcaster", re.I)
PRIVATE = re.compile(r"token|cookie|nick|^pin$|user_?name|phone|mail|sign|h5st", re.I)

log = []


def shape(url: str) -> str:
    parts = urlsplit(url)
    live = parse_qs(parts.query).get("liveId", [None])[0]
    return f"{parts.netloc}{parts.path}" + (f"?liveId={live}" if live and live.isdigit() else "")


def note(kind: str, **data) -> None:
    entry = {"step": kind, **data}
    log.append(entry)
    print("STEP", json.dumps(entry, ensure_ascii=False), flush=True)


def walk(node, path="", out=None, depth=0):
    out = [] if out is None else out
    if depth > 8 or len(out) >= 40:
        return out
    if isinstance(node, dict):
        for key, value in list(node.items())[:150]:
            walk(value, f"{path}.{key}" if path else str(key), out, depth + 1)
    elif isinstance(node, list):
        for i, value in enumerate(node[:5]):
            walk(value, f"{path}[{i}]", out, depth + 1)
    elif LIVE_KEYS.search(path.rsplit(".", 1)[-1]) and not PRIVATE.search(path.rsplit(".", 1)[-1]):
        if isinstance(node, (int, float, bool)) or node is None or (isinstance(node, str) and len(node) <= 24):
            out.append({"path": path[:120], "value": node})
    return out


async def gate_on(page) -> bool:
    if limit_url_kind(page.url):
        return True
    for frame in page.frames:
        if GATE_FRAME.search(frame.url or ""):
            return True
    try:
        text = await page.locator("body").inner_text(timeout=1500)
    except Exception:
        return False
    return any(word in text[:4000] for word in GATE_TEXT)


async def settle(page, human, where: str) -> bool:
    """True when the page is usable. A challenge is offered to a person once per page."""
    await page.wait_for_timeout(2500)
    if not await gate_on(page):
        return True
    note("challenge", where=where, page=shape(page.url))
    if human is None or not human.can_start():
        note("challenge_unhandled", reason="no_verifier_or_limit")
        return False
    flag = {"clear": False}

    async def watch():
        while not flag["clear"]:
            await asyncio.sleep(1.5)
            try:
                flag["clear"] = not await gate_on(page)
            except Exception:
                pass

    watcher = asyncio.create_task(watch())
    try:
        solved = await human.verify(page, label="TCL电视官方旗舰店（路径测试）", solved=lambda: flag["clear"],
                                    touch=False)
    finally:
        watcher.cancel()
    note("challenge_result", solved=solved, report=human.report())
    return solved


async def live_links(page) -> list[str]:
    try:
        hrefs = await page.evaluate("""() => Array.from(document.querySelectorAll('a[href]'))
            .map(a => a.href).filter(h => /tbzb\\.taobao\\.com\\/live|liveId=\\d{6,}|taolive/i.test(h)).slice(0, 10)""")
    except Exception:
        hrefs = []
    return list(dict.fromkeys(hrefs))


async def main() -> int:
    human = HumanVerifier.from_env(os.environ)
    note("verifier", enabled=human is not None)
    responses = []
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(executable_path=os.environ.get("PATH_TEST_CHROMIUM") or None)
        context = await browser.new_context(user_agent=DESKTOP_UA, locale="zh-CN",
                                            viewport={"width": 1280, "height": 800})

        async def route(r):
            host = (urlsplit(r.request.url).hostname or "").lower()
            if r.request.resource_type in ("media", "font") or not ali_host(host):
                await r.abort()
            else:
                await r.fallback()
        await context.route("**/*", route)

        async def on_response(res):
            try:
                if res.request.resource_type not in ("xhr", "fetch", "script"):
                    return
                text = await res.text()
                if "liveId" not in text and "liveid" not in text:
                    return
                body = text.strip()
                match = re.match(r"^[\w$.]+\s*\((.*)\)\s*;?\s*$", body, re.S)
                data = json.loads(match.group(1) if match else body)
                found = walk(data)
                if found:
                    responses.append({"from": shape(res.url).split("?")[0], "fields": found[:15]})
            except Exception:
                pass
        context.on("response", lambda res: asyncio.ensure_future(on_response(res)))

        page = await context.new_page()
        try:
            # 1. Shop
            try:
                await page.goto(SHOP_ENTRY, wait_until="domcontentloaded", timeout=30000)
            except Exception as error:
                note("shop_navigation_error", error=type(error).__name__)
            ok = await settle(page, human, "shop")
            note("shop", page=shape(page.url), title=(await page.title())[:40], usable=ok)
            links = await live_links(page) if ok else []
            note("shop_live_links", links=[shape(h) for h in links])

            # 2. A product page from this shop, where the shop header can carry the live badge
            if ok and not links:
                items = await page.evaluate("""() => Array.from(document.querySelectorAll('a[href]')).map(a => a.href)
                    .filter(h => /(item\\.taobao\\.com|detail\\.tmall\\.com)\\/item\\.htm/.test(h)).slice(0, 3)""")
                note("product_candidates", count=len(items))
                if items:
                    try:
                        await page.goto(items[0], wait_until="domcontentloaded", timeout=30000)
                    except Exception as error:
                        note("product_navigation_error", error=type(error).__name__)
                    ok = await settle(page, human, "product")
                    note("product", page=shape(page.url), usable=ok)
                    links = await live_links(page) if ok else []
                    note("product_live_links", links=[shape(h) for h in links])

            # 3. The PC live page
            if links:
                try:
                    await page.goto(links[0], wait_until="domcontentloaded", timeout=30000)
                except Exception as error:
                    note("live_navigation_error", error=type(error).__name__)
                ok = await settle(page, human, "live")
                await page.wait_for_timeout(5000)
                note("live_page", page=shape(page.url), title=(await page.title())[:40], usable=ok)
        finally:
            await page.wait_for_timeout(1000)
            if human is not None:
                await human.close()
            await browser.close()
    note("live_id_evidence", responses=responses[:8])
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
