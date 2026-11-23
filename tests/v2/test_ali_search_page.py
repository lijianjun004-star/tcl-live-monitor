"""Taobao Live PC search page: policy, response parsing, card extraction and cross-check. Offline."""

from __future__ import annotations

import asyncio
import glob
import json
import os
from pathlib import Path

import pytest

from core.errors import Code
from core.network import RequestInfo
from platforms.ali_live.cookie_pool import CookieError, parse_cookie_header
from platforms.ali_live.search_page import (
    EXTRACT_CARDS_JS, AliSearchPolicy, api_live_state, canonical_link, classify_ret, collect_api_anchors,
    cross_check, is_search_api, key_paths, normalize_cards, read_search_response, search_url, summarize,
)

ROOT = Path(__file__).resolve().parents[2]
WHITELIST = ROOT / "config" / "taobao-search-whitelist.json"
API = "https://h5api.m.taobao.com/h5/mtop.mediaplatform.live.search.result/1.0/?jsv=2.7.2&appKey=1"
# Shape observed 2026-11-23 from a cloud IP (value trimmed): the verification answer this probe must stop on.
RGV587_JSONP = ('mtopjsonp1({"api":"mtop.mediaplatform.live.search.result","v":"1.0", '
                '"ret": ["RGV587_ERROR::SM::哎哟喂,被挤爆啦,请稍后重试!"],"data": {"url": "https://login.taobao.com/member/login.jhtml?style=mini"}})')


def decide(url, method="GET", resource_type="xhr", navigation=False, main=True):
    return AliSearchPolicy().decide(RequestInfo(url=url, method=method, resource_type=resource_type,
                                                is_navigation=navigation, is_main_frame=main))


def test_search_url_encodes_the_query():
    assert search_url("TCL") == ("https://tbzb.taobao.com/search?liveSource=pc_live.anchor&searchQuery=TCL"
                                 "&spm=tbpc.anchor.nav.dsearch")
    assert "searchQuery=TCL%20%E7%94%B5%E8%A7%86&" in search_url("TCL 电视")


def test_policy_reads_family_hosts_and_blocks_media_fonts_and_outsiders():
    assert decide("https://tbzb.taobao.com/search?searchQuery=TCL", resource_type="document", navigation=True).allow
    assert decide("https://g.alicdn.com/x/app.js", resource_type="script").allow
    assert decide("https://umdcv4.taobao.com/repWd.json").allow
    assert decide(API).allow and decide(API).name == "mtop.mediaplatform.live.search.result"
    assert decide("https://livecb.alicdn.com/live/1.flv").reason == "heavy_resource_blocked"
    assert decide("https://at.alicdn.com/t/font.woff2", resource_type="font").reason == "heavy_resource_blocked"
    assert decide("https://www.google-analytics.com/collect").reason == "external_requests_blocked"


def test_policy_audits_mtop_posts_allows_beacons_and_blocks_other_writes():
    assert decide(API, method="POST").reason == "readonly_post_audited"
    assert decide("https://h5api.m.taobao.com/h5/mtop.trade.order.create/1.0/", method="POST").allow is False
    assert decide("https://gm.mmstat.com/v.gif", method="POST").reason == "beacon_post_allowed"
    assert decide("https://ynuf.aliapp.org/w/wu.json", method="POST").reason == "beacon_post_allowed"
    assert decide("https://tbzb.taobao.com/follow", method="POST").reason == "non_api_write_blocked"


def test_policy_turns_main_frame_login_or_challenge_navigation_into_a_gate():
    login = decide("https://login.taobao.com/member/login.jhtml", resource_type="document", navigation=True)
    assert (login.allow, login.gate) == (False, "login_wall")
    punish = decide("https://tbzb.taobao.com/_____tmd_____/punish?x5secdata=1", resource_type="document", navigation=True)
    assert (punish.allow, punish.gate) == (False, "challenge")
    # The mini-login iframe is not a main-frame navigation; the API verdict stops the run instead.
    assert decide("https://login.taobao.com/member/login.jhtml?style=mini", resource_type="document",
                  navigation=True, main=False).gate is None


