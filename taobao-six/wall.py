"""Tile stream windows belonging to a single local, headed Chrome session."""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from math import ceil, isqrt

from playwright.sync_api import BrowserContext, Error

LOG = logging.getLogger(__name__)
# The collector supplies canonical public watch URLs from verified cards.
ROOM = re.compile(r"https://tbzb\.taobao\.com/live\?liveId=[1-9][0-9]{0,31}")


def tile_bounds(count: int, width: int, height: int, x: int, y: int) -> list[dict]:
    if width < 1 or height < 1:
        raise ValueError("监控屏幕的宽和高必须大于零")
    if count == 0:
        return []
    columns = isqrt(count - 1) + 1
    rows = ceil(count / columns)
    if height > width:
        columns, rows = rows, columns
    bounds = []
    for i in range(count):
        row, col = divmod(i, columns)
        left, top = col * width // columns, row * height // rows
        bounds.append({
            "left": x + left,
            "top": y + top,
            "width": (col + 1) * width // columns - left,
            "height": (row + 1) * height // rows - top,
        })
    return bounds


@dataclass
class Window:
    target: str
    url: str
    window_id: int | None = None
    last_bounds: dict | None = None


class VideoWall:
    """Use only with launch_persistent_context(channel='chrome', headless=False,
    no_viewport=True, args=['--mute-audio']). Geometry is in OS logical pixels.
    """
    def __init__(self, context: BrowserContext, width=1920, height=1080, x=0, y=0):
        self.screen = width, height, x, y
        tile_bounds(0, *self.screen)
        if context.browser is not None:
            self.cdp = context.browser.new_browser_cdp_session()
        else:
            # Older Playwright versions expose only the page session for a profile.
            self.cdp = context.new_cdp_session(context.pages[0])
        self.windows: dict[str, Window] = {}

    def _place(self, window: Window, bounds: dict):
        if bounds == window.last_bounds:
            return
        info = self.cdp.send("Browser.getWindowForTarget", {"targetId": window.target})
        window_id = info["windowId"]
        if window.window_id is not None and window.window_id != window_id:
            # The operator moved this tab into another window. Leave its geometry alone.
            return
        window.window_id = window_id
        if info["bounds"].get("windowState") in ("fullscreen", "maximized", "minimized"):
            self.cdp.send("Browser.setWindowBounds", {
                "windowId": window_id, "bounds": {"windowState": "normal"}
            })
        self.cdp.send("Browser.setWindowBounds", {"windowId": window_id, "bounds": bounds})
        window.last_bounds = bounds

    def _remove(self, name: str):
        window = self.windows[name]
        reply = self.cdp.send("Target.closeTarget", {"targetId": window.target})
        if reply.get("success", True):
            del self.windows[name]

    def sync(self, shops: list[dict]):
        """Update only after a valid full observation. Never pass an unknown/failed scan."""
        live = {shop["name"]: shop["liveUrl"] for shop in shops if shop["isLive"]}
        if self.windows:
            # Reconcile externally closed targets. Never adopt other existing tabs.
            try:
                existing = {t["targetId"] for t in self.cdp.send("Target.getTargets")["targetInfos"]}
            except Error:
                LOG.warning("无法核对 Chrome 窗口，本次保留原布局")
                return
            for name, window in list(self.windows.items()):
                if window.target not in existing:
                    del self.windows[name]
                elif name not in live or (live[name] and live[name] != window.url):
                    try:
                        self._remove(name)
                    except Error:
                        LOG.warning("本次未能关闭旧的监控窗口，将在下次核对")
        names = sorted(name for name, url in live.items()
                       if isinstance(url, str) and ROOM.fullmatch(url))
        for name, bounds in zip(names, tile_bounds(len(names), *self.screen)):
            try:
                window = self.windows.get(name)
                if window is None:
                    created = self.cdp.send("Target.createTarget", {
                        "url": live[name], "newWindow": True, "background": False,
                    })
                    window = Window(created["targetId"], live[name])
                    self.windows[name] = window
                if window.url == live[name]:
                    self._place(window, bounds)
            except Error:
                LOG.warning("Chrome 未能完成一个监控窗口的创建或平铺，将在下次核对")

    def close(self):
        for name in list(self.windows):
            try:
                self._remove(name)
            except Error:
                LOG.debug("监控窗口已关闭或无法访问")
        try:
            self.cdp.detach()
        except Error:
            LOG.debug("Chrome 会话已断开")
