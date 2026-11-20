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
