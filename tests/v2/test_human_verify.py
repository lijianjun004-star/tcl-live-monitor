"""Phone verification hand-off: local HTTP only, a fake tunnel and push, a scripted page."""

import asyncio
import json
import socket
import threading
import urllib.error
import urllib.request
from datetime import datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from conftest import ali_target
from core.human_verify import BEIJING, HumanVerifier
from platforms.ali_live.live_monitor import AliLiveMonitor
from test_ali_passive_observation import DETAIL, ENTRY, live_response, scripted_page

DAYTIME = lambda: datetime(2026, 11, 23, 10, 0, tzinfo=BEIJING)  # noqa: E731
CONNECT, CREATE = socket.socket.connect, socket.create_connection


@pytest.fixture(autouse=True)
def loopback_only(no_network, monkeypatch):
    """These tests talk to the helper's own local server. Anything beyond 127.0.0.1 still fails."""
    def connect(sock, address):
        if address[0] != "127.0.0.1":
            raise AssertionError("offline test suite attempted a network connection")
        return CONNECT(sock, address)

    def create(address, *args, **kwargs):
        if address[0] != "127.0.0.1":
            raise AssertionError("offline test suite attempted a network connection")
        return CREATE(address, *args, **kwargs)
    monkeypatch.setattr(socket.socket, "connect", connect)
    monkeypatch.setattr(socket, "create_connection", create)


class FakeCdp:
    def __init__(self, on_end=None):
        self.sent, self.on_end = [], on_end

    async def send(self, method, params):
        self.sent.append((method, params["type"], [(round(p["x"]), round(p["y"])) for p in params["touchPoints"]]))
        if params["type"] == "touchEnd" and self.on_end:
            self.on_end()


def fake_page(cdp):
    page = SimpleNamespace(viewport_size={"width": 390, "height": 844}, url=ENTRY)
    page.context = SimpleNamespace(new_cdp_session=AsyncMock(return_value=cdp))
    page.screenshot = AsyncMock(return_value=b"\xff\xd8jpeg")
    page.reload = AsyncMock()
    page.mouse = SimpleNamespace(move=AsyncMock(), down=AsyncMock(), up=AsyncMock())
    return page


def verifier(pushes, **extra):
    def push(url, title, body, link):
        pushes.append(link)
        return 200
    options = {"max_wait": 5, "settle_seconds": 0, "port": 0, "now": DAYTIME, "push": push,
               "start_tunnel": lambda binary, port: (SimpleNamespace(terminate=lambda: None), f"http://127.0.0.1:{port}")}
    options.update(extra)
    return HumanVerifier("https://api.day.app/key", **options)


def finger(link, path):
    """What the viewer page sends for one drag: down, moves, up (normalised coordinates)."""
    with urllib.request.urlopen(link, timeout=5) as page:
        assert "巡检人工验证" in page.read().decode()
    events = [{"t": "down", "x": path[0][0], "y": path[0][1]}]
    events += [{"t": "move", "x": x, "y": y} for x, y in path[1:]]
    events.append({"t": "up", "x": path[-1][0], "y": path[-1][1]})
    request = urllib.request.Request(link + "input", data=json.dumps(events).encode(), method="POST")
    with urllib.request.urlopen(request, timeout=5) as response:
        assert response.status == 204


def test_from_env_needs_switch_bark_and_tunnel_binary(tmp_path):
    binary = tmp_path / "cloudflared"
    binary.write_text("")
    base = {"HUMAN_VERIFY": "1", "WEBHOOK_URL": "https://api.day.app/key", "WEBHOOK_KIND": "bark",
            "HUMAN_VERIFY_TUNNEL": str(binary)}
    assert isinstance(HumanVerifier.from_env(base), HumanVerifier)
    assert HumanVerifier.from_env({**base, "WEBHOOK_KIND": ""}) is not None  # inferred from the Bark host
    for change in ({"HUMAN_VERIFY": "0"}, {"HUMAN_VERIFY": ""}, {"WEBHOOK_KIND": "feishu"},
                   {"WEBHOOK_URL": "http://api.day.app/key"}, {"HUMAN_VERIFY_TUNNEL": str(tmp_path / "missing")}):
        assert HumanVerifier.from_env({**base, **change}) is None


