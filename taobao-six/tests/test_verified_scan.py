"""Regression checks for a named roster read from an existing tab."""
import os
import sys
import unittest
from pathlib import Path
from contextlib import ExitStack
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import verified_scan as vs


class VerifiedScanChecks(unittest.TestCase):
    targets = ["TCL电视官方旗舰店", "TCL空调官方旗舰店", "TCL智能家居旗舰"]

    def setUp(self):
        self.page = Mock()
        self.frame = Mock()
        patches = ExitStack()
        self.addCleanup(patches.close)
        patches.enter_context(patch.object(vs, "frames", return_value=[self.frame]))
        self.access = patches.enter_context(patch.object(vs, "check_access"))
        self.scroll = patches.enter_context(patch.object(vs, "scroll", return_value=False))

    def program(self, *samples):
        remaining = iter(samples)
        previous = []
        def evaluate(script, argument):
            nonlocal previous
            if script == vs.SCROLL:
                self.assertIs(argument, True)
                return False
            self.assertEqual(script, vs.CARDS)
            self.assertEqual(argument, self.targets)
            previous = next(remaining, previous)
            return [{"name": name, "status": status} for name, status in previous]
        self.frame.evaluate.side_effect = evaluate

    def test_sparse_virtualized_list_and_missing_member(self):
        tv, ac, home = self.targets
        self.program([(ac, "offline")], [(tv, "live")], [(tv, "live")])
        self.assertEqual(vs.read_verified(self.page, self.targets),
                         {tv: "live", ac: "offline", home: "unknown"})
        self.page.goto.assert_not_called()
        self.page.reload.assert_not_called()

    def test_conflict_and_identical_duplicate_are_unknown(self):
        tv, ac, home = self.targets
        self.program([(tv, "live"), (ac, "offline"), (ac, "offline")],
                     [(tv, "offline"), (home, "live")])
        self.assertEqual(vs.read_verified(self.page, self.targets),
                         {tv: "unknown", ac: "unknown", home: "live"})

    def test_only_one_same_control_url_is_trusted(self):
        tv, ac, home = self.targets
        url = "https://tbzb.taobao.com/live?liveId=123456"
        self.frame.evaluate.return_value = [
            {"name": tv, "status": "live", "hrefs": [url + "&spm=discard", url]},
            {"name": ac, "status": "live", "hrefs": [url], "unverifiedHref": True},
            {"name": home, "status": "offline", "hrefs": [url]},
        ]
        rows = vs.read_verified_links(self.page, self.targets)
        self.assertEqual((rows[tv]["liveId"], rows[tv]["liveUrl"]), ("123456", url))
        self.assertIsNone(rows[ac]["liveId"])
        self.assertEqual(rows[ac]["status"], "live")
        self.assertIsNone(rows[home]["liveUrl"])
        self.page.goto.assert_not_called()
        self.page.reload.assert_not_called()
        self.page.click.assert_not_called()

    def test_change_of_room_link_and_js_only_controls(self):
        tv, ac, home = self.targets
        ids = iter(["123456", "654321"])
        def evaluate(script, _argument):
            if script == vs.SCROLL:
                return False
            return [{"name": tv, "status": "live", "hrefs": [
                "https://tbzb.taobao.com/live?liveId=" + next(ids, "654321")]},
                    {"name": ac, "status": "live"}]
        self.frame.evaluate.side_effect = evaluate
        rows = vs.read_verified_links(self.page, self.targets)
        self.assertIsNone(rows[tv]["liveUrl"])
        self.assertEqual(rows[tv]["status"], "live")
        self.assertIsNone(rows[ac]["liveUrl"])
        self.assertIn("未提供", rows[ac]["reason"])
        self.assertEqual(rows[home]["status"], "unknown")

    def test_gate_invalidates_earlier_evidence(self):
        self.program([(self.targets[0], "live")])
        self.access.side_effect = [None, vs.ScanError("验证")]
        self.assertEqual(vs.read_verified(self.page, self.targets), dict.fromkeys(self.targets, "unknown"))

    def test_pending_can_hydrate_but_duplicate_is_ambiguous(self):
        tv, ac, _ = self.targets
        self.frame.evaluate.return_value = [
            {"name": tv, "status": "unknown", "pending": True},
            {"name": ac, "status": "unknown", "pending": True},
            {"name": ac, "status": "live"},
        ]
        self.assertEqual(vs._sample(self.page, self.targets), {ac: "unknown"})
        self.frame.evaluate.return_value = [{"name": tv, "status": "live"}]
        self.assertEqual(vs._sample(self.page, self.targets), {tv: "live"})

    def test_browser_error_discards_partial_snapshot(self):
        self.program([(self.targets[0], "live")])
        self.scroll.side_effect = vs.Error("frame detached")
        self.assertEqual(vs.read_verified(self.page, self.targets), dict.fromkeys(self.targets, "unknown"))


@unittest.skipUnless(os.environ.get("TEST_CHROME") == "1", "requires installed Google Chrome")
class VerifiedDOMChecks(unittest.TestCase):
    def test_author_identity_and_visible_controls(self):
        from playwright.sync_api import sync_playwright
        names = ["电视旗舰店", "推荐旗舰店", "冰箱旗舰店", "空调旗舰店", "集团旗舰店"]
        with sync_playwright() as pw:
            browser = pw.chromium.launch(channel="chrome")
            try:
                page = browser.new_page()
                page.route("**/*", lambda route: route.abort())
                page.set_content("""
                <article><h3>电视旗舰店</h3><button>进入</button><button>主页</button></article>
                <article><span>其他主播</span><p>推荐旗舰店</p><button>进入</button></article>
                <article><h3>冰箱旗舰店</h3><button disabled>进入</button><button>主页</button></article>
                <article><h3>空调旗舰店</h3><button>主页</button></article>
                <article><h3>集团旗舰店</h3><a>进入</a></article>
                """)
                sample = vs._sample(page, names)
                self.assertEqual(sample, {names[0]: "live", names[2]: "unknown",
                                          names[3]: "offline", names[4]: "unknown"})
            finally:
                browser.close()


if __name__ == "__main__":
    unittest.main()
