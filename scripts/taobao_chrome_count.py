"""One anonymous Google Chrome visit to the TCL anchor search results."""
import asyncio
import sys
import re
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from playwright.async_api import Error, async_playwright

SEARCH = "https://tbzb.taobao.com/search?liveSource=pc_live.anchor&searchQuery=TCL&spm=tbpc.anchor.nav.dsearch"
PARSER = Path(__file__).with_name("taobao_count_cards.js")
# Scroll only within this results document. Smaller steps overlap virtual cards.
SCROLL = """() => {
    const targets = [document.scrollingElement, ...document.querySelectorAll('main,section,div,ul')];
    let moved = false;
    for (const el of new Set(targets)) {
        if (!el || el.clientHeight < 120 || el.scrollHeight <= el.clientHeight + 2) continue;
        if (el !== document.scrollingElement && !/auto|scroll/.test(getComputedStyle(el).overflowY)) continue;
        const before = el.scrollTop;
        el.scrollTop += Math.max(100, Math.floor(el.clientHeight * 0.75));
        if (el.scrollTop > before + 1) moved = true;
    }
    return moved;
}"""


class Inconclusive(Exception):
    pass


def diagnostic(exc):
    detail = str(exc)
    network = re.search(r"net::ERR_[A-Z0-9_]+", detail)
    if network:
        return network.group()
    for phrase in ("Execution context was destroyed", "Target page, context or browser has been closed",
                   "Executable doesn't exist", "Missing X server", "Timeout", "SyntaxError",
                   "TypeError", "ReferenceError", "strict mode violation", "interrupted by another navigation"):
        if phrase.lower() in detail.lower():
            return phrase
    return type(exc).__name__


async def check_page(page):
    url = urlsplit(page.url)
    if url.hostname != "tbzb.taobao.com" or url.path.rstrip("/") != "/search" or parse_qs(url.query).get("searchQuery") != ["TCL"]:
        raise Inconclusive("页面跳离 TCL 搜索结果")
    if await page.get_by_text("拖动滑块", exact=False).first.is_visible() or await page.get_by_text("请先登录", exact=False).first.is_visible():
        raise Inconclusive("页面要求验证或登录")


def result_frames(page):
    return [page.main_frame] + [
        frame for frame in page.frames if frame != page.main_frame
        and urlsplit(frame.url).hostname == "tbzb.taobao.com"
    ]


async def read_cards(page, js):
    cards, unresolved = [], 0
    for frame in result_frames(page):
        sample = await frame.evaluate(js)
        cards.extend(sample["cards"])
        unresolved += sample["unresolved"]
    return {"cards": cards, "unresolved": unresolved}


async def blocked_reason(page):
    # Login frames can be preloaded and hidden; check whether the frame is visible.
    for frame in page.frames:
        if frame != page.main_frame and urlsplit(frame.url).hostname in {
            "login.taobao.com", "login.m.taobao.com", "passport.taobao.com"
        } and await (await frame.frame_element()).is_visible():
            return "页面显示登录框"
    for phrase in ("访问被拒绝", "访问受限", "验证后继续", "请完成验证", "访问过于频繁",
                   "请登录后查看", "登录后查看更多", "暂无搜索结果"):
        if await page.get_by_text(phrase, exact=False).first.is_visible():
            return f"页面提示「{phrase}」"
    body_len = await page.evaluate("() => (document.body?.innerText || '').trim().length")
    return f"未取得稳定卡片列表（可见正文 {body_len} 字，页面框架 {len(page.frames)} 个）"


async def count(page):
    js = PARSER.read_text(encoding="utf-8")
    try:
        response = await page.goto(SEARCH, wait_until="domcontentloaded", timeout=45000)
    except Error as exc:
        raise Inconclusive(f"打开淘宝搜索页失败（{diagnostic(exc)}）") from None
    if response is None or not response.ok:
        raise Inconclusive(f"搜索页 HTTP 状态 {response.status if response else '无响应'}")
    names = {}
    quiet = 0
    for _ in range(100):
        await check_page(page)
        sample = await read_cards(page, js)
        if sample["unresolved"]:
            await asyncio.sleep(1)
            sample = await read_cards(page, js)
            if sample["unresolved"]:
                raise Inconclusive("存在无法归属到单一店铺的按钮")
        before = len(names)
        seen = set()
        for card in sample["cards"]:
            name, live = card["name"], card["live"]
            if name in seen or (name in names and names[name] != live):
                raise Inconclusive("店名重复或同一店铺状态发生变化")
            seen.add(name)
            names[name] = live
        moved = False
        for frame in result_frames(page):
            if await frame.evaluate(SCROLL):
                moved = True
        if not sample["cards"]:
            quiet = 0
        else:
            quiet = quiet + 1 if not moved and before == len(names) else 0
            if quiet >= 4:
                await check_page(page)
                return sorted(name for name, live in names.items() if live)
        await asyncio.sleep(0.8)
    raise Inconclusive(await blocked_reason(page))


async def main():
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(channel="chrome", headless=False)
        try:
            page = await browser.new_page(locale="zh-CN", viewport={"width": 1440, "height": 960})
            try:
                names = await count(page)
            except Error as exc:
                raise Inconclusive(f"读取搜索结果失败（{diagnostic(exc)}）") from None
            print(f"开播总数：{len(names)}")
            print("开播店铺：" + ("、".join(names) or "无"))
        finally:
            await browser.close()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Inconclusive as exc:
        sys.exit(f"无法判定：{exc}")
    except Error as exc:
        sys.exit(f"无法判定：Chrome 启动或创建访客页面失败（{diagnostic(exc)}）")