def test_is_search_api_only_matches_the_search_family_on_mtop_hosts():
    assert is_search_api(API) == "mtop.mediaplatform.live.search.result"
    assert is_search_api("https://h5api.m.taobao.com/h5/mtop.mediaplatform.live.livedetail/4.0/") is None
    assert is_search_api("https://tbzb.taobao.com/h5/mtop.mediaplatform.live.search.result/1.0/") is None


def test_ret_classification_follows_the_v2_codes():
    assert classify_ret({"ret": ["SUCCESS::调用成功"]}) == (Code.OK, "success")
    assert classify_ret({"ret": ["FAIL_SYS_SESSION_EXPIRED::Session过期"]}) == (Code.LOGIN_REQUIRED, "api_login_required")
    assert classify_ret({"ret": ["FAIL_SYS_USER_VALIDATE::x"]}) == (Code.CAPTCHA_X5SEC, "api_user_validate")
    assert classify_ret({"ret": ["FAIL_BIZ_X::y"]}) == (Code.SCHEMA_MISMATCH, "api_error")
    assert classify_ret({"data": {}}) == (Code.SCHEMA_MISMATCH, "missing_ret")


def test_observed_rgv587_jsonp_stops_as_captcha():
    code, reason, payload = read_search_response(RGV587_JSONP)
    assert (code, reason) == (Code.CAPTCHA_X5SEC, "api_rgv587")
    assert payload["api"] == "mtop.mediaplatform.live.search.result"
    assert read_search_response("<html>blocked</html>")[:2] == (Code.SCHEMA_MISMATCH, "unparseable_response")


PAYLOAD = {
    "ret": ["SUCCESS::调用成功"],
    "data": {
        "viewer": {"userId": "1111111111", "nick": "monitor-account"},
        "result": [
            {"accountId": "395601843", "accountName": "TCL电视官方旗舰店", "liveId": "560000000001", "liveStatus": 1,
             "title": "大促直播", "coverImg": "https://img.alicdn.com/a.jpg"},
            {"accountId": "2098070993", "accountName": "TCL空调官方旗舰店", "liveStatus": 0},
            {"accountId": "2200000000001", "accountName": "TCL冰箱旗舰店", "liveStatus": 1, "liveId": "560000000002"},
            {"accountId": "395601843", "accountName": "TCL电视官方旗舰店", "liveStatus": 1},
        ],
    },
}


def test_api_candidates_are_deduplicated_and_exclude_the_viewer():
    candidates = collect_api_anchors(PAYLOAD, exclude=lambda value: value == "1111111111")
    ids = [c["account_id"] for c in candidates]
    assert sorted(ids) == ["2098070993", "2200000000001", "395601843"]
    tv = next(c for c in candidates if c["account_id"] == "395601843")
    assert tv["occurrences"] == 2 and tv["path"] == "data.result[]"
    assert tv["status_fields"] == {"liveStatus": 1} and tv["live_id"] == "560000000001"
    assert "coverImg" in tv["keys"]
    paths, truncated = key_paths(PAYLOAD)
    assert "data.result[].liveStatus" in paths and not truncated


def test_api_live_state_needs_a_calibrated_rule():
    candidate = {"status_fields": {"liveStatus": 1}}
    assert api_live_state(candidate, None) is None
    rule = {"field": "liveStatus", "live_values": [1], "not_live_values": [0]}
    assert api_live_state(candidate, rule) == "live"
    assert api_live_state({"status_fields": {"liveStatus": 0}}, rule) == "not_live"
    assert api_live_state({"status_fields": {"liveStatus": 9}}, rule) is None


RAW_CARDS = [
    {"button": "进入", "lines": ["直播中", "TCL电视官方旗舰店", "粉丝 120万", "进入"],
     "links": ["https://tbzb.taobao.com/live?liveId=560000000001&spm=a.b.c&utm=x", "https://evil.example/x"],
     "button_link": "https://tbzb.taobao.com/live?liveId=560000000001&spm=a"},
    {"button": "主页", "lines": ["TCL空调官方旗舰店", "主页"], "links": ["https://tbzb.taobao.com/anchor?userId=2098070993"],
     "button_link": None},
    {"button": "进入", "lines": ["TCL冰箱旗舰店", "进入"], "links": [], "button_link": None},
    {"button": "进入", "lines": ["某经销商TCL专卖", "进入"], "links": [], "button_link": None},
    {"button": "分享", "lines": ["ignored"], "links": [], "button_link": None},
]