def test_a_phone_drag_arrives_as_one_ordered_touch_gesture_and_counts_as_solved():
    pushes, done = [], threading.Event()
    cdp = FakeCdp(on_end=done.set)
    page = fake_page(cdp)
    human = verifier(pushes)

    async def run():
        task = asyncio.create_task(human.verify(page, label="TCL 店", solved=done.is_set))
        while not pushes:
            await asyncio.sleep(0.02)
        await asyncio.to_thread(finger, pushes[0], [(0.1, 0.5), (0.4, 0.5), (0.9, 0.52)])
        result = await task
        await human.close()
        return result

    assert asyncio.run(run()) is True
    assert [(m, t) for m, t, _ in cdp.sent] == [("Input.dispatchTouchEvent", "touchStart"),
                                                ("Input.dispatchTouchEvent", "touchMove"),
                                                ("Input.dispatchTouchEvent", "touchMove"),
                                                ("Input.dispatchTouchEvent", "touchEnd")]
    assert cdp.sent[0][2] == [(39, 422)] and cdp.sent[2][2] == [(351, 439)] and cdp.sent[3][2] == []
    assert human.report() == {"sessions": 1, "solved": 1, "timeouts": 0, "push_failed": 0,
                              "input_events": 4, "tunnel": "ok"}
    assert len(pushes) == 1 and pushes[0].count("/") == 4  # http://host/<token>/


def test_wrong_or_expired_tokens_see_nothing():
    pushes, done = [], threading.Event()
    page = fake_page(FakeCdp(on_end=done.set))
    human = verifier(pushes)

    async def run():
        task = asyncio.create_task(human.verify(page, label="x", solved=done.is_set))
        while not pushes:
            await asyncio.sleep(0.02)
        base = pushes[0].rsplit("/", 2)[0]
        for path in ("/", "/frame.jpg", "/wrong-token/", "/wrong-token/frame.jpg"):
            try:
                await asyncio.to_thread(urllib.request.urlopen, base + path, None, 5)
                raise AssertionError("served " + path)
            except urllib.error.HTTPError as error:
                assert error.code == 404
        done.set()
        await task
        try:
            await asyncio.to_thread(urllib.request.urlopen, pushes[0], None, 5)
            raise AssertionError("expired token still served")
        except urllib.error.HTTPError as error:
            assert error.code == 404
        await human.close()

    asyncio.run(run())


def test_no_person_means_timeout_and_the_page_stays_gated():
    pushes = []
    human = verifier(pushes, max_wait=0.4)
    page = fake_page(FakeCdp())
    assert asyncio.run(human.verify(page, label="x", solved=lambda: False)) is False
    assert human.report()["timeouts"] == 1 and len(pushes) == 1


def test_already_solved_after_reload_needs_no_push_and_limits_hold():
    pushes = []
    human = verifier(pushes)
    assert asyncio.run(human.verify(fake_page(FakeCdp()), label="x", solved=lambda: True)) is True
    assert pushes == [] and human.report()["sessions"] == 0

    night = verifier(pushes, now=lambda: datetime(2026, 11, 23, 3, 0, tzinfo=BEIJING))
    assert asyncio.run(night.verify(fake_page(FakeCdp()), label="x", solved=lambda: False)) is False
    assert pushes == []

    spent = verifier(pushes, max_sessions=0)
    assert asyncio.run(spent.verify(fake_page(FakeCdp()), label="x", solved=lambda: False)) is False
    assert pushes == []

    def refused(*args):
        raise OSError("down")
    broken = verifier(pushes, push=refused)
    assert asyncio.run(broken.verify(fake_page(FakeCdp()), label="x", solved=lambda: False)) is False
    assert broken.report()["push_failed"] == 1

    def no_tunnel(binary, port):
        raise RuntimeError("TUNNEL_NOT_READY")
    offline = verifier(pushes, start_tunnel=no_tunnel)
    assert asyncio.run(offline.verify(fake_page(FakeCdp()), label="x", solved=lambda: False)) is False
    assert offline.report()["tunnel"] == "failed" and not offline.can_start()


