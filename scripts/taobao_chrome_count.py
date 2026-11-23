"""One anonymous Chromium-channel=chrome visit to the TCL anchor search results."""
import asyncio
import sys
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


async def check_page(page):
    url = urlsplit(page.url)
    if url.hostname != "tbzb.taobao.com" or url.path.rstrip("/") != "/search" or parse_qs(url.query).get("searchQuery") != ["TCL"]:
        raise Inconclusive("页面跳离 TCL 搜索结果")
    if await page.get_by_text("拖动滑块", exact=False).first.is_visible() or await page.get_by_text("请先登录", exact=False).first.is_visible():
        raise Inconclusive("页面要求验证或登录")


async def count(page):
    js = PARSER.read_text(encoding="utf-8")
    response = await page.goto(SEARCH, wait_until="domcontentloaded", timeout=45000)
    if response is None or not response.ok:
        raise Inconclusive("搜索页面加载失败")
    names = {}
    quiet = 0
    for _ in range(100):
        await check_page(page)
        sample = await page.evaluate(js)
        if sample["unresolved"]:
            await asyncio.sleep(1)
            sample = await page.evaluate(js)
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
        if not sample["cards"]:
            quiet = 0
        else:
            moved = await page.evaluate(SCROLL)
            quiet = quiet + 1 if not moved and before == len(names) else 0
            if quiet >= 4:
                await check_page(page)
                return sorted(name for name, live in names.items() if live)
        await asyncio.sleep(0.8)
    raise Inconclusive("限定时间内未读到稳定、可归属店铺的完整卡片列表")


async def main():
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(channel="chrome", headless=False)
        try:
            page = await browser.new_page(locale="zh-CN", viewport={"width": 1440, "height": 960})
            names = await count(page)
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
        sys.exit(f"无法判定：Chrome 启动、导航或页面读取失败（{type(exc).__name__}）")