def test_cards_keep_only_family_links_and_id_parameters():
    cards = normalize_cards(RAW_CARDS)
    assert len(cards) == 4
    tv = cards[0]
    assert (tv["name"], tv["dom_state"]) == ("TCL电视官方旗舰店", "live")
    assert tv["button_link"] == "https://tbzb.taobao.com/live?liveId=560000000001"
    assert tv["links"] == ["https://tbzb.taobao.com/live?liveId=560000000001"]
    assert cards[1]["link_ids"] == {"userId": "2098070993"} and cards[1]["dom_state"] == "not_live"
    assert canonical_link("javascript:alert(1)") is None


def whitelist(rule=None):
    doc = json.loads(WHITELIST.read_text(encoding="utf-8"))
    doc["api_live_rule"] = rule
    return doc


def rows(rule=None, payload=PAYLOAD, raw=RAW_CARDS):
    results = cross_check(whitelist(rule), collect_api_anchors(payload), normalize_cards(raw))
    return {row["key"]: row for row in results}


def test_uncalibrated_response_keeps_every_anchor_unknown_but_records_the_card():
    result = rows()
    tv = result["tmall-tcl-tv-official"]
    assert (tv["code"], tv["reason"], tv["live_status"]) == ("SCHEMA_MISMATCH", "api_live_field_uncalibrated", "unknown")
    assert tv["dom_state"] == "live" and tv["room_link"] == "https://tbzb.taobao.com/live?liveId=560000000001"
    assert all(row["code"] != "OK" for row in result.values())


RULE = {"field": "liveStatus", "live_values": [1], "not_live_values": [0]}


def test_agreeing_signals_decide_live_and_offline():
    result = rows(RULE)
    tv, ac = result["tmall-tcl-tv-official"], result["tmall-tcl-ac-official"]
    assert (tv["code"], tv["live_status"], tv["notify_eligible"]) == ("OK", "live", True)
    assert tv["room_url"] == "https://h5.m.taobao.com/taolive/video.html?userId=395601843"
    assert tv["api_live_id"] == "560000000001"
    assert (ac["code"], ac["live_status"], ac["room_link"]) == ("OFFLINE", "offline", None)
    missing = result["tcl-group"]
    assert (missing["code"], missing["reason"]) == ("NAV_TIMEOUT", "not_in_search_results")


def test_disagreeing_signals_stay_unknown():
    raw = [dict(RAW_CARDS[0], button="主页", lines=["TCL电视官方旗舰店", "主页"])]
    tv = rows(RULE, raw=raw)["tmall-tcl-tv-official"]
    assert (tv["code"], tv["reason"], tv["live_status"]) == ("SCHEMA_MISMATCH", "api_dom_disagree", "unknown")


def test_pending_anchor_reports_id_candidates_and_never_notifies():
    fridge = rows(RULE)["tcl-fridge"]
    assert fridge["id_candidates"] == [{"account_id": "2200000000001", "name": "TCL冰箱旗舰店", "id_key": "accountId"}]
    assert fridge["code"] == "OK" and fridge["notify_eligible"] is False and fridge["room_url"] is None


def test_duplicate_cards_for_one_anchor_are_ambiguous():
    raw = [RAW_CARDS[0], dict(RAW_CARDS[0], button_link=None, links=[])]
    tv = rows(RULE, raw=raw)["tmall-tcl-tv-official"]
    assert (tv["code"], tv["reason"]) == ("SCHEMA_MISMATCH", "ambiguous_cards")


def test_summary_counts_other_live_cards_without_naming_them():
    cards = normalize_cards(RAW_CARDS)
    summary = summarize(cross_check(whitelist(RULE), collect_api_anchors(PAYLOAD), cards), cards, whitelist(RULE))
    assert summary["cards_enter"] == 3 and summary["cards_home"] == 1
    assert summary["other_enter_cards"] == 1 and summary["api_calibrated"] is True