class ScriptedHuman:
    """Stands in for a person: the page answers with a live sample once 'verification' happens."""

    timeout_allowance = 0

    def __init__(self, page, outcome):
        self.page, self.outcome, self.calls = page, outcome, 0

    def can_start(self):
        return True

    async def verify(self, page, *, label, solved, gate_present, touch):
        self.calls += 1
        assert touch is True and page is self.page
        assert self.page.reload.await_count == 1  # the gated page was loaded again for the person
        if self.outcome:
            url, kind, status, body = live_response("1234567", "3496655469226922")
            request = SimpleNamespace(url=url, method="GET", resource_type=kind, headers={},
                                      frame=page.main_frame, post_data=None, is_navigation_request=lambda: False)
            page.on.call_args.args[1](SimpleNamespace(url=url, request=request, status=status,
                                                      text=AsyncMock(return_value=body)))
            for _ in range(50):
                if solved():
                    break
                await asyncio.sleep(0.01)
        return solved()


def observe_with(make_settings, outcome):
    page = scripted_page([(DETAIL, "fetch", 200, '{"ret":["RGV587_ERROR::SM::hey"],"data":{}}')])
    page.reload = AsyncMock()
    human = ScriptedHuman(page, outcome)
    context = SimpleNamespace(new_page=AsyncMock(return_value=page))
    session = SimpleNamespace(context=AsyncMock(return_value=context), mode=lambda group: "guest")
    settings = make_settings([ali_target("tmall-room", 1)])
    resolved = {"room_url": ENTRY, "code": "OK", "source": "static", "reason": "anchor_entry",
                "discovery_mode": "anchor_entry"}
    ctx = SimpleNamespace(browser=None, settings=settings, budget=0, human=human)
    return asyncio.run(AliLiveMonitor(session).observe_room(settings.targets[0], resolved, ctx)), human


def test_a_solved_challenge_lets_the_room_finish_with_its_real_status(make_settings):
    room, human = observe_with(make_settings, outcome=True)
    assert human.calls == 1
    assert (room["code"], room["live_status"], room["live_id"]) == ("OK", "live", "3496655469226922")
    assert room["diagnostics"]["passive_observation"]["human_verification"] == "solved"


def test_an_unsolved_challenge_keeps_the_challenge_code(make_settings):
    room, human = observe_with(make_settings, outcome=False)
    assert human.calls == 1
    assert (room["code"], room["reason"]) == ("CAPTCHA_X5SEC", "api_access_limit")
    assert room["diagnostics"]["passive_observation"]["human_verification"] == "not_solved"


def test_without_a_verifier_nothing_changes(make_settings):
    page = scripted_page([(DETAIL, "fetch", 200, '{"ret":["RGV587_ERROR::SM::hey"],"data":{}}')])
    context = SimpleNamespace(new_page=AsyncMock(return_value=page))
    session = SimpleNamespace(context=AsyncMock(return_value=context), mode=lambda group: "guest")
    settings = make_settings([ali_target("tmall-room", 1)])
    resolved = {"room_url": ENTRY, "code": "OK", "source": "static", "reason": "anchor_entry",
                "discovery_mode": "anchor_entry"}
    room = asyncio.run(AliLiveMonitor(session).observe_room(
        settings.targets[0], resolved, SimpleNamespace(browser=None, settings=settings, budget=0)))
    assert room["code"] == "CAPTCHA_X5SEC"
    assert "human_verification" not in room["diagnostics"]["passive_observation"]
