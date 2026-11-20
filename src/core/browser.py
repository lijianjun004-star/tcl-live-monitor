"""Shared Chromium lifecycle and context profiles. Playwright is imported lazily."""

from __future__ import annotations

import io
import os
from pathlib import Path

# Context profiles copied from the verified probes; platform engines pick one by name.
PROFILES = {
    # src/single_room_probe.py collect(): exact options, no extras.
    "jd_live_desktop": {"viewport": {"width": 1280, "height": 820}},
    # experiments/jd_sku_live/discovery.py observe(mobile=True) before the device override.
    "jd_h5_mobile": {
        "is_mobile": True, "has_touch": True, "locale": "zh-CN",
        "viewport": {"width": 390, "height": 844}, "service_workers": "block", "accept_downloads": False,
        "user_agent": ("Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 "
                       "(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"),
    },
    # experiments/jd_sku_live/resolve.py
    "jd_short_link": {"service_workers": "block", "accept_downloads": False, "locale": "zh-CN"},
    # probes/r329/tmall-daily-once.mjs
    "ali_h5_mobile": {
        "viewport": {"width": 390, "height": 844}, "is_mobile": True, "has_touch": True,
        "locale": "zh-CN", "service_workers": "block",
    },
}
DEVICE_KEYS = {"viewport", "screen", "user_agent", "is_mobile", "has_touch", "device_scale_factor"}


class BrowserFactory:
    """One headless Chromium per run; every room gets its own context."""

    def __init__(self, headless: bool = True, executable_path: str | None = None):
        self.headless = headless
        # Only for local runs whose Chromium differs from Playwright's pinned build.
        self.executable_path = executable_path or os.environ.get("V2_CHROMIUM_EXECUTABLE") or None
        self._manager = None
        self.playwright = None
        self.browser = None

    async def __aenter__(self) -> "BrowserFactory":
        from playwright.async_api import async_playwright

        self._manager = async_playwright()
        self.playwright = await self._manager.__aenter__()
        options = {"headless": self.headless}
        if self.executable_path:
            options["executable_path"] = self.executable_path
        self.browser = await self.playwright.chromium.launch(**options)
        return self

    async def __aexit__(self, *exc) -> None:
        try:
            if self.browser:
                await self.browser.close()
        finally:
            if self._manager:
                await self._manager.__aexit__(*exc)

    def device(self, name: str) -> dict:
        if not self.playwright:
            return {}
        return {key: value for key, value in self.playwright.devices[name].items() if key in DEVICE_KEYS}

    async def new_context(self, profile: str, *, device: str | None = None, **extra):
        options = dict(PROFILES[profile])
        if device:
            options.update(self.device(device))
        options.update(extra)
        return await self.browser.new_context(**options)


async def masked_thumbnail(page, path: Path) -> None:
    """Same masking and downscale as single_room_probe.snapshot(), usable by any platform."""
    from PIL import Image

    masks = [
        page.locator("input,textarea,iframe,canvas"),
        page.locator("[class*='chat' i],[class*='comment' i],[class*='danmu' i]"),
    ]
    jpeg = await page.screenshot(type="jpeg", quality=75, timeout=5000, mask=masks)
    path.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(io.BytesIO(jpeg)) as image:
        image.thumbnail((480, 900))
        image.convert("RGB").save(path, "JPEG", quality=60)
