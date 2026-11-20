"""Real Chromium, fake platform: every request is answered locally, nothing leaves the machine.

Skipped when no Chromium can be launched. In Actions, after ``playwright install chromium``,
it runs as part of the offline suite. Locally, point V2_CHROMIUM_EXECUTABLE at a Chromium.
"""

from __future__ import annotations

import asyncio
import glob
import json
import os
from urllib.parse import parse_qs, urlsplit

import pytest

from conftest import ali_target
from core.browser import BrowserFactory
from core.errors import Code
from core.models import resolved_room

ROOM = "49019552"
JD_PAGE = f"https://lives.jd.com/#/{ROOM}"
ALI_PAGE = "https://h5.m.taobao.com/taolive/video.html?userId={}"
CORS = {"access-control-allow-origin": "*", "content-type": "application/json"}


def chromium_path():
    if os.environ.get("V2_CHROMIUM_EXECUTABLE"):
        return os.environ["V2_CHROMIUM_EXECUTABLE"]
    found = sorted(glob.glob("/opt/pw-browsers/chromium-*/chrome-linux*/chrome"))
    return found[-1] if found else None


async def _can_launch():
    try:
        async with BrowserFactory(executable_path=chromium_path()):
            return True
    except Exception:
        return False


@pytest.fixture(scope="module")
def browser_available():
    if not asyncio.run(_can_launch()):
        pytest.skip("Chromium is not available in this environment")


@pytest.fixture(autouse=True)
def no_network():  # overrides conftest: the Playwright driver itself needs local pipes only
    yield


class FakePlatform(BrowserFactory):
    """Fulfils every request from ``pages``/``apis``; records what actually reached the 'network'."""

    def __init__(self, pages: dict[str, str], apis):
        super().__init__(executable_path=chromium_path())
        self.pages, self.apis, self.seen = pages, apis, []

    async def new_context(self, profile, **extra):
        context = await super().new_context(profile, **extra)
        await context.route("**/*", self._fulfil)
        return context

    async def _fulfil(self, route):
        request = route.request
        url = request.url.split("#", 1)[0]
        self.seen.append((request.method, url, request.post_data))
        if url in self.pages:
            await route.fulfill(status=200, content_type="text/html; charset=utf-8", body=self.pages[url])
            return
        reply = self.apis(request)
        if reply is not None:
            await route.fulfill(status=200, headers=CORS, body=reply)
            return
        await route.fulfill(status=404, body="")


def jd_live_page(delay_ms=300, call_api=True, body_text="TCL 官方直播间 正在直播"):
    api = (f"setTimeout(() => fetch('https://api.m.jd.com/api?functionId=getImmediatePlayToM&body=%7B%7D'), {delay_ms});"
           if call_api else "")
    return f"""<!doctype html><html><head><title>京东直播</title>
<style>@font-face {{ font-family: x; src: url(https://lives.jd.com/f.woff2); }} body {{ font-family: x; }}</style>
</head><body><p>{body_text}</p><video src="https://lives.jd.com/stream.flv" autoplay muted></video>
<script>{api}</script></body></html>"""


def jd_detail(status=1):
    return json.dumps({"code": "0", "subCode": "0", "data": {
        "liveId": ROOM, "status": status, "onlineCount": 42, "currentItem": {"title": "TCL 空调 新风", "price": 2999}}})


def jd_apis(request):
    return jd_detail() if "functionId=getImmediatePlayToM" in request.url else None


def make_ctx(settings, tmp_path, factory):
    from core.base import RunContext
    from core.breaker import GroupCircuitBreaker

    ctx = RunContext(settings=settings, breaker=GroupCircuitBreaker({t.group_key for t in settings.targets}),
                     evidence_dir=tmp_path / "ev")
    ctx.browser = factory
    return ctx


def jd_resolved(target):
    return resolved_room(target, code=Code.OK, reason="cfg", source="static", live_id=ROOM, room_url=JD_PAGE,
                         resolved_at=None, cache_age_seconds=None, verification="config", audit={})


