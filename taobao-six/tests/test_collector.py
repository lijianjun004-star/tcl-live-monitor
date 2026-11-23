import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

import monitor_local as m


class CollectorTests(unittest.TestCase):
    def setUp(self):
        self.t = datetime(2026, 11, 23, tzinfo=timezone.utc)
        self.names = {"TCL A", "TCL B"}
        self.rows = [dict(name="TCL A", isLive=True, liveUrl="https://tbzb.taobao.com/live?liveId=123456"),
                     dict(name="TCL B", isLive=False, liveUrl=None)]
        self.first = m.make_snapshot(self.rows, self.names, None, self.t)

    def test_duration_restart_and_new_session(self):
        now = self.t + timedelta(minutes=2)
        follow = m.make_snapshot(self.rows, self.names, self.first, now)
        self.assertEqual(follow["shops"][0]["startTime"], self.first["updatedAt"])
        self.assertEqual(m.make_snapshot(self.rows, self.names, follow, now + timedelta(minutes=6))["shops"][0]["startTime"], m.iso(now + timedelta(minutes=6)))
        self.assertEqual(m.make_snapshot(self.rows, self.names, self.first, now, True)["shops"][0]["startTime"], m.iso(now))
        new_room = [{**self.rows[0], "liveUrl":"https://tbzb.taobao.com/live?liveId=666666"}, self.rows[1]]
        self.assertEqual(m.make_snapshot(new_room, self.names, self.first, now)["shops"][0]["startTime"], m.iso(now))

    def test_offline_and_missing_differ(self):
        with self.assertRaises(m.ScanError):
            m.make_snapshot(self.rows[1:], self.names, self.first, self.t + timedelta(minutes=2))
        all_offline = [dict(name=n, isLive=False, liveUrl=None) for n in self.names]
        snap = m.make_snapshot(all_offline, self.names, self.first, self.t + timedelta(minutes=2))
        self.assertEqual(snap["liveCount"], 0)
        self.assertTrue(all(s["startTime"] is None for s in snap["shops"]))

    def test_pending_recovery_preserves_observation_timestamp(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "latest.json"
            state = {"snapshot":self.first, "pending":True}
            m.write_state(state,path)
            with patch.object(m, "push_snapshot", side_effect=TimeoutError):
                self.assertFalse(m.sync_pending(state,"url","token",path))
            retry = m.read_state(path)
            self.assertTrue(retry["pending"])
            with patch.object(m, "push_snapshot") as push:
                self.assertTrue(m.sync_pending(retry,"url","token",path))
                push.assert_called_once_with("url","token",self.first)
            self.assertFalse(m.read_state(path)["pending"])


if __name__ == "__main__":
    unittest.main()
