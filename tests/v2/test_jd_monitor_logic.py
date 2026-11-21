"""Defect A: early return inside the room budget, and the legacy-result -> code mapping."""

import asyncio

import pytest

import single_room_probe as legacy
from core.errors import Code
from platforms.jd.live_monitor import gate_kind, map_jd_result, wait_for_signal

ROOM = "49019552"


def legacy_result(**overrides):
    result = legacy.initial_result(ROOM)
    result.update(page_gate_reason="ok", page_loaded=True)
    result.update(overrides)
    return result


def run_wait(signal_after=None, gate_after=None, budget=2.0, blocked_after=None):
    async def scenario():
        loop = asyncio.get_running_loop()
        start = loop.time()
        signal, state = asyncio.Event(), {"network_blocked": False}

        async def gate_check(page, room_id):
            elapsed = loop.time() - start
            reason = "gate_text_hit" if gate_after is not None and elapsed >= gate_after else "ok"
            if blocked_after is not None and elapsed >= blocked_after:
                state["network_blocked"] = True
            return {"page_gate_reason": reason}

        if signal_after is not None:
            loop.call_later(signal_after, signal.set)
        gated = await wait_for_signal(None, ROOM, signal, state, start + budget, gate_check)
        return gated, loop.time() - start

    return asyncio.run(scenario())


def test_returns_early_once_the_detail_signal_arrives():
    gated, elapsed = run_wait(signal_after=0.2, budget=5.0)
    assert not gated and elapsed < 1.5          # 0.2 s + grace, far below the 5 s budget


def test_stops_at_budget_without_a_signal():
    gated, elapsed = run_wait(budget=0.6)
    assert not gated and 0.55 <= elapsed < 1.2


def test_visible_gate_stops_immediately():
    gated, elapsed = run_wait(gate_after=0.0, budget=5.0)
    assert gated and elapsed < 0.3


def test_network_gate_stops_the_wait():
    gated, elapsed = run_wait(blocked_after=0.4, budget=5.0)
    assert not gated and elapsed < 1.5


def test_live_offline_replay_from_the_unchanged_legacy_rule():
    payload = {"code": "0", "subCode": 0, "data": {"liveId": ROOM, "status": 1, "onlineCount": 7}}

    class Request:
        url = "https://api.m.jd.com/api?functionId=getImmediatePlayToM"
        method = "GET"
        headers = {}

    for status, expected, code in ((1, "live", Code.OK), (2, "offline", Code.OFFLINE), (3, "replay", Code.OFFLINE)):
        payload["data"]["status"] = status
        result = legacy_result()
        legacy.final_evidence(result, [legacy.public_detail(Request(), payload, ROOM)], False)
        assert result["live_status"] == expected
        assert map_jd_result(result, None)[0] is code


@pytest.mark.parametrize("overrides,kind,expected", [
    ({"login_or_captcha_blocked": True, "page_gate_reason": "login_host"}, "login", (Code.LOGIN_REQUIRED, "login_wall")),
    ({"login_or_captcha_blocked": True}, "restricted", (Code.LOGIN_REQUIRED, "restricted_room")),
    ({"login_or_captcha_blocked": True}, "access", (Code.CAPTCHA_X5SEC, "http_access_restriction")),
    ({"login_or_captcha_blocked": True, "page_gate_reason": "gate_text_hit"}, "challenge", (Code.CAPTCHA_X5SEC, "challenge")),
    ({"page_gate_reason": "url_or_fragment_changed", "page_loaded": False}, None, (Code.REDIRECTED, "url_or_fragment_changed")),
    ({"reasons": ["conflicting_detail_states"], "room_id_matched": True}, None, (Code.SCHEMA_MISMATCH, "conflicting_detail_states")),
    ({"room_id_matched": True, "live_status": "unknown"}, None, (Code.SCHEMA_MISMATCH, "unrecognized_detail_status")),
    ({"diagnostics": {"target_room_mismatch_count": 1}}, None, (Code.REDIRECTED, "room_mismatch")),
    ({"diagnostics": {"target_schema_mismatch_count": 2}}, None, (Code.SCHEMA_MISMATCH, "detail_schema_mismatch")),
    ({"page_gate_reason": "empty_body", "page_loaded": False}, None, (Code.NAV_TIMEOUT, "empty_body")),
    ({"reasons": ["navigation_timeout_or_error"]}, None, (Code.NAV_TIMEOUT, "navigation_timeout_or_error")),
    ({}, None, (Code.NAV_TIMEOUT, "signal_not_observed_within_budget")),
    ({"room_id_matched": True, "live_status": "live", "page_loaded": False, "page_gate_reason": "empty_body"}, None,
     (Code.NAV_TIMEOUT, "empty_body")),   # matched detail on an unloaded page is never OK
])
def test_mapping_table(overrides, kind, expected):
    assert map_jd_result(legacy_result(**overrides), kind) == expected


def test_gate_kind_prefers_challenge_text_and_reads_login_text():
    assert gate_kind("gate_text_hit", "拖动滑块完成拼图", None, False) == "challenge"
    assert gate_kind("gate_text_hit", "账号密码登录", None, False) == "login"
    assert gate_kind("login_host", "", None, False) == "login"
    assert gate_kind("ok", "", 401, False) == "login" and gate_kind("ok", "", 429, False) == "access"
    assert gate_kind("ok", "", None, True) == "restricted" and gate_kind("ok", "", None, False) is None