def run_jd(make_settings, tmp_path, page, budget=12):
    from platforms.jd.live_monitor import JdLiveMonitor

    settings = make_settings([{"key": "jd-live", "platform": "jd", "mode": "direct", "display_name": "jd",
                               "live_id": ROOM, "canary": True}], room_budget_seconds=budget)
    factory = FakePlatform({"https://lives.jd.com/": page}, jd_apis)

    async def scenario():
        async with factory:
            ctx = make_ctx(settings, tmp_path, factory)
            target = settings.targets[0]
            return await JdLiveMonitor().observe_room(target, jd_resolved(target), ctx), ctx

    room, ctx = asyncio.run(scenario())
    return room, ctx, factory


def test_jd_live_room_returns_early_well_inside_the_budget(browser_available, make_settings, tmp_path):
    room, ctx, factory = run_jd(make_settings, tmp_path, jd_live_page())
    assert room["code"] == "OK" and room["live_status"] == "live" and room["live_id"] == ROOM
    assert room["online_count"] == 42 and room["item_price"] == 2999 and room["keywords_hit"] == ["TCL", "新风", "空调"]
    assert room["diagnostics"]["early_return"] is True
    assert room["detect_ms"] < 4000 and room["elapsed_ms"] < 12000
    assert room["thumbnail"] == "thumbs/jd-live.jpg" and (tmp_path / "ev" / "thumbs" / "jd-live.jpg").stat().st_size > 0
    counts = room["diagnostics"]["network"]
    assert counts.get("font_blocked", 0) >= 1 and counts.get("media_blocked", 0) >= 1
    assert not any(url.endswith((".woff2", ".flv")) for _, url, _ in factory.seen)   # never reached the network
    assert ctx.legacy_results["jd-live"]["room_id_matched"] is True


def test_jd_room_without_a_detail_signal_stops_at_the_budget(browser_available, make_settings, tmp_path):
    room, _, _ = run_jd(make_settings, tmp_path, jd_live_page(call_api=False), budget=5)
    assert room["code"] == "NAV_TIMEOUT" and room["reason"] == "signal_not_observed_within_budget"
    assert 4500 <= room["elapsed_ms"] < 9000 and room["detect_ms"] is None


def test_jd_slider_text_is_a_challenge(browser_available, make_settings, tmp_path):
    room, _, _ = run_jd(make_settings, tmp_path, jd_live_page(call_api=False, body_text="请拖动滑块完成安全验证"))
    assert room["code"] == "CAPTCHA_X5SEC" and room["thumbnail"] is None
    assert room["elapsed_ms"] < 6000


def ali_detail(account, ret="SUCCESS::调用成功"):
    data = {"accountId": account, "roomNum": "555666", "roomStatus": 1, "streamStatus": 1, "liveId": "900000000001",
            "broadCaster": {"accountId": account, "accountName": "SYNTH", "roomNum": "555666"}}
    return "mtopjsonp1(" + json.dumps({"ret": [ret], "data": data}) + ")"


def ali_page(account):
    # The fake page names its account in the query; cross-origin referrers carry no query string.
    return f"""<!doctype html><html><body><p>淘宝直播</p><script>
fetch('https://h5api.m.taobao.com/h5/mtop.mediaplatform.live.livedetail/4.0/?jsv=2.6.1&data=%7B%7D&fake_account={account}');
</script></body></html>"""


