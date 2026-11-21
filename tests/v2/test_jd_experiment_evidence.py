"""Offline observations exercise input attribution, minimised diagnostics and status admission."""

import json

import pytest

from experiments.jd_cookie_live.evidence import classify_candidate, inspect_page

ROOM = "87654321"
SHOP = "721631"
SHOP_URL = "https://shop.m.jd.com/?shopId=" + SHOP
API = "https://api.m.jd.com/api?functionId="
ROOM_URL = "https://lives.jd.com/#/" + ROOM


def shop(**changes):
    return {"final_url": SHOP_URL, "http_status": 200, "visible_text": "店铺首页", **changes}


def detail(status=1, **changes):
    return {"page_url": ROOM_URL, "url": API + "getImmediatePlayToM", "http_status": 200,
            "detect_ms": 40, "payload": {"code": 0, "subCode": "0", "data": {"liveId": ROOM, "status": status}},
            **changes}


def test_only_explicit_live_fields_and_canonical_room_routes_are_candidates():
    fixture = shop(dom_hrefs=[ROOM_URL, "https://shop.m.jd.com/?shopId=12345678",
                              "https://lives.jd.com.attacker.invalid/#/87654322"],
                   dom_live_ids=[SHOP, True, "0000123", "12", "9" * 19],
                   payloads=[{"data": {"live": {"liveId": "87654323", "liveRoomUrl": ROOM_URL},
                                       "shopId": 12345678, "sku": 12345679},
                              "account": {"liveId": "87654324"}, "notes": ROOM_URL, "liveId": "100133134399"}])
    result = inspect_page(fixture, SHOP)
    assert result["candidate_live_ids"] == [ROOM, "87654323"]
    assert result["live_entry_signals"] == ["dom_room_link", "public_live_id_field", "public_room_link"]
    assert result["login_state_signal"] == "target_page_observed"


@pytest.mark.parametrize("final_url", ["", "https://shop.m.jd.com/?shopId=721632",
                                       SHOP_URL + "&shopId=721632", "https://else.invalid/?shopId=721631"])
def test_unattributed_pages_cannot_supply_candidates(final_url):
    result = inspect_page(shop(final_url=final_url, dom_hrefs=[ROOM_URL]), SHOP)
    assert not result["target_identity_matched"] and not result["page_observed"] and not result["candidate_live_ids"]


@pytest.mark.parametrize("changes", [{"http_status": None}, {"http_status": 503}, {"visible_text": ""}])
def test_missing_document_proof_cannot_be_treated_as_empty_entry(changes):
    assert not inspect_page(shop(**changes), SHOP)["page_observed"]


def test_repeated_auxiliary_http_failures_are_recorded_and_names_redacted():
    sample = {"url": API + "pc_recommend&token=opaque-private", "http_status": 403,
              "payload": {"liveId": ROOM, "nickname": "private-user"}}
    fake = {"url": API + "opaque-private", "http_status": 503}
    result = inspect_page(shop(responses=[sample, sample, fake]), SHOP)
    assert result["observed_function_ids"] == ["pc_recommend"]
    assert result["http_error_samples"] == [
        {"function_id": name, "http_status": status, "host": "api.m.jd.com"}
        for name, status in (("pc_recommend", 403), ("pc_recommend", 403), (None, 503))]
    assert result["gate"] is None and not result["candidate_live_ids"]
    assert "private" not in json.dumps(result)


@pytest.mark.parametrize("markers,expected",
                         [({"redirect_chain": ["https://plogin.m.jd.com/"]}, "LOGIN_REQUIRED"),
                          ({"visible_text": "请完成安全验证"}, "CAPTCHA_X5SEC"),
                          ({"visible_text": "访问受限"}, "ACCESS_RESTRICTED"),
                          ({"http_status": 403}, "ACCESS_RESTRICTED")])
def test_challenges_login_and_http_denials_are_distinct(markers, expected):
    result = inspect_page(shop(dom_hrefs=[ROOM_URL], **markers), SHOP)
    assert result["gate"] == expected and result["candidate_live_ids"] == []


@pytest.mark.parametrize("raw,state,code", [(1, "live", "OK"), (2, "offline", "OFFLINE"),
                                            (3, "replay", "OFFLINE"), (9, "unknown", "SCHEMA_MISMATCH")])
def test_exact_room_and_public_detail_decide_status(raw, state, code):
    result = classify_candidate(ROOM, detail(raw))
    assert (result["live_status"], result["code"], result["room_id_matched"]) == (state, code, True)
    assert result["elapsed_ms"] == 40
    assert result["detect_ms"] == (None if state == "unknown" else 40)


@pytest.mark.parametrize("changes", [{"page_url": ROOM_URL + "9"}, {"url": API + "liveDetailToM"},
                                     {"payload": {"code": 0, "subCode": "0",
                                                  "data": {"liveId": "87654322", "status": 1}}},
                                     {"response_url": API + "other"}, {"payload": {"data": {"status": 1}}}])
def test_missing_or_contradictory_identity_never_proves_live(changes):
    result = classify_candidate(ROOM, detail(**changes))
    assert result["live_status"] == "unknown" and not result["room_id_matched"] and result["detect_ms"] is None


def test_failed_detail_keeps_each_http_error_without_counting_it_as_offline():
    result = classify_candidate(ROOM, detail(http_status=503))
    assert result["observed_function_ids"] == ["getImmediatePlayToM"]
    assert result["http_error_samples"] == [
        {"function_id": "getImmediatePlayToM", "http_status": 503, "host": "api.m.jd.com"}]
    assert result["elapsed_ms"] == 40 and result["detect_ms"] is None
    assert result["live_status"] == "unknown" and result["gate"] is None


def test_verified_envelope_restricting_room_has_priority_over_status():
    restricted = detail()
    restricted["payload"]["data"].update(secret=1, status=1)
    result = classify_candidate(ROOM, restricted)
    assert result["gate"] == "ACCESS_RESTRICTED" and result["live_status"] == "unknown"


def test_invalid_room_input_is_never_reflected_to_report():
    assert classify_candidate("private-sentinel", detail())["live_id"] is None
