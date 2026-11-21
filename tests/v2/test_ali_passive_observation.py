"""Exercise the real route policy and response listener with offline Playwright events."""

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from conftest import ali_target
from platforms.ali_live.live_monitor import AliLiveMonitor


ENTRY = "https://h5.m.taobao.com/taolive/video.html?userId=1234567"
DETAIL = "https://h5api.m.taobao.com/h5/mtop.mediaplatform.live.livedetail/4.0/?token=private-value"
TMALL = DETAIL.replace("h5api.m.taobao.com", "h5api.m.tmall.com")


def scripted_page(events, entry=ENTRY):
    page = Mock()
    page.main_frame = SimpleNamespace(parent_frame=None, url=entry)
    page.url = entry
    page.locator.return_value.inner_text = AsyncMock(return_value="")
    page.close = AsyncMock()
    page.route = AsyncMock()
    page.route_decisions = []

    async def goto(*args, **kwargs):
        handle_route = page.route.await_args.args[1]
        respond = page.on.call_args.args[1]
        for url, resource_type, status, body in events:
            request = SimpleNamespace(url=url, method="GET", resource_type=resource_type, headers={},
                                      frame=page.main_frame, post_data=None,
                                      is_navigation_request=lambda: resource_type == "document")
            route = SimpleNamespace(request=request, fallback=AsyncMock(), abort=AsyncMock())
            await handle_route(route)
            page.route_decisions.append((url, route.fallback.await_count, route.abort.await_count))
            if status is not None:
                assert route.fallback.await_count == 1
                respond(SimpleNamespace(url=url, request=request, status=status, text=AsyncMock(return_value=body)))
    page.goto = AsyncMock(side_effect=goto)
    return page


def observe(make_settings, events):
    context = SimpleNamespace(new_page=AsyncMock(return_value=scripted_page(events)))
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


ITEMLIST = DETAIL.replace("live.livedetail/4.0", "video.livedetail.itemlist/1.0")


def live_response(account, live_id):
    return DETAIL, "fetch", 200, json.dumps({"ret": ["SUCCESS"], "data": {
        "accountId": account, "broadCaster": {"accountId": account, "accountName": "SYNTH", "roomNum": "1"},
        "roomNum": "1", "roomStatus": "1", "streamStatus": "1", "liveId": live_id,
        "onlineCount": 19, "startTime": "1795219200000"}})


def observe_two_anchors(first_events, make_settings, ctx_factory, monkeypatch):
    second_events = [(ITEMLIST, "fetch", None, None), live_response("7654321", "3496655469226922")]
    settings = make_settings([ali_target("tmall-group", 1), ali_target("tmall-ac", 1, account="7654321")],
                             inter_room_delay_seconds=0, room_budget_seconds=5)
    ctx = ctx_factory(settings)
    pages, pairs = [], []
    for target, events in zip(settings.targets, [first_events, second_events]):
        url = f"https://h5.m.taobao.com/taolive/video.html?userId={target.account_id}"
        pages.append(scripted_page(events, entry=url))
        pairs.append((target, {"room_url": url, "code": "OK", "source": "static",
                               "reason": "anchor_entry", "discovery_mode": "anchor_entry"}))
    context = SimpleNamespace(new_page=AsyncMock(side_effect=pages))
    session = SimpleNamespace(context=AsyncMock(return_value=context), mode=lambda group: "guest")
    screenshot = AsyncMock()
    monkeypatch.setattr("platforms.ali_live.live_monitor.masked_thumbnail", screenshot)
    monkeypatch.setattr("platforms.ali_live.live_monitor.GRACE_SECONDS", 0)
    rooms = asyncio.run(AliLiveMonitor(session).monitor_all(pairs, ctx))
    return rooms, ctx, pages, screenshot


