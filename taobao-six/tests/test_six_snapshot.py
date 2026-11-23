"""Six-shop same-tab snapshots: replay of the measured 2026-11-23 log, keep-last-valid rules,
dashboard delivery and the unchanged once-mode output. Offline: no browser, no network."""
import hashlib
import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import ExitStack, redirect_stderr, redirect_stdout
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import MagicMock, Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import monitor_local as m

FIXTURES = Path(__file__).with_name("fixtures")
TERMINAL = FIXTURES / "terminal_20261123_124144.txt"
TERMINAL_SHA256 = "c83d9022ec20f41a404257d9df390b3bdc12827c9e3dbe5e2494669df9dae9b5"
EXPECTED = json.loads((FIXTURES / "six_snapshot_20261123_124144.json").read_text(encoding="utf-8"))
OBSERVED = datetime(2026, 11, 23, 4, 41, 44, tzinfo=timezone.utc)  # 12:41:44 Beijing in the log
PROMPT = "请在这个 Chrome 窗口打开 TCL 主播卡片。如需登录，请手动完成。看到卡片后回到此终端按回车计数："
TARGETS = json.loads((m.ROOT / "verified_shops.json").read_text(encoding="utf-8"))
LABELS = {"开播": "live", "未开播": "offline", "未知": "unknown"}
GATE_REASON = "搜索页出现登录框。"  # evidence/earlier_login_gate_114647.txt


def records_from_log(text):
    """Rebuild ``read_verified_links`` records from the per-shop lines of a once-mode log."""
    records = {}
    for line in text.splitlines():
        parts = line.split("  ")
        if len(parts) >= 3 and parts[0] in TARGETS and parts[1] in LABELS:
            row = {"status": LABELS[parts[1]], "liveId": None, "liveUrl": None, "reason": ""}
            if row["status"] == "live" and parts[2].startswith("liveId=") and parts[2][7:].isdigit():
                row.update(liveId=parts[2][7:], liveUrl=parts[3], reason="进入按钮及同一控件的直播间链接")
            records[parts[0]] = row
    return records


MEASURED = records_from_log(TERMINAL.read_text(encoding="utf-8"))


def edited(**changes):
    records = json.loads(json.dumps(MEASURED))
    for name, row in changes.items():
        if row is None:
            records.pop(name)
        else:
            records[name] = row
    return records


def offline_all():
    return {name: {"status": "offline", "liveId": None, "liveUrl": None, "reason": "仅见主页按钮"} for name in TARGETS}


TV, GROUP, AC, FRIDGE, WASHER, HOME = TARGETS


class MeasuredEvidence(unittest.TestCase):
    def test_fixture_is_the_measured_log(self):
        self.assertEqual(hashlib.sha256(TERMINAL.read_bytes()).hexdigest(), TERMINAL_SHA256)
        self.assertEqual(list(MEASURED), TARGETS)
        self.assertTrue(all(row["status"] == "live" for row in MEASURED.values()))

    def test_measured_round_forms_the_six_shop_snapshot(self):
        snapshot = m.verified_snapshot(MEASURED, TARGETS, None, OBSERVED)
        self.assertEqual(snapshot, EXPECTED)
        self.assertEqual((snapshot["liveCount"], snapshot["totalCount"]), (6, 6))
        self.assertEqual(len({s["liveUrl"] for s in snapshot["shops"]}), 6)

    def test_once_output_is_byte_identical_to_the_measured_log(self):
        for sink in (None, m.SnapshotSink(TARGETS, None, "", path=Path(tempfile.mkdtemp()) / "six.json")):
            out = io.StringIO()
            page = Mock(url=m.SEARCH_URL)
            page.is_closed.return_value = False
            with ExitStack() as stack:
                stack.enter_context(redirect_stdout(out))
                stack.enter_context(redirect_stderr(io.StringIO()))
                stack.enter_context(patch("builtins.input", side_effect=lambda prompt="": (print(prompt, end=""), "")[1]))
                stack.enter_context(patch.object(m, "check_access"))
                stack.enter_context(patch.object(m, "read_verified_links", return_value=MEASURED))
                stack.enter_context(patch.object(m, "utc_now", return_value=OBSERVED))
                screen = stack.enter_context(patch.object(m, "debug_screen"))
                self.assertEqual(m.poll_verified(Mock(pages=[page]), TARGETS, True, sink), 0)
            self.assertEqual(out.getvalue(), TERMINAL.read_text(encoding="utf-8"))
            screen.assert_not_called()
            if sink is not None:
                self.assertEqual(sink.state, {"snapshot": EXPECTED, "pending": False})


