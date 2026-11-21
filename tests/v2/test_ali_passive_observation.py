"""Exercise the real route policy and response listener with offline Playwright events."""

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

from conftest import ali_target
from platforms.ali_live.live_monitor import AliLiveMonitor


ENTRY = "https://h5.m.taobao.com/taolive/video.html?userId=1234567"
DETAIL = "https://h5api.m.taobao.com/h5/mtop.mediaplatform.live.livedetail/4.0/?token=private-value"
TMALL = DETAIL.replace("h5api.m.taobao.com", "h5api.m.tmall.com")


def observe(make_settings, events):
    page = Mock()
    page.main_frame = SimpleNamespace(parent_frame=None, url=ENTRY)
    page.url = ENTRY
    page.locator.return_value.inner_text = AsyncMock(return_value="")
    page.close = AsyncMock()
    page.route = AsyncMock()

    async def goto(*args, **kwargs):
        handle_route = page.route.await_args.args[1]
        respond = page.on.call_args.args[1]
        for url, resource_type, status, body in events:
            request = SimpleNamespace(url=url, method="GET", resource_type=resource_type, headers={},
                                      frame=page.main_frame, post_data=None,
                                      is_navigation_request=lambda: resource_type == "document")
            route = SimpleNamespace(request=request, fallback=AsyncMock(), abort=AsyncMock())
            await handle_route(route)
            if status is not None:
                assert route.fallback.await_count == 1
                respond(SimpleNamespace(url=url, request=request, status=status, text=AsyncMock(return_value=body)))
    page.goto = AsyncMock(side_effect=goto)
    context = SimpleNamespace(new_page=AsyncMock(return_value=page))
    session = SimpleNamespace(context=AsyncMock(return_value=context), mode=lambda group: "guest")
    settings = make_settings([ali_target("tmall-room", 1)])
    target = settings.targets[0]
    resolved = {"room_url": ENTRY, "code": "OK", "source": "static",
                "reason": "anchor_entry", "discovery_mode": "anchor_entry"}
    ctx = SimpleNamespace(browser=None, settings=settings, budget=0)
    return asyncio.run(AliLiveMonitor(session).observe_room(target, resolved, ctx))


def test_counts_requests_responses_and_parsed_objects_separately(make_settings):
    room = observe(make_settings, [
        (ENTRY, "document", 200, ""),
        (TMALL, "xhr", 200, '{"ret": ["SUCCESS"]}'),
        (DETAIL, "media", None, None),     # denied before network
        (DETAIL, "fetch", None, None),     # allowed without an observed response
        (DETAIL, "fetch", 200, "not json"),
        (DETAIL, "fetch", 200, "[]"),      # valid JSON, but not an object
        (DETAIL, "fetch", 200, 'cb({"ret":["FAIL_SYS_USER_VALIDATE::private-value"]})'),
        ("https://example.test" + DETAIL[DETAIL.index("/h5/"):], "fetch", 200, "{}"),
    ])
    evidence = room["diagnostics"]["passive_observation"]
    assert evidence == {
        "navigation_attempted": True,
        "mtop": {"requests_allowed": 5, "requests_blocked": 1, "responses": 4},
        "livedetail_v4": {"requests_allowed": 4, "requests_blocked": 1, "responses": 3,
                          "json_objects": 1, "read_or_parse_errors": 1},
    }
    assert (room["code"], room["reason"]) == ("CAPTCHA_X5SEC", "api_access_limit")
    assert "private-value" not in json.dumps(room)


def test_http_gate_has_a_response_but_no_parsed_body(make_settings):
    room = observe(make_settings, [(DETAIL, "fetch", 403, '{"ret":["SUCCESS"]}')])
    evidence = room["diagnostics"]["passive_observation"]["livedetail_v4"]
    assert evidence == {"requests_allowed": 1, "requests_blocked": 0, "responses": 1,
                        "json_objects": 0, "read_or_parse_errors": 0}
    assert (room["code"], room["reason"]) == ("CAPTCHA_X5SEC", "http_403")


def test_public_fields_use_matching_session_and_expose_only_bounded_shape(make_settings):
    live_id = "456789"
    detail = {"ret": ["SUCCESS"], "data": {
        "accountId": "1234567", "broadCaster": {"accountId": "1234567", "accountName": "SYNTH", "roomNum": "1"},
        "roomNum": "1", "roomStatus": 1, "streamStatus": 1, "liveId": live_id,
        "onlineCount": "0", "viewCount": 9500, "private-dynamic-key": "secret-value"}}
    item_url = DETAIL.replace("live.livedetail/4.0", "video.livedetail.itemlist/1.0")
    items = {"ret": ["SUCCESS"], "data": {"liveId": live_id, "itemList": [{"itemTitle": "TCL 空调", "price": "1299.90"}]}}
    room = observe(make_settings, [(item_url, "fetch", 200, json.dumps(items)), (DETAIL, "fetch", 200, json.dumps(detail))])
    assert (room["online_count"], room["item_title"], room["item_price"]) == (0, "TCL 空调", 1299.9)
    evidence = room["diagnostics"]["business_evidence"]
    assert set(evidence["fields"].values()) == {"extracted"}
    shape = evidence["responses"]["livedetail"][0]
    assert "onlineCount" in shape["data_keys"] and shape["other_data_key_count"] == 1
    assert "private-dynamic-key" not in json.dumps(room) and "secret-value" not in json.dumps(room)

    items["data"]["liveId"] = "999999"
    del detail["data"]["onlineCount"]
    room = observe(make_settings, [(item_url, "fetch", 200, json.dumps(items)), (DETAIL, "fetch", 200, json.dumps(detail))])
    assert [room[k] for k in ("online_count", "item_title", "item_price")] == [None, None, None]
    assert room["diagnostics"]["business_evidence"]["fields"] == {
        "online_count": "field_missing_or_unsupported", "item_title": "session_not_verified", "item_price": "session_not_verified"}


def test_business_gate_explains_absent_fields(make_settings):
    room = observe(make_settings, [(DETAIL, "fetch", 200, '{"ret":["FAIL_SYS_USER_VALIDATE"],"data":{}}')])
    evidence = room["diagnostics"]["business_evidence"]
    assert set(evidence["fields"].values()) == {"api_access_limit"}
    assert evidence["responses"]["livedetail"][0]["top_keys"] == ["data", "ret"]
    assert evidence["responses"]["itemlist"] == []
