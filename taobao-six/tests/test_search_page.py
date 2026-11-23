"""Offline checks. Optional local Chrome DOM fixtures: TEST_CHROME=1 python -m unittest discover -s tests."""
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import search_page as sp


class SearchChecks(unittest.TestCase):
    def test_only_one_public_room_id(self):
        self.assertEqual(sp.room_url("https://tbzb.taobao.com/live?spm=abc&liveId=1234567"),
                         "https://tbzb.taobao.com/live?liveId=1234567")
        for invalid in ("http://tbzb.taobao.com/live?liveId=11111",
                        "https://tbzb.taobao.com.bad/live?liveId=11111",
                        "https://a@tbzb.taobao.com/live?liveId=11111",
                        "https://tbzb.taobao.com/live?liveId=11111&liveId=22222",
                        "https://tbzb.taobao.com/live?liveId=bad",
                        "https://tbzb.taobao.com/home?liveId=11111"):
            with self.subTest(invalid=invalid):
                self.assertIsNone(sp.room_url(invalid))

    def test_visible_login_frame_overrides_cards(self):
        page = Mock(url=sp.SEARCH_URL)
        login = Mock(url="https://login.taobao.com/login")
        page.frames = [page.main_frame, login]
        login.frame_element.return_value.is_visible.return_value = True
        with self.assertRaisesRegex(sp.ScanError, "登录框"):
            sp.check_access(page)

    def test_click_result_cannot_be_assigned_to_two_tabs(self):
        page = Mock()
        popup1, popup2 = Mock(), Mock()
        def click(**_kwargs):
            listener = page.on.call_args.args[1]
            listener(popup1)
            listener(popup2)
        target = Mock()
        target.click.side_effect = click
        for tab in [page, popup1, popup2]:
            tab.is_closed.return_value = False
        with self.assertRaisesRegex(sp.ScanError, "多个窗口"):
            sp.discover_destination(page, target)
        popup1.close.assert_called_once()
        popup2.close.assert_called_once()
        page.close.assert_not_called()

    def test_population_cannot_change_status_mid_scan(self):
        page = Mock()
        live = {"a": dict(name="a", isLive=True, liveUrl="https://tbzb.taobao.com/live?liveId=12345")}
        offline = {"a": dict(name="a", isLive=False, liveUrl=None)}
        with patch.object(sp, "check_access"), patch.object(sp, "read_visible", side_effect=[live, offline]), patch.object(sp, "scroll",return_value=True):
            with self.assertRaisesRegex(sp.ScanError, "发生变化"):
                sp.collect(page)


@unittest.skipUnless(os.environ.get("TEST_CHROME") == "1", "requires installed Google Chrome")
class LocalDOM(unittest.TestCase):
    def test_rendered_buttons_and_isolated_store_url(self):
        from playwright.sync_api import sync_playwright
        with sync_playwright() as pw:
            browser = pw.chromium.launch(channel="chrome")
            try:
                page = browser.new_page()
                page.route("**/*", lambda r: r.abort())
                page.set_content("""
                  <style>a,button { background: linear-gradient(110deg, #fc3838, #ff5722); }</style>
                  <article><h3>电视旗舰店</h3>
                    <a href="https://tbzb.taobao.com/live?liveId=12345"><span>进入</span></a>
                  </article><article><h3>冰箱旗舰店</h3><button>主页</button></article>
                  <article><h3>空调旗舰店</h3><button>进入</button>
                    <a href="https://tbzb.taobao.com/live?liveId=54321">另一场推荐</a>
                  </article>""")
                data = page.evaluate(sp.CARDS)
                self.assertEqual(data["unresolved"], 0)
                self.assertEqual(data["cards"][0]["hrefs"], ["https://tbzb.taobao.com/live?liveId=12345"])
                self.assertFalse(data["cards"][1]["isLive"])
                self.assertEqual(data["cards"][2]["hrefs"], [])
                handle = page.evaluate_handle(sp.CARDS, "空调旗舰店")
                self.assertEqual(handle.as_element().inner_text(), "进入")
                page.set_content('<article style="background:red"><h3>电视旗舰店</h3>'
                                 '<button style="background:blue;color:white">进入</button></article>')
                self.assertEqual(page.evaluate(sp.CARDS), {"cards": [], "unresolved": 1})
            finally:
                browser.close()


if __name__ == "__main__":
    unittest.main()
