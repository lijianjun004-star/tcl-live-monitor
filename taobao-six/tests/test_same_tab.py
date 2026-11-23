import io
import os
import unittest
from contextlib import ExitStack, redirect_stderr, redirect_stdout
from unittest.mock import MagicMock, Mock, patch

import monitor_local as monitor


class SameTabTests(unittest.TestCase):
    names = ["甲店", "乙店", "丙店"]

    def setUp(self):
        self.page = self.make_page(monitor.SEARCH_URL)
        self.context = Mock(pages=[self.page])
        self.log = io.StringIO()
        stack = ExitStack()
        self.addCleanup(stack.close)
        stack.enter_context(redirect_stdout(self.log))
        stack.enter_context(redirect_stderr(self.log))
        self.confirm = stack.enter_context(patch("builtins.input", return_value=""))
        self.check = stack.enter_context(patch.object(monitor, "check_access"))
        self.scan = stack.enter_context(patch.object(monitor, "read_verified"))
        self.links = stack.enter_context(patch.object(monitor, "read_verified_links"))
        self.screen = stack.enter_context(patch.object(monitor, "debug_screen"))

    @staticmethod
    def make_page(url):
        page = Mock(url=url)
        page.is_closed.return_value = False
        return page

    def test_manual_page_is_retained_and_partial_count_is_labelled(self):
        self.links.return_value = {
            "甲店": {"status": "live", "liveId": "12345", "liveUrl": "https://tbzb.taobao.com/live?liveId=12345"},
            "乙店": {"status": "unknown", "reason": "未找到卡片"},
            "丙店": {"status": "offline"},
        }
        self.assertEqual(monitor.poll_verified(self.context, self.names, True), 2)
        self.confirm.assert_called_once()
        self.links.assert_called_once_with(self.page, self.names)
        self.scan.assert_not_called()
        self.page.goto.assert_not_called()
        self.page.reload.assert_not_called()
        self.context.new_page.assert_not_called()
        self.assertIn("已确认开播 1 家，开播总数待核", self.log.getvalue())
        self.assertIn("开播店铺：甲店", self.log.getvalue())
        self.assertIn("状态未知：乙店", self.log.getvalue())
        self.assertIn("甲店  开播  liveId=12345  https://tbzb.taobao.com/live?liveId=12345", self.log.getvalue())
        self.assertIn("乙店  未知  liveId=未核实  未找到卡片", self.log.getvalue())
        self.assertIn("丙店  未开播  liveId=不适用", self.log.getvalue())

    def test_login_popup_can_be_the_actual_search_tab(self):
        original = self.make_page("about:blank")
        self.context.pages = [original]
        def finish_login(_):
            original.url = "https://login.taobao.com/"
            self.context.pages.append(self.page)
            return ""
        self.confirm.side_effect = finish_login
        self.links.return_value = {name: {"status": "offline"} for name in self.names}
        self.assertEqual(monitor.poll_verified(self.context, self.names, True), 0)
        self.links.assert_called_once_with(self.page, self.names)
        original.goto.assert_called_once_with(monitor.SEARCH_URL, wait_until="commit", timeout=60000)
        self.page.goto.assert_not_called()
        self.page.reload.assert_not_called()
        self.assertIn("开播总数 0 家", self.log.getvalue())

    def test_live_link_missing_returns_incomplete_while_preserving_status(self):
        def read_after_confirm(page, targets):
            self.confirm.assert_called_once()
            return {name: {"status": "live", "reason": "进入按钮未显示可核验链接"} for name in targets}
        self.links.side_effect = read_after_confirm
        self.assertEqual(monitor.poll_verified(self.context, self.names, True), 2)
        self.links.assert_called_once_with(self.page, self.names)
        self.assertIn("开播总数 3 家", self.log.getvalue())
        self.assertIn("甲店  开播  liveId=未核实", self.log.getvalue())

    def test_login_gate_yields_unknown_without_zero_or_reload(self):
        self.check.side_effect = monitor.ScanError("搜索页出现登录框。")
        self.assertEqual(monitor.poll_verified(self.context, self.names, True), 2)
        self.scan.assert_not_called()
        self.links.assert_not_called()
        self.page.reload.assert_not_called()
        self.assertIn("开播总数未知", self.log.getvalue())
        self.assertNotIn("开播总数 0 家", self.log.getvalue())

    def test_only_later_cycle_reloads_same_page(self):
        self.scan.return_value = dict.fromkeys(self.names, "live")
        def after_wait(_):
            if self.scan.call_count == 2:
                self.page.is_closed.return_value = True
        with patch.object(monitor.time, "sleep", side_effect=after_wait):
            monitor.poll_verified(self.context, self.names, False)
        self.page.reload.assert_called_once()
        self.assertEqual(self.scan.call_count, 2)
        self.assertTrue(all(call.args[0] is self.page for call in self.scan.call_args_list))
        self.confirm.assert_called_once()

    def test_cli_uses_headed_chrome_and_never_opens_cloud_write_path(self):
        with patch.dict(os.environ, {}, clear=True), patch("sys.argv", ["monitor_local.py", "--same-tab", "--once"]), \
                patch.object(monitor, "PROFILE", MagicMock()), patch.object(monitor, "sync_playwright") as pw, \
                patch.object(monitor, "poll_verified", return_value=0) as same, \
                patch.object(monitor, "sync_pending") as push, patch.object(monitor, "read_state") as state:
            self.assertEqual(monitor.main(), 0)
        launch = pw.return_value.__enter__.return_value.chromium.launch_persistent_context
        self.assertEqual(launch.call_args.kwargs["channel"], "chrome")
        self.assertIs(launch.call_args.kwargs["headless"], False)
        self.assertEqual(launch.call_count, 1)
        same.assert_called_once()
        self.assertEqual(len(same.call_args.args[1]), 6)
        state.assert_not_called()
        push.assert_not_called()


if __name__ == "__main__":
    unittest.main()