class KeepLastValid(unittest.TestCase):
    """Every incomplete or unverifiable round leaves the last valid snapshot in place."""

    def setUp(self):
        self.state = {"snapshot": EXPECTED, "pending": False}
        self.now = OBSERVED + timedelta(minutes=2)

    def assertKept(self, records, *fragments):
        state, error = m.advance_verified(self.state, records, TARGETS, self.now)
        self.assertIs(state["snapshot"], EXPECTED)
        self.assertTrue(state["interrupted"])
        self.assertFalse(state["pending"])
        for fragment in fragments:
            self.assertIn(fragment, error)
        return state

    def test_missing_shop(self):
        self.assertKept(edited(TCL洗衣机官方旗舰店=None), WASHER, "本轮未取得卡片证据")
        self.assertKept(edited(TCL洗衣机官方旗舰店={"status": "unknown", "reason": "未找到可归属的店铺卡片"}),
                        "未找到可归属的店铺卡片")

    def test_login_prompt(self):
        gate = {name: {"status": "unknown", "liveId": None, "liveUrl": None, "reason": GATE_REASON} for name in TARGETS}
        self.assertKept(gate, GATE_REASON)
        self.assertKept({}, TV)  # check_access raised before any card was read

    def test_ambiguous_or_unverified_live_link(self):
        ambiguous = {"status": "live", "liveId": None, "liveUrl": None, "reason": "进入按钮的地址无法唯一核对"}
        self.assertKept(edited(TCL冰箱旗舰店=ambiguous), FRIDGE, "未核实")
        no_link = {"status": "live", "liveId": None, "liveUrl": None, "reason": "可见进入按钮，控件未提供可核对的公开链接"}
        self.assertKept(edited(TCL冰箱旗舰店=no_link), "未核实")
        mismatch = dict(MEASURED[FRIDGE], liveId="1127180169987657")
        self.assertKept(edited(TCL冰箱旗舰店=mismatch), "未核实")
        tracking = dict(MEASURED[FRIDGE], liveUrl=MEASURED[FRIDGE]["liveUrl"] + "&spm=x")
        self.assertKept(edited(TCL冰箱旗舰店=tracking), "未核实")

    def test_two_shops_on_one_room_and_extra_shop(self):
        self.assertKept(edited(TCL冰箱旗舰店=dict(MEASURED[WASHER])), "同一直播间")
        self.assertKept(edited(**{"TCL正品专卖店": dict(MEASURED[TV])}), "名单外")

    def test_pending_push_survives_a_failed_round(self):
        self.state["pending"] = True
        state, _ = m.advance_verified(self.state, {}, TARGETS, self.now, push=True)
        self.assertEqual((state["snapshot"], state["pending"]), (EXPECTED, True))


