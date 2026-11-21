"""Port of tests/r334/tmall-classifier.test.mjs plus the V2 code mapping."""

import math

import pytest

from core.errors import Code
from platforms.ali_live.classifier import (classify_tmall, endpoint_evidence, is_access_limit, is_limit_url,
                                           is_live_detail_url, limit_url_kind, map_sample, parse_json_or_jsonp,
                                           pick_best, response_limit)

TARGET = {"account_id": "1234567", "display_name": "SYNTH", "room_number": "555666"}


def payload(**overrides):
    data = {"accountId": TARGET["account_id"], "roomNum": TARGET["room_number"], "roomStatus": 1, "streamStatus": 1,
            "liveId": "900000000001",
            "broadCaster": {"accountId": TARGET["account_id"], "accountName": TARGET["display_name"],
                            "roomNum": TARGET["room_number"]}}
    data.update(overrides)
    return {"ret": ["SUCCESS::调用成功"], "data": data}


def test_only_explicit_numeric_status_enums_prove_live_or_offline():
    for room, stream in [(1, 1), ("1", "1"), (1, "1"), ("1", 1), (1.0, 1)]:
        assert classify_tmall(payload(roomStatus=room, streamStatus=stream), TARGET)["state"] == "LIVE"
    for room in (0, 2, "0", "2"):
        for stream in (0, "0"):
            verdict = classify_tmall(payload(roomStatus=room, streamStatus=stream, liveId="0"), TARGET)
            assert verdict["state"] == "OFFLINE" and verdict["offlineEvidence"] is True


INVALID = [None, "", " ", "\t", False, True, [], [0], [1], {}, {"valueOf": 1}, "01", "1.0", " 1 ", "0x1", -1, 3,
           math.nan, math.inf]


@pytest.mark.parametrize("field", ["roomStatus", "streamStatus"])
@pytest.mark.parametrize("value", INVALID, ids=repr)
def test_missing_coerced_and_malformed_statuses_never_become_offline(field, value):
    verdict = classify_tmall(payload(**{"roomStatus": 0, "streamStatus": 0, "liveId": "0", field: value}), TARGET)
    assert verdict["state"] == "UNKNOWN" and verdict["reason"] == "UNRECOGNIZED_STATUS"
    assert map_sample(verdict)[0] is Code.SCHEMA_MISMATCH


def test_missing_field_is_not_offline():
    data = payload(roomStatus=0, liveId="0")
    del data["data"]["streamStatus"]
    assert classify_tmall(data, TARGET)["reason"] == "UNRECOGNIZED_STATUS"
    assert classify_tmall(payload(streamStatus=2), TARGET)["state"] == "UNKNOWN"
    assert classify_tmall(payload(streamStatus="2"), TARGET)["state"] == "UNKNOWN"


def test_identity_room_and_api_errors():
    assert classify_tmall(payload(broadCaster={"accountId": "999", "accountName": "SYNTH", "roomNum": "555666"}), TARGET)["reason"] == "IDENTITY_MISMATCH"
    assert classify_tmall(payload(broadCaster={"accountId": "1234567", "accountName": " S Y N T H ", "roomNum": "555666"}), TARGET)["state"] == "LIVE"
    assert classify_tmall(payload(roomNum="1", broadCaster={"accountId": "1234567", "accountName": "SYNTH", "roomNum": "1"}), TARGET)["reason"] == "ROOM_MISMATCH"
    assert classify_tmall(payload(roomNum="999"), TARGET)["reason"] == "CONFLICTING_ROOM_NUMBERS"
    assert classify_tmall({"ret": ["FAIL_SYS_USER_VALIDATE::x"]}, TARGET) == {"state": "UNKNOWN", "reason": "API_ERROR", "apiRet": ["FAIL_SYS_USER_VALIDATE"]}
    assert classify_tmall({"ret": ["SUCCESS"], "data": {}}, TARGET)["reason"] == "MISSING_BROADCASTER"  # {} is truthy in JS
    assert classify_tmall({"ret": ["SUCCESS"], "data": {"broadCaster": None}}, TARGET)["reason"] == "MISSING_BROADCASTER"
    assert classify_tmall(payload(accountId=None), TARGET)["reason"] == "AMBIGUOUS_STATUS"   # String(null) != id