@pytest.mark.parametrize("item_first", [False, True])
@pytest.mark.parametrize(("http_status", "body", "reason"), [
    (200, '{"ret":["FAIL_SYS_NEED_LOGIN"],"data":{}}', "api_need_login"),
    (401, "", "http_401"), (403, "", "http_403"), (429, "", "http_429"),
])
def test_optional_item_gate_preserves_live_and_admits_next_anchor(
        make_settings, ctx_factory, monkeypatch, item_first, http_status, body, reason):
    # The first primary response in the G capture had no usable data. The second was
    # successful and identity-matched. An item's response can arrive on either side.
    first = (DETAIL, "fetch", 200, '{"ret":["FAIL_SYS_TOKEN_EMPTY"],"data":{}}')
    live = live_response("1234567", "4012164818800065")
    item = (ITEMLIST, "fetch", http_status, body)
    events = [first, item, live] if item_first else [first, live, item]
    rooms, ctx, pages, screenshot = observe_two_anchors(events, make_settings, ctx_factory, monkeypatch)
    group = rooms["tmall-group"]
    assert (group["code"], group["live_status"], group["live_id"]) == ("OK", "live", "4012164818800065")
    assert group["diagnostics"]["source_start_time"] == "2026-11-21T00:00:00.000Z"
    assert group["online_count"] == 19 and group["item_title"] is None and group["item_price"] is None
    assert group["diagnostics"]["business_evidence"]["fields"] == {
        "online_count": "extracted", "item_title": reason, "item_price": reason}
    assert group["thumbnail"] == "thumbs/tmall-group.jpg"
    screenshot.assert_any_await(pages[0], ctx.thumbnail_path(ctx.settings.targets[0]))
    assert ctx.breaker.open_groups() == []
    assert (rooms["tmall-ac"]["code"], rooms["tmall-ac"]["live_id"]) == ("OK", "3496655469226922")
    assert pages[0].goto.await_count == pages[1].goto.await_count == 1
    assert pages[1].route_decisions == [(ITEMLIST, 0, 1), (DETAIL, 1, 0)]


@pytest.mark.parametrize(("ret", "code"), [
    ("FAIL_SYS_USER_VALIDATE", "CAPTCHA_X5SEC"), ("FAIL_SYS_NEED_LOGIN", "LOGIN_REQUIRED")])
def test_primary_gate_without_verified_response_still_stops_group(
        make_settings, ctx_factory, monkeypatch, ret, code):
    events = [(DETAIL, "fetch", 200, json.dumps({"ret": [ret], "data": {}}))]
    rooms, ctx, pages, screenshot = observe_two_anchors(events, make_settings, ctx_factory, monkeypatch)
    assert rooms["tmall-group"]["code"] == code and rooms["tmall-group"]["live_status"] == "unknown"
    assert rooms["tmall-ac"]["code"] == "GROUP_CIRCUIT_OPEN"
    assert rooms["tmall-ac"]["diagnostics"]["network_requests"] == 0
    assert ctx.breaker.open_groups() == ["ali:group_1"]
    assert pages[0].goto.await_count == 1 and pages[1].goto.await_count == 0
    screenshot.assert_not_awaited()


def test_auxiliary_gate_alone_cannot_close_group(make_settings, ctx_factory, monkeypatch):
    # An HTTP 200 payload for a different account cannot establish this room's state.
    events = [live_response("9999999", "4012164818800065"),
              (ITEMLIST, "fetch", 200, '{"ret":["FAIL_SYS_NEED_LOGIN"],"data":{}}')]
    rooms, ctx, pages, screenshot = observe_two_anchors(events, make_settings, ctx_factory, monkeypatch)
    first = rooms["tmall-group"]
    assert first["live_status"] == "unknown" and first["live_id"] is None and first["thumbnail"] is None
    assert first["code"] not in ("OK", "LOGIN_REQUIRED", "CAPTCHA_X5SEC", "GROUP_CIRCUIT_OPEN")
    assert first["diagnostics"]["business_evidence"]["fields"]["item_price"] == "api_need_login"
    assert ctx.breaker.open_groups() == [] and rooms["tmall-ac"]["live_status"] == "live"
    assert pages[1].route_decisions == [(ITEMLIST, 0, 1), (DETAIL, 1, 0)]