class AdvanceRules(unittest.TestCase):
    def test_all_six_explicitly_offline_is_a_valid_zero(self):
        state, error = m.advance_verified({"snapshot": EXPECTED, "pending": False}, offline_all(), TARGETS,
                                          OBSERVED + timedelta(minutes=2), push=True)
        self.assertIsNone(error)
        self.assertEqual((state["snapshot"]["liveCount"], state["pending"]), (0, True))
        self.assertTrue(all(s["liveUrl"] is None and s["startTime"] is None for s in state["snapshot"]["shops"]))

    def test_continuity_room_change_and_gap(self):
        later = OBSERVED + timedelta(minutes=2)
        changed = edited(TCL空调官方旗舰店=dict(MEASURED[AC], liveId="9000000000001",
                                         liveUrl="https://tbzb.taobao.com/live?liveId=9000000000001"))
        state, _ = m.advance_verified({"snapshot": EXPECTED, "pending": False}, changed, TARGETS, later)
        starts = {s["name"]: s["startTime"] for s in state["snapshot"]["shops"]}
        self.assertEqual(starts[TV], EXPECTED["updatedAt"])          # same room: observation start kept
        self.assertEqual(starts[AC], m.iso(later))                    # new liveId: new session
        gap, _ = m.advance_verified({"snapshot": EXPECTED, "pending": False}, MEASURED, TARGETS,
                                    OBSERVED + timedelta(minutes=6))
        self.assertTrue(all(s["startTime"] == m.iso(OBSERVED + timedelta(minutes=6)) for s in gap["snapshot"]["shops"]))

    def test_good_round_after_an_interruption_restarts_observation(self):
        failed, _ = m.advance_verified({"snapshot": EXPECTED, "pending": False}, {}, TARGETS, OBSERVED + timedelta(minutes=1))
        state, error = m.advance_verified(failed, MEASURED, TARGETS, OBSERVED + timedelta(minutes=2))
        self.assertIsNone(error)
        self.assertNotIn("interrupted", state)
        self.assertTrue(all(s["startTime"] == m.iso(OBSERVED + timedelta(minutes=2)) for s in state["snapshot"]["shops"]))

    def test_clock_not_after_last_snapshot_keeps_it(self):
        state, error = m.advance_verified({"snapshot": EXPECTED, "pending": False}, MEASURED, TARGETS, OBSERVED)
        self.assertIs(state["snapshot"], EXPECTED)
        self.assertIn("时钟", error)