def test_repository_whitelist_is_valid():
    from taobao_search_probe import load_whitelist

    doc = load_whitelist(WHITELIST)
    verified = {a["key"]: a["account_id"] for a in doc["anchors"] if a["id_status"] == "verified"}
    assert verified == {"tcl-group": "2050532947", "tmall-tcl-tv-official": "395601843",
                        "tmall-tcl-ac-official": "2098070993", "tmall-tcl-smarthome": "2210516382103"}
    assert doc["api_live_rule"] is None


def test_cookie_errors_name_the_dedicated_secret_and_never_the_value():
    with pytest.raises(CookieError) as error:
        parse_cookie_header("broken-pair-secretvalue", 0, label="TAOBAO_SEARCH_COOKIE")
    assert "TAOBAO_SEARCH_COOKIE" in str(error.value) and "secretvalue" not in str(error.value)
    group = parse_cookie_header("unb=1111111111; cookie2=abc", 0, label="TAOBAO_SEARCH_COOKIE")
    assert group.holds("unb", "1111111111") and not group.holds("unb", "2") and not group.holds("unb", "")


def test_probe_without_cookie_exits_2_and_writes_a_receipt(tmp_path, monkeypatch):
    from taobao_search_probe import main

    monkeypatch.delenv("TAOBAO_SEARCH_COOKIE", raising=False)
    assert main(["--out", str(tmp_path), "--whitelist", str(WHITELIST)]) == 2
    receipt = json.loads((tmp_path / "receipt.json").read_text(encoding="utf-8"))
    assert receipt["outcome"] == "config_error" and "TAOBAO_SEARCH_COOKIE" in receipt["error"]


# --- card extraction script in a real browser against local HTML (no network) -----------------

FIXTURE = """
<html><body>
<section><h2>相关直播间</h2>
  <div class="row"><div class="card"><img><div><span>直播中</span><b>TCL电视官方旗舰店</b><i>粉丝 120万</i></div>
    <a href="https://tbzb.taobao.com/live?liveId=560000000001"><span>进入</span></a></div></div>
  <div class="row"><div class="card"><div><b>TCL空调官方旗舰店</b></div>
    <a href="https://tbzb.taobao.com/anchor?userId=2098070993"><button>主页</button></a></div></div>
  <div class="row"><div class="card"><div><b>TCL冰箱旗舰店</b></div><div class="btn">进入</div></div></div>
</section>
<section><h2>相关商品</h2><div>TCL 65英寸电视 ¥3999</div></section>
</body></html>
"""


def chromium_path():
    if os.environ.get("V2_CHROMIUM_EXECUTABLE"):
        return os.environ["V2_CHROMIUM_EXECUTABLE"]
    found = sorted(glob.glob("/opt/pw-browsers/chromium-*/chrome-linux*/chrome"))
    return found[-1] if found else None


def test_extract_cards_script_finds_one_card_per_button():
    playwright = pytest.importorskip("playwright.async_api")

    async def run():
        async with playwright.async_playwright() as pw:
            try:
                options = {"executable_path": chromium_path()} if chromium_path() else {}
                browser = await pw.chromium.launch(**options)
            except Exception as exc:
                pytest.skip(f"no launchable Chromium: {type(exc).__name__}")
            page = await browser.new_page()
            await page.set_content(FIXTURE)
            raw = await page.evaluate(EXTRACT_CARDS_JS)
            await browser.close()
            return raw

    cards = normalize_cards(asyncio.run(run()))
    assert [(c["name"], c["dom_state"]) for c in cards] == [
        ("TCL电视官方旗舰店", "live"), ("TCL空调官方旗舰店", "not_live"), ("TCL冰箱旗舰店", "live")]
    assert cards[0]["button_link"] == "https://tbzb.taobao.com/live?liveId=560000000001"
    assert cards[1]["link_ids"] == {"userId": "2098070993"}
    assert cards[2]["button_link"] is None