def test_ali_group_breaker_with_real_pages(browser_available, make_settings, tmp_path):
    from platforms.ali_live.cookie_pool import CookiePool
    from platforms.ali_live.live_monitor import AliLiveMonitor
    from platforms.ali_live.session import AliSession

    accounts = {"g1-live": "1000001", "g1-blocked": "1000002", "g1-after": "1000003", "g2-live": "2000001"}
    targets = [ali_target(key, 1 if key.startswith("g1") else 2, account=acc) for key, acc in accounts.items()]
    settings = make_settings(targets, inter_room_delay_seconds=0)

    def apis(request):
        if "livedetail" not in request.url:
            return None
        account = parse_qs(urlsplit(request.url).query).get("fake_account", [""])[0]
        return ali_detail(account, "FAIL_SYS_USER_VALIDATE::验证" if account == "1000002" else "SUCCESS::调用成功")

    pages = {ALI_PAGE.format(acc): ali_page(acc) for acc in accounts.values()}
    factory = FakePlatform(pages, apis)
    session = AliSession(CookiePool.from_env({"ALI_COOKIE_GROUP_2": "t=abc; _tb_token_=xyz"}), {1: {"tmall"}, 2: {"tmall"}})

    async def scenario():
        async with factory:
            ctx = make_ctx(settings, tmp_path, factory)
            pairs = [(t, resolved_room(t, code=Code.OK, reason="anchor_entry", source="static", live_id=None,
                                       room_url=ALI_PAGE.format(t.account_id), resolved_at=None, cache_age_seconds=None,
                                       verification="config", audit={})) for t in settings.targets]
            try:
                rooms = await AliLiveMonitor(session).monitor_all(pairs, ctx)
                cookies = await (await session.context(factory, 2)).cookies()
            finally:
                await session.close()
            return rooms, ctx, cookies

    rooms, ctx, cookies = asyncio.run(scenario())
    assert rooms["g1-live"]["code"] == "OK" and rooms["g1-live"]["live_id"] == "900000000001"
    assert rooms["g1-blocked"]["code"] == "CAPTCHA_X5SEC" and rooms["g1-blocked"]["reason"] == "api_access_limit"
    assert rooms["g1-after"]["code"] == "GROUP_CIRCUIT_OPEN"
    assert rooms["g2-live"]["code"] == "OK" and rooms["g2-live"]["diagnostics"]["cookie_mode"] == "cookie"
    assert rooms["g1-live"]["diagnostics"]["cookie_mode"] == "guest"
    assert not any("userId=1000003" in url for _, url, _ in factory.seen)          # zero requests after the trip
    assert {c["domain"] for c in cookies} == {".taobao.com", ".tmall.com"}         # dual-domain injection
    assert ctx.breaker.open_groups() == ["ali:group_1"]


def test_jd_h5_discovery_lets_reads_through_and_blocks_cart(browser_available, tmp_path):
    from platforms.jd.discovery import observe_h5, pick_candidate

    sku = "100012345678"
    page = """<!doctype html><html><head><title>TCL 空调 挂机 京东</title></head><body>
<div class="sku-name">TCL 空调</div><p>加入购物车 立即购买 商品详情 ￥2999</p><script>
const form = n => ({method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded'}, body: 'functionId=' + n + '&body=%7B%7D'});
fetch('https://api.m.jd.com/api', form('queryAnchorCard'));
fetch('https://api.m.jd.com/api', form('addCart'));
fetch('https://api.m.jd.com/api', form('trackClick'));
fetch('https://api.m.jd.com/api', {method: 'POST', body: 'body=%7B%7D'});
</script></body></html>"""

    def apis(request):
        if "api.m.jd.com" in request.url:
            return json.dumps({"code": "0", "data": {"liveId": ROOM, "title": "x"}})
        return None

    factory = FakePlatform({f"https://item.m.jd.com/product/{sku}.html": page}, apis)

    async def scenario():
        async with factory:
            return await observe_h5(factory, sku)

    out, evidence, prior, audit = asyncio.run(scenario())
    posted = [body for method, url, body in factory.seen if method == "POST"]
    assert any("queryAnchorCard" in (b or "") for b in posted)
    assert not any("addCart" in (b or "") or "trackClick" in (b or "") for b in posted)
    assert not any(b == "body=%7B%7D" for b in posted)
    report = audit.report()
    assert "queryAnchorCard" in report["function_ids"]["allowed"]
    assert {"addCart", "trackClick"} <= set(report["function_ids"]["blocked"])
    assert report["blocked_by_category"] == {"cart": 1, "telemetry": 1}
    assert report["counts"]["post_without_function_id"] == 1
    assert out["status"] == "loaded" and pick_candidate(evidence) == (ROOM, "unique_live_candidate")
