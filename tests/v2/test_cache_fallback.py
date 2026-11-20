"""Discovery failure degrades to the last valid room, never clears it, and isolates each room."""

import asyncio
import json
from dataclasses import replace

from conftest import jd_target
from core.cache import ResolvedCache
from core.errors import Code
from core.models import Resolution
from core.runtime import guarded
from v2_run import degrade

URL = "https://lives.jd.com/#/{}"


def short_link_target(make_settings):
    settings = make_settings([{"key": "clip", "platform": "jd", "mode": "direct", "display_name": "clip",
                               "short_link": "https://3.cn/abc-1", "short_link_role": "clip"}])
    return settings.targets[0]


def test_success_is_cached_and_failure_reuses_it(make_settings, tmp_path):
    target = short_link_target(make_settings)
    cache = ResolvedCache(tmp_path / "cache.json")
    ok = degrade(target, Resolution(Code.OK, "short_link_resolved", live_id="49019552", room_url=URL.format("49019552"),
                                    verification="resolved_link", networked=True), cache)
    assert ok["source"] == "fresh" and ok["code"] == "OK"
    cache.save()
    reloaded = ResolvedCache(tmp_path / "cache.json")
    failed = degrade(target, Resolution.failure(Code.NAV_TIMEOUT, "navigation_timeout"), reloaded)
    assert failed["code"] == "NAV_TIMEOUT" and failed["source"] == "cache"
    assert failed["live_id"] == "49019552" and failed["room_url"] == URL.format("49019552")
    assert failed["cache_age_seconds"] >= 0 and failed["audit"]["cache_stale"] is False
    # The failure must not have touched the stored entry.
    reloaded.save()
    assert json.loads((tmp_path / "cache.json").read_text())["entries"]["clip"]["live_id"] == "49019552"


def test_changed_target_never_reuses_another_identity(make_settings, tmp_path):
    target = short_link_target(make_settings)
    cache = ResolvedCache(tmp_path / "cache.json")
    cache.store(target, live_id="49019552", room_url=URL.format("49019552"), verification="resolved_link")
    moved = replace(target, short_link="https://3.cn/other-2")
    row = degrade(moved, Resolution.failure(Code.CAPTCHA_X5SEC, "challenge"), cache)
    assert row["source"] == "none" and row["room_url"] is None and row["live_id"] is None
    assert "clip" in cache.entries          # still kept for the old identity


def test_unverified_candidates_are_not_cached_by_discovery(make_settings, tmp_path):
    settings = make_settings([{"key": "sku", "platform": "jd", "mode": "sku_discover", "sku_id": "100012345678"}])
    cache = ResolvedCache(tmp_path / "cache.json")
    degrade(settings.targets[0], Resolution(Code.OK, "unique_live_candidate", live_id="49019552",
                                            room_url=URL.format("49019552"), verification="candidate_unverified",
                                            networked=True), cache)
    assert cache.entries == {}


def test_corrupt_cache_is_moved_aside_not_overwritten(tmp_path):
    path = tmp_path / "cache.json"
    path.write_text("{not json")
    cache = ResolvedCache(path)
    assert cache.load_problem == "cache_unreadable" and cache.entries == {}
    assert (tmp_path / "cache.json.corrupt").read_text() == "{not json"


def test_one_room_exception_or_timeout_is_isolated():
    async def boom():
        raise RuntimeError("page crashed")

    async def slow():
        await asyncio.sleep(5)

    async def fine():
        return "ok"

    def fallback(code, why):
        return (code, why)

    async def scenario():
        return await asyncio.gather(guarded(boom, 1, fallback), guarded(slow, 0.05, fallback), guarded(fine, 1, fallback))

    assert asyncio.run(scenario()) == [(Code.NAV_TIMEOUT, "runtime_exception"), (Code.NAV_TIMEOUT, "room_timeout"), "ok"]


def test_static_targets_are_never_degraded(make_settings, tmp_path):
    target = make_settings([jd_target("static", "12345678")]).targets[0]
    row = degrade(target, Resolution(Code.OK, "configured_live_id", live_id="12345678", room_url=URL.format("12345678"),
                                     verification="config"), ResolvedCache(tmp_path / "c.json"))
    assert row["source"] == "static" and row["cache_age_seconds"] is None
