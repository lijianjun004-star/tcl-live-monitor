"""Read rendered search cards in a normal Google Chrome session."""
import re
import time
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from playwright.sync_api import Error

SEARCH_URL = "https://tbzb.taobao.com/search?liveSource=pc_live.anchor&searchQuery=TCL&spm=tbpc.anchor.nav.dsearch"
CARDS = Path(__file__).with_name("cards.js").read_text(encoding="utf-8")
GATE = re.compile("拖动滑块|请先登录|请完成验证|验证后继续|访问过于频繁|访问被拒绝|访问受限|请登录后查看|登录后查看更多|安全验证")
LOGIN_FRAMES = {"login.taobao.com", "login.m.taobao.com", "passport.taobao.com"}
SCROLL = """(toTop = false) => {
    const targets = [document.scrollingElement, ...document.querySelectorAll('main,section,div,ul')];
    let moved = false;
    for (const el of new Set(targets)) {
        if (!el || el.clientHeight < 120 || el.scrollHeight <= el.clientHeight + 2) continue;
        if (el !== document.scrollingElement && !/auto|scroll/.test(getComputedStyle(el).overflowY)) continue;
        const before = el.scrollTop;
        if (toTop) el.scrollTop = 0;
        else el.scrollTop += Math.max(100, Math.floor(el.clientHeight * 0.75));
        if (Math.abs(el.scrollTop - before) > 1) moved = true;
    }
    return moved;
}"""


class ScanError(Exception):
    """Incomplete or inaccessible results; callers must keep the last good snapshot."""


def room_url(href):
    try:
        u = urlsplit(href)
        if u.scheme != "https" or u.netloc.lower() != "tbzb.taobao.com" or u.path.rstrip("/") != "/live":
            return None
        ids = parse_qs(u.query, keep_blank_values=True).get("liveId", [])
        if len(ids) == 1 and re.fullmatch(r"[1-9][0-9]{4,19}", ids[0]):
            return "https://tbzb.taobao.com/live?liveId=" + ids[0]
    except (ValueError, TypeError, AttributeError):
        pass
    return None


def frames(page):
    yield page.main_frame
    for frame in page.frames:
        if frame != page.main_frame and urlsplit(frame.url).hostname == "tbzb.taobao.com":
            if frame.frame_element().is_visible():
                yield frame


def on_search(page):
    u = urlsplit(page.url)
    return (u.scheme == "https" and u.netloc.lower() == "tbzb.taobao.com" and
            u.path.rstrip("/") == "/search" and parse_qs(u.query).get("searchQuery") == ["TCL"])


def check_access(page):
    if not on_search(page):
        raise ScanError("页面已跳离 TCL 主播搜索。")
    for frame in page.frames:
        if frame != page.main_frame and urlsplit(frame.url).hostname in LOGIN_FRAMES:
            if frame.frame_element().is_visible():
                raise ScanError("搜索页出现登录框。")
    for frame in frames(page):
        if frame.get_by_text(GATE).filter(visible=True).count():
            raise ScanError("搜索页要求登录、验证或限制访问。")


def navigate(page):
    response = page.goto(SEARCH_URL, wait_until="domcontentloaded", timeout=45000)
    if response is None or not response.ok:
        raise ScanError("搜索页加载失败。")
    check_access(page)


def read_visible(page):
    visible = {}
    for frame in frames(page):
        sample = frame.evaluate(CARDS)
        if sample["unresolved"]:
            return None
        for card in sample["cards"]:
            name = card["name"]
            if name in visible:
                raise ScanError("存在同名主播卡片，无法唯一匹配。")
            hrefs = card["hrefs"]
            links = {room_url(h) for h in hrefs}
            if None in links or len(links) > 1:
                raise ScanError(f"「{name}」的进入按钮没有唯一可信的淘宝直播间地址。")
            visible[name] = dict(name=name, isLive=card["isLive"], liveUrl=next(iter(links), None))
    return visible


def scroll(page):
    moved = False
    for frame in frames(page):
        moved |= bool(frame.evaluate(SCROLL))
    return moved


def collect(page):
    rows = {}
    previous = None
    quiet = 0
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        check_access(page)
        visible = read_visible(page)
        if visible:
            for name, row in visible.items():
                if name in rows and row != rows[name]:
                    raise ScanError(f"「{name}」在扫描期间发生变化。")
                rows[name] = row
        moved = scroll(page) if visible is not None else False
        quiet = quiet + 1 if visible and visible == previous and not moved else 0
        if quiet >= 4:
            check_access(page)
            return rows
        previous = visible
        page.wait_for_timeout(650)
    raise ScanError("未读到稳定、完整、可归属到店铺的搜索卡片列表。")


def discover_destination(probe, button):
    # Observe only the normal navigation from the uniquely identified visible
    # 进入 control. No private API calls or guessed URLs.
    popups = []
    def opened(tab):
        popups.append(tab)
    probe.on("popup", opened)
    try:
        button.click(timeout=4000)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            candidates = [p for p in [probe, *popups] if not p.is_closed()]
            if len(popups) > 1:
                raise ScanError("进入按钮打开了多个窗口。")
            links = {room_url(tab.url) for tab in candidates} - {None}
            if len(links) == 1:
                return links.pop()
            if len(links) > 1:
                break
            if not candidates:
                break
            candidates[0].wait_for_timeout(150)
        raise ScanError("点击进入后没有观察到可核对的淘宝直播间地址。")
    finally:
        probe.remove_listener("popup", opened)
        for tab in popups:
            if not tab.is_closed():
                tab.close()


def resolve_click_only(context, name, scan_deadline):
    probe = context.new_page()
    try:
        navigate(probe)
        deadline = min(time.monotonic() + 20, scan_deadline)
        while time.monotonic() < deadline:
            check_access(probe)
            visible = read_visible(probe)
            if visible and name in visible:
                row = visible[name]
                if not row["isLive"]:
                    raise ScanError(f"「{name}」在复核进入按钮时状态发生变化。")
                if row["liveUrl"]:
                    return row["liveUrl"]
                for frame in frames(probe):
                    handle = frame.evaluate_handle(CARDS, name)
                    try:
                        button = handle.as_element()
                        if button is not None:
                            return discover_destination(probe, button)
                    finally:
                        handle.dispose()
            if visible is not None:
                scroll(probe)
            probe.wait_for_timeout(350)
        raise ScanError(f"未能在独立搜索页核对「{name}」的进入按钮。")
    finally:
        if not probe.is_closed():
            probe.close()


def scan(page):
    """Collect one complete search snapshot. Failure never yields offline rows."""
    try:
        navigate(page)
        rows = collect(page)
        deadline = time.monotonic() + 75
        for row in rows.values():
            if row["isLive"] and not row["liveUrl"]:
                if time.monotonic() >= deadline:
                    raise ScanError("解析进入按钮链接超时。")
                row["liveUrl"] = resolve_click_only(page.context, row["name"], deadline)
        check_access(page)
        return list(rows.values())
    except Error as exc:
        raise ScanError(f"Chrome 搜索页读取失败（{type(exc).__name__}）。") from None