def test_start_time_and_pick_best():
    live = classify_tmall(payload(startTime=1763600000000), TARGET)
    assert live["sourceStartTime"] == "2025-11-20T00:53:20.000Z"
    mismatch = {"state": "UNKNOWN", "reason": "IDENTITY_MISMATCH"}
    other = {"state": "UNKNOWN", "reason": "API_ERROR"}
    assert pick_best([other, mismatch, live]) is live
    assert pick_best([other, mismatch]) is mismatch
    assert pick_best([other]) is other and pick_best([]) is None


@pytest.mark.parametrize("url", [
    "https://login.taobao.com/member/login.jhtml", "https://login.m.taobao.com/login.htm",
    "https://login.m.tmall.com/login.htm", "https://LOGIN.M.TAOBAO.COM/login.htm",
    "https://login.m.taobao.com./login.htm", "https://sec.taobao.com/query.htm",
    "https://h5.m.taobao.com/punish", "https://h5.m.taobao.com/_____tmd_____/punish",
    "https://h5.m.taobao.com/captcha", "https://h5.m.taobao.com/x?x5secdata=abc",
])
def test_login_and_challenge_urls_stop_sampling(url):
    assert is_limit_url(url)


def test_limit_kinds():
    assert limit_url_kind("https://login.m.tmall.com/login.htm") == "login"
    assert limit_url_kind("https://h5.m.taobao.com/_____tmd_____/punish") == "challenge"


@pytest.mark.parametrize("url", [
    "https://h5.m.taobao.com/taolive/video.html?userId=1234567", "https://login.m.taobao.com.evil.example/login.htm",
    "https://fakelogin.m.taobao.com/login.htm", "https://sec.taobao.com.evil.example/",
    "https://evil.example/captcha?next=https://login.m.taobao.com/", "https://login.m.taobao.com@evil.example/",
    "ftp://login.m.taobao.com/", "not a url",
])
def test_ordinary_and_deceptive_urls_are_not_limits(url):
    assert not is_limit_url(url)


def test_network_helpers_and_jsonp():
    detail = "https://h5api.m.taobao.com/h5/mtop.mediaplatform.live.livedetail/4.0/?jsv=1"
    assert is_live_detail_url(detail) and not is_live_detail_url("https://h5api.m.taobao.com.evil/h5/x/1.0/")
    assert response_limit(detail, 403) == "HTTP_403" and response_limit("https://x.taobao.com/a.js", 403) is None
    assert response_limit("https://h5.m.taobao.com/", 429, navigation=True) == "HTTP_429"
    assert endpoint_evidence(detail, 200) == {"path": "/h5/mtop.mediaplatform.live.livedetail/4.0/", "http": 200}
    assert parse_json_or_jsonp('mtopjsonp1({"ret":["SUCCESS"]})') == {"ret": ["SUCCESS"]}
    with pytest.raises(ValueError):
        parse_json_or_jsonp("alert(1); cb({})")


def test_code_mapping():
    assert map_sample(classify_tmall(payload(), TARGET)) == (Code.OK, "live_detail_room_and_stream_on")
    assert map_sample(classify_tmall(payload(roomStatus=0, streamStatus=0, liveId=""), TARGET))[0] is Code.OFFLINE
    assert map_sample({"state": "UNKNOWN", "reason": "API_ERROR", "apiRet": ["RGV587_ERROR"]}) == (Code.CAPTCHA_X5SEC, "api_access_limit")
    assert map_sample({"state": "UNKNOWN", "reason": "API_ERROR", "apiRet": ["FAIL_SYS_SESSION_EXPIRED"]})[0] is Code.LOGIN_REQUIRED
    assert map_sample({"state": "UNKNOWN", "reason": "IDENTITY_MISMATCH"})[0] is Code.REDIRECTED
    assert map_sample(None) == (Code.NAV_TIMEOUT, "signal_not_observed_within_budget")
    assert is_access_limit({"apiRet": ["FAIL_SYS_TRAFFIC_LIMIT"]}) and not is_access_limit({"apiRet": ["FAIL_BIZ"]})
