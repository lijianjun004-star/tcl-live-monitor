"""Regression tests for the independent review findings (state advance, in-flight abort, leaks)."""

import asyncio
import json

from conftest import EXAMPLE, jd_target
from core.cache import ResolvedCache
from core.errors import Code
from core.models import resolved_room, snapshot_room
from core.runtime import bounded_map
from platforms.ali_live.discovery import route_shape
from platforms.jd.live_monitor import JdLiveMonitor
import v2_run


def test_bounded_map_aborts_queued_and_in_flight_items():
    async def worker(item):
        if item == "trip":
            await asyncio.sleep(0.05)
            return "TRIPPED"
        if item == "boom":
            raise RuntimeError("unexpected")
        await asyncio.sleep(2)
        return "finished"

    async def scenario():
        loop = asyncio.get_running_loop()
        start = loop.time()
        out = await bounded_map(["trip", "slow", "boom", "queued", "queued2"], 3, worker,
                                should_abort=lambda r: r == "TRIPPED",
                                aborted=lambda item, started: ("aborted", item, started),
                                failed=lambda item: ("failed", item))
        return out, loop.time() - start

    out, elapsed = asyncio.run(scenario())
    assert out[0] == "TRIPPED"
    assert out[1] == ("aborted", "slow", True)              # was mid-request
    assert out[2] == ("failed", "boom")                     # exception captured, nothing orphaned
    assert out[3][0] == "aborted" and out[4] == ("aborted", "queued2", False)
    assert elapsed < 1.0


class DelayedJd(JdLiveMonitor):
    def __init__(self):
        super().__init__()
        self.finished = []

    async def observe_room(self, target, resolved, ctx):
        if target.key == "trips":
            await asyncio.sleep(0.05)
            code = Code.CAPTCHA_X5SEC
        else:
            await asyncio.sleep(3)
            code = Code.OK
        self.finished.append(target.key)
        return snapshot_room(target, resolved, code=code, reason="scripted",
                             live_status="live" if code is Code.OK else None)


def test_jd_breaker_cancels_rooms_already_in_flight(make_settings, ctx_factory):
    targets = [jd_target("trips", "11111111"), jd_target("in-flight", "22222222"), jd_target("queued", "33333333")]
    settings = make_settings(targets, max_concurrency=2)
    ctx = ctx_factory(settings)
    pairs = [(t, resolved_room(t, code=Code.OK, reason="cfg", source="static", live_id=t.live_id,
                               room_url=f"https://lives.jd.com/#/{t.live_id}", resolved_at=None,
                               cache_age_seconds=None, verification="config", audit={})) for t in settings.targets]
    engine = DelayedJd()
    rooms = asyncio.run(engine.monitor_all(pairs, ctx))
    assert rooms["trips"]["code"] == "CAPTCHA_X5SEC"
    assert rooms["in-flight"]["reason"] == "aborted_after_group_trip"
    assert rooms["in-flight"]["diagnostics"] == {"aborted_in_flight": True}
    assert rooms["queued"]["reason"] == "group_circuit_open"
    assert engine.finished == ["trips"]


def test_ali_route_shape_never_keeps_a_short_link_code():
    shape = route_shape("https://m.tb.cn/h.AbCdEf?tk=SECRETTOKEN&sm=1")
    assert shape["host"] == "m.tb.cn" and "AbCdEf" not in json.dumps(shape) and "SECRETTOKEN" not in json.dumps(shape)
    assert shape["path"] == "/{segment}"
    assert route_shape("https://h5.m.taobao.com/taolive/video.html?userId=1234567")["path"] == "/taolive/video.html"


def test_cache_drops_entries_that_would_break_the_contract(tmp_path, make_settings):
    target = make_settings([jd_target("good", "12345678")]).targets[0]
    base = {"fingerprint": target.fingerprint(), "platform": "jd", "discovery_mode": "direct",
            "live_id": "12345678", "room_url": "https://lives.jd.com/#/12345678"}
    entries = {
        "good": {**base, "resolved_at": "2026-11-20T08:00:00+08:00", "verification": "resolved_link"},
        "bad-verification": {**base, "resolved_at": "2026-11-20T00:00:00+00:00", "verification": "x"},
        "bad-time": {**base, "resolved_at": "2026-11-20 00:00:00"},
        "mismatched-id": {**base, "live_id": "87654321", "resolved_at": "2026-11-20T00:00:00+00:00"},
        "too-long-id": {**base, "live_id": "1" * 20, "room_url": "https://lives.jd.com/#/" + "1" * 20,
                        "resolved_at": "2026-11-20T00:00:00+00:00"},
    }
    (tmp_path / "c.json").write_text(json.dumps({"schema_version": "2.0", "entries": entries}))
    cache = ResolvedCache(tmp_path / "c.json")
    assert list(cache.entries) == ["good"]
    assert cache.entries["good"]["resolved_at"] == "2026-11-20T00:00:00+00:00"


def _args(tmp_path, *extra):
    return v2_run.parse_args(["--targets", str(EXAMPLE), "--engine", "fake", "--state-dir", str(tmp_path / "state"),
                              "--out", str(tmp_path / "ev"), "--dashboard", str(tmp_path / "index.html"),
                              "--no-drive", *extra])


def test_failed_push_keeps_the_diff_base_so_events_come_back(tmp_path):
    results = iter([{"status": "transport_error", "error_type": "OSError"},
                    {"status": "sent", "kind": "wecom", "http": 200}])
    sent = []

    def fake_send(title, text, env, transport=None):
        sent.append(text)
        return next(results)

    original, v2_run.notifiers.send = v2_run.notifiers.send, fake_send
    try:
        env = {"WEBHOOK_URL": "https://qyapi.weixin.qq.com/x"}
        assert asyncio.run(v2_run.run(_args(tmp_path), env)) == 0
        summary = json.loads((tmp_path / "ev" / "run_summary.json").read_text())
        assert summary["state_snapshot_advanced"] is False
        assert not (tmp_path / "state" / "monitor_snapshot.json").exists()
        asyncio.run(v2_run.run(_args(tmp_path), env))
        assert len(sent) == 2 and sent[0].count("【新开播】") == sent[1].count("【新开播】") == 8
        assert json.loads((tmp_path / "ev" / "run_summary.json").read_text())["state_snapshot_advanced"] is True
    finally:
        v2_run.notifiers.send = original


def test_browser_start_failure_exits_4_with_a_summary(tmp_path, monkeypatch):
    import core.browser

    async def refuse(self):
        raise RuntimeError("Executable doesn't exist")

    monkeypatch.setattr(core.browser.BrowserFactory, "__aenter__", refuse)
    args = v2_run.parse_args(["--targets", str(EXAMPLE), "--engine", "live", "--state-dir", str(tmp_path / "s"),
                              "--out", str(tmp_path / "ev"), "--dashboard", str(tmp_path / "i.html"),
                              "--no-drive", "--no-notify"])
    assert asyncio.run(v2_run.run(args, {})) == 4
    summary = json.loads((tmp_path / "ev" / "run_summary.json").read_text())
    assert summary["verdict"] == "runtime_error" and summary["error_type"] == "RuntimeError"
    assert not (tmp_path / "ev" / "monitor_snapshot.json").exists()
