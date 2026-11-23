"""The phone dashboard renders the measured six-shop snapshot. Real browser, no network:
every request is answered locally. Skipped when no Chromium/Chrome can be launched; set
DASHBOARD_CHROMIUM to a browser executable, or TEST_CHROME=1 to use installed Google Chrome."""
import json
import os
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PAGE = (ROOT / "web" / "index.html").read_text(encoding="utf-8")
SNAPSHOT = json.loads((ROOT / "tests" / "fixtures" / "six_snapshot_20261123_124144.json").read_text(encoding="utf-8"))
OBSERVED = datetime(2026, 11, 23, 4, 41, 44, tzinfo=timezone.utc)
ORIGIN = "https://dashboard.test"


def launch(pw):
    if os.environ.get("TEST_CHROME") == "1":
        return pw.chromium.launch(channel="chrome")
    path = os.environ.get("DASHBOARD_CHROMIUM")
    return pw.chromium.launch(**({"executable_path": path} if path else {}))


class DashboardRender(unittest.TestCase):
    def setUp(self):
        try:
            from playwright.sync_api import sync_playwright
            self.pw = sync_playwright().start()
        except Exception as exc:  # pragma: no cover - environment dependent
            self.skipTest(f"Playwright unavailable: {type(exc).__name__}")
        self.addCleanup(self.pw.stop)
        try:
            self.browser = launch(self.pw)
        except Exception as exc:  # pragma: no cover - environment dependent
            self.skipTest(f"no launchable browser: {type(exc).__name__}")
        self.addCleanup(self.browser.close)
        self.reads = 0

    def serve(self, route):
        url = route.request.url
        if url == ORIGIN + "/":
            route.fulfill(status=200, content_type="text/html; charset=utf-8", body=PAGE)
        elif url == ORIGIN + "/api/getLiveStatus":
            self.reads += 1
            body = {**SNAPSHOT, "shops": sorted(SNAPSHOT["shops"], key=lambda s: s["name"])}  # as getLiveStatus returns it
            route.fulfill(status=200, content_type="application/json; charset=utf-8", body=json.dumps(body, ensure_ascii=False))
        else:
            route.abort()

    def test_six_live_shops_with_direct_links_then_stale_notice(self):
        page = self.browser.new_page(viewport={"width": 390, "height": 844})
        page.route("**/*", self.serve)
        page.clock.install(time=OBSERVED + timedelta(minutes=2))
        page.goto(ORIGIN + "/")
        page.wait_for_selector("#results:not([hidden])")
        self.assertEqual(page.text_content("#liveCount"), "6")
        self.assertEqual(page.text_content("#totalCount"), "6")
        self.assertEqual(page.text_content("#syncTime"), "2026-11-23 12:41:44")
        links = page.eval_on_selector_all("#liveList a", "els => els.map(a => [a.getAttribute('aria-label'), a.href])")
        expected = {"进入" + s["name"] + "直播间": s["liveUrl"] for s in SNAPSHOT["shops"]}
        self.assertEqual(dict(links), expected)
        self.assertTrue(page.is_hidden("#outdated"))
        self.assertTrue(page.is_hidden("#offlineGroup"))
        self.assertEqual(page.locator("#liveList").get_by_text("不足 1 分钟").count(), 6)

        page.clock.run_for(6 * 60 * 1000)  # collector silent for 6 minutes; the page keeps re-reading
        self.assertGreater(self.reads, 1)
        self.assertTrue(page.is_visible("#outdated"))
        self.assertIn("超过 5 分钟未同步", page.text_content("#outdated"))
        self.assertEqual(page.text_content("#liveCount"), "6")  # last observation is kept, not cleared


if __name__ == "__main__":
    unittest.main()