class Delivery(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.path = Path(self.dir.name) / "six-latest.json"
        self.err = io.StringIO()

    def sink(self, url=None):
        return m.SnapshotSink(TARGETS, url, "token", path=self.path)

    def test_local_sink_writes_state_and_never_pushes(self):
        with patch.object(m, "push_snapshot") as push, redirect_stderr(self.err):
            sink = self.sink()
            self.assertTrue(sink.record(MEASURED, OBSERVED))
            self.assertTrue(sink.record({}, OBSERVED + timedelta(minutes=2)))
        push.assert_not_called()
        saved = m.read_state(self.path)
        self.assertEqual((saved["snapshot"], saved["interrupted"]), (EXPECTED, True))
        self.assertIn("看板快照未推进，保留上次有效结果", self.err.getvalue())

    def test_push_failure_retries_the_last_valid_snapshot_on_the_next_round(self):
        with patch.object(m, "push_snapshot", side_effect=TimeoutError) as push, redirect_stderr(self.err):
            self.assertFalse(self.sink("url").record(MEASURED, OBSERVED))
        self.assertTrue(m.read_state(self.path)["pending"])
        with patch.object(m, "push_snapshot") as push, redirect_stderr(self.err):
            self.assertTrue(self.sink("url").record({}, OBSERVED + timedelta(minutes=2)))
        push.assert_called_once_with("url", "token", EXPECTED)
        saved = m.read_state(self.path)
        self.assertEqual((saved["snapshot"], saved["pending"]), (EXPECTED, False))

    def test_default_path_is_the_six_shop_state_file(self):
        with patch.object(m, "SIX_STATE", self.path), redirect_stderr(self.err):
            sink = m.SnapshotSink(TARGETS, None, "")
            self.assertTrue(sink.record(MEASURED, OBSERVED))
            self.assertEqual(m.SnapshotSink(TARGETS, None, "").state["snapshot"], EXPECTED)  # reloads the file

    def test_six_shop_state_is_separate_from_the_page_snapshot(self):
        self.assertNotEqual(m.SIX_STATE, m.STATE)
        self.assertNotEqual(m.SIX_STATE, m.STATE.with_name("local-only.json"))

    def test_loop_with_sink_reads_links_every_round(self):
        page = Mock(url=m.SEARCH_URL)
        page.is_closed.return_value = False
        sink = Mock()

        def close_after_round(_records):
            page.is_closed.return_value = True  # operator closes the tab after one round
            return True
        sink.record.side_effect = close_after_round
        with ExitStack() as stack:
            stack.enter_context(redirect_stdout(io.StringIO()))
            stack.enter_context(redirect_stderr(self.err))
            stack.enter_context(patch("builtins.input", return_value=""))
            stack.enter_context(patch.object(m, "check_access"))
            links = stack.enter_context(patch.object(m, "read_verified_links", return_value=MEASURED))
            plain = stack.enter_context(patch.object(m, "read_verified"))
            stack.enter_context(patch.object(m.time, "sleep"))
            m.poll_verified(Mock(pages=[page]), TARGETS, False, sink)
        plain.assert_not_called()
        self.assertEqual(links.call_count, 1)
        sink.record.assert_called_once_with(MEASURED)

    def test_once_returns_2_when_the_push_is_not_confirmed(self):
        page = Mock(url=m.SEARCH_URL)
        page.is_closed.return_value = False
        sink = Mock()
        sink.record.return_value = False
        with ExitStack() as stack:
            stack.enter_context(redirect_stdout(io.StringIO()))
            stack.enter_context(patch("builtins.input", return_value=""))
            stack.enter_context(patch.object(m, "check_access"))
            stack.enter_context(patch.object(m, "read_verified_links", return_value=MEASURED))
            self.assertEqual(m.poll_verified(Mock(pages=[page]), TARGETS, True, sink), 2)


class CommandLine(unittest.TestCase):
    ENV = {"CLOUDBASE_UPDATE_URL": "https://example.invalid/api/updateLiveStatus", "CLOUDBASE_API_TOKEN": "test-only"}

    def run_main(self, argv, env):
        with patch.dict(os.environ, env, clear=True), patch("sys.argv", ["monitor_local.py", *argv]), \
                patch.object(m, "PROFILE", MagicMock()), patch.object(m, "sync_playwright"), \
                patch.object(m, "read_state", return_value={"snapshot": None, "pending": False}), \
                patch.object(m, "poll_verified", return_value=0) as same:
            self.assertEqual(m.main(), 0)
        return same.call_args.args

    def test_default_same_tab_stays_local(self):
        args = self.run_main(["--same-tab", "--once", "--local-only"], self.ENV)
        self.assertEqual((len(args[1]), args[2], args[3]), (6, True, None))
        self.assertIsNone(self.run_main(["--same-tab", "--once"], self.ENV)[3])

    def test_push_needs_the_write_endpoint_and_feeds_a_sink(self):
        args = self.run_main(["--same-tab", "--once", "--push"], self.ENV)
        self.assertIsInstance(args[3], m.SnapshotSink)
        self.assertEqual((args[3].url.hostname, args[3].token, args[3].path), ("example.invalid", "test-only", m.SIX_STATE))
        for argv, env in ((["--same-tab", "--push"], {}), (["--same-tab", "--push", "--local-only"], self.ENV),
                          (["--push"], self.ENV)):
            with self.subTest(argv=argv), patch.dict(os.environ, env, clear=True), \
                    patch("sys.argv", ["monitor_local.py", *argv]), redirect_stderr(io.StringIO()), \
                    self.assertRaises(SystemExit):
                m.args_and_config()


if __name__ == "__main__":
    unittest.main()
