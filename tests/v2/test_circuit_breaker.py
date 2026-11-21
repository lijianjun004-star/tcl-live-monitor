"""Group breaker: one gate stops the rest of its group with zero requests; other groups continue."""

import asyncio

from conftest import ali_target, jd_target
from core.breaker import GroupCircuitBreaker
from core.errors import Code
from core.models import resolved_room, snapshot_room
from platforms.ali_live.cookie_pool import CookiePool
from platforms.ali_live.live_monitor import AliLiveMonitor
from platforms.ali_live.session import AliSession
from platforms.jd.live_monitor import JdLiveMonitor


def resolved_for(target, room_url):
    return resolved_room(target, code=Code.OK, reason="anchor_entry", source="static", live_id=None,
                         room_url=room_url, resolved_at="2026-11-20T00:00:00+00:00", cache_age_seconds=None,
                         verification="config", audit={})


class ScriptedAli(AliLiveMonitor):
    """Real scheduling and breaker logic; only the page visit is scripted."""

    def __init__(self, script):
        super().__init__(AliSession(CookiePool(), {}))
        self.script, self.visits = script, []

    async def observe_room(self, target, resolved, ctx):
        self.visits.append(target.key)
        code = self.script.get(target.key, Code.OK)
        status = "live" if code is Code.OK else "offline" if code is Code.OFFLINE else None
        return snapshot_room(target, resolved, code=code, reason="scripted", live_status=status)


def test_captcha_in_group_one_skips_its_later_rooms_without_requests(make_settings, ctx_factory):
    targets = [ali_target("g1-a", 1, account="1000001"), ali_target("g1-b", 1, account="1000002"),
               ali_target("g1-c", 1, "taobao", account="1000003"),
               ali_target("g2-a", 2, account="2000001"), ali_target("g2-b", 2, account="2000002")]
    settings = make_settings(targets, inter_room_delay_seconds=0)
    ctx = ctx_factory(settings)
    engine = ScriptedAli({"g1-a": Code.CAPTCHA_X5SEC})
    pairs = [(t, resolved_for(t, f"https://h5.m.taobao.com/taolive/video.html?userId={t.account_id}")) for t in settings.targets]
    rooms = asyncio.run(engine.monitor_all(pairs, ctx))
    assert rooms["g1-a"]["code"] == "CAPTCHA_X5SEC"
    assert rooms["g1-b"]["code"] == rooms["g1-c"]["code"] == "GROUP_CIRCUIT_OPEN"
    skipped = rooms["g1-b"]["diagnostics"]
    assert skipped["network_requests"] == 0
    assert set(skipped["business_evidence"]["fields"].values()) == {"group_circuit_open"}
    assert skipped["business_evidence"]["responses"] == {"livedetail": [], "itemlist": []}
    assert rooms["g2-a"]["code"] == rooms["g2-b"]["code"] == "OK"
    assert engine.visits.count("g1-a") == 1 and "g1-b" not in engine.visits and "g1-c" not in engine.visits
    assert ctx.breaker.open_groups() == ["ali:group_1"]
    assert ctx.breaker.report()["ali:group_1"]["tripped_by"] == "g1-a"


def test_login_redirect_trips_and_timeouts_do_not(make_settings, ctx_factory):
    targets = [ali_target("a", 1, account="1000001"), ali_target("b", 1, account="1000002"),
               ali_target("c", 2, account="2000001"), ali_target("d", 2, account="2000002")]
    settings = make_settings(targets, inter_room_delay_seconds=0)
    ctx = ctx_factory(settings)
    engine = ScriptedAli({"a": Code.NAV_TIMEOUT, "c": Code.LOGIN_REQUIRED})
    pairs = [(t, resolved_for(t, f"https://h5.m.taobao.com/taolive/video.html?userId={t.account_id}")) for t in settings.targets]
    rooms = asyncio.run(engine.monitor_all(pairs, ctx))
    assert rooms["b"]["code"] == "OK"                      # NAV_TIMEOUT never trips
    assert rooms["d"]["code"] == "GROUP_CIRCUIT_OPEN"      # LOGIN_REQUIRED does
    assert ctx.breaker.open_groups() == ["ali:group_2"]


def test_discovery_layer_trip_blocks_the_monitor_layer(make_settings, ctx_factory):
    settings = make_settings([ali_target("x", 3, account="3000001")], inter_room_delay_seconds=0)
    ctx = ctx_factory(settings)
    ctx.breaker.record("ali:group_3", Code.CAPTCHA_X5SEC, target_key="earlier", layer="discovery")
    engine = ScriptedAli({})
    target = settings.targets[0]
    rooms = asyncio.run(engine.monitor_all([(target, resolved_for(target, "https://h5.m.taobao.com/taolive/video.html?userId=3000001"))], ctx))
    assert rooms["x"]["code"] == "GROUP_CIRCUIT_OPEN" and engine.visits == []


class ScriptedJd(JdLiveMonitor):
    def __init__(self, script):
        super().__init__()
        self.script, self.visits = script, []

    async def observe_room(self, target, resolved, ctx):
        self.visits.append(target.key)
        code = self.script.get(target.key, Code.OK)
        return snapshot_room(target, resolved, code=code, reason="scripted",
                             live_status="live" if code is Code.OK else None)


def test_jd_canary_runs_first_and_its_challenge_stops_jd(make_settings, ctx_factory):
    targets = [jd_target("r1", "11111111"), jd_target("canary", "22222222", canary=True), jd_target("r2", "33333333")]
    settings = make_settings(targets)
    ctx = ctx_factory(settings)
    engine = ScriptedJd({"canary": Code.CAPTCHA_X5SEC})
    pairs = [(t, resolved_room(t, code=Code.OK, reason="cfg", source="static", live_id=t.live_id,
                               room_url=f"https://lives.jd.com/#/{t.live_id}", resolved_at=None,
                               cache_age_seconds=None, verification="config", audit={})) for t in settings.targets]
    rooms = asyncio.run(engine.monitor_all(pairs, ctx))
    assert engine.visits == ["canary"]
    assert rooms["r1"]["code"] == rooms["r2"]["code"] == "GROUP_CIRCUIT_OPEN"


def test_breaker_respects_protected_groups():
    breaker = GroupCircuitBreaker({"ali:group_1"})
    assert not breaker.record("jd:anonymous", Code.CAPTCHA_X5SEC, target_key="k", layer="monitor")
    assert breaker.record("ali:group_1", "LOGIN_REQUIRED", target_key="k", layer="monitor")
    assert not breaker.record("ali:group_1", "CAPTCHA_X5SEC", target_key="k2", layer="monitor")  # already open
    assert breaker.open_groups() == ["ali:group_1"]
