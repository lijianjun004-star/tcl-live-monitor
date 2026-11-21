"""Defect B: JD discovery blocks only unsafe writes and audits read-only POSTs; monitor is separate."""

import pytest

from core.network import GateLatch, NetworkAudit, RequestInfo
from core.safety import classify_unsafe_name
from platforms.jd.policy import (EXPLICIT_READS, PRIVATE, PROHIBITED_FUNCTION, JdDiscoveryPolicy,
                                 JdMonitorPolicy, func_id, public_post_read)

API = "https://api.m.jd.com/api"
FORM = {"content-type": "application/x-www-form-urlencoded"}


def post(function_id, url=API, body=None):
    return RequestInfo(url=url, method="POST", resource_type="xhr",
                       post_data=body if body is not None else f"functionId={function_id}&body=%7B%7D", headers=FORM)


VERIFIED_READS = ["getImmediatePlayToM", "liveDetailToM", "batchGetShopInfoByVenderId", "pc_detailpage_wareBusiness",
                  "graphic_detail", "getpageconfig", "ware_category_list", "yinliu_service_display"]
UNSAFE = {
    "order": ["submitOrder", "getOrderList", "checkoutConfirm", "doPay", "orderinfo"],
    "cart": ["addCart", "cartAdd", "addcart", "mcart_list"],
    "auth": ["loginCheck", "getPassportInfo", "captchaVerify", "riskControl", "refreshToken", "getAccountInfo"],
    "telemetry": ["trackEvent", "reportExposure", "clickLog", "beaconSend", "live_log", "liveRecord"],
    "privacy": ["getAddressList", "getUserInfo", "getCommentList", "queryUserPin", "getNickName"],
    "state_change": ["followShop", "receiveCoupon", "claimAward", "liveLikeAdd", "setLiveFlag", "joinGroup"],
}


@pytest.mark.parametrize("name", VERIFIED_READS)
def test_verified_reads_are_never_classified_unsafe(name):
    assert classify_unsafe_name(name) is None


@pytest.mark.parametrize("category,names", UNSAFE.items())
def test_unsafe_names_are_blocked_by_category(category, names):
    policy = JdDiscoveryPolicy()
    for name in names:
        decision = policy.decide(post(name))
        assert not decision.allow, name
        assert decision.reason == "unsafe_function_blocked" and decision.category is not None, name


def test_short_verbs_no_longer_cause_false_blocks():
    # The legacy substring list blocked these reads (``add`` inside load/padding, ``review`` inside preview).
    for name in ["loadDataList", "getPaddingConfig", "getLivePreviewInfo"]:
        assert PROHIBITED_FUNCTION.search(name) or PRIVATE.search(name), name   # legacy false positive
        assert classify_unsafe_name(name) is None, name


def test_legacy_blocking_strength_is_kept_for_real_writes():
    corpus = ["addCart", "submitOrder", "getUserInfo", "followShop", "trackClick", "loginByPhone", "deleteAddress",
              "getCommentList", "receiveCoupon", "updateNick", "bindCard", "registerUser", "getRiskInfo", "saveDraft"]
    for name in corpus:
        assert PROHIBITED_FUNCTION.search(name) or PRIVATE.search(name)
        assert classify_unsafe_name(name), name


def test_unknown_readonly_post_is_allowed_and_audited():
    policy, audit = JdDiscoveryPolicy(), NetworkAudit("jd_discovery")
    for name in ["queryAnchorCard", "querySkuLiveCard", "getImmediatePlayToM"]:
        decision = policy.decide(post(name))
        audit.record(decision)
        assert decision.allow and decision.reason == "readonly_post_audited"
    report = audit.report()
    assert report["function_ids"]["allowed"] == ["getImmediatePlayToM", "queryAnchorCard", "querySkuLiveCard"]
    # Not on the SKU experiment's read allow-list: let through, but flagged for review.
    assert report["function_ids"]["unknown_read"] == ["getImmediatePlayToM", "queryAnchorCard"]
    assert report["counts"] == {"readonly_post_audited": 3}


def test_writes_without_audit_identity_stay_blocked():
    policy = JdDiscoveryPolicy()
    assert policy.decide(post(None, body="body=%7B%7D")).reason == "post_without_function_id"
    duplicate = post(None, body="functionId=getA&functionId=getB")
    assert func_id(duplicate) is None and not policy.decide(duplicate).allow
    assert policy.decide(post("getX", url="https://api.m.jd.com/client/other")).reason == "api_write_path_not_allowed"
    assert policy.decide(post("getX", url="http://api.m.jd.com/api")).reason == "api_write_path_not_allowed"
    beacon = RequestInfo(url="https://wl.jd.com/log.gif", method="POST", resource_type="ping")
    assert policy.decide(beacon).reason == "non_api_write_blocked"


def test_unsafe_get_is_blocked_too():
    get = RequestInfo(url=API + "?functionId=addCart&body=%7B%7D", method="GET", resource_type="xhr")
    assert not JdDiscoveryPolicy().decide(get).allow


def test_external_media_font_and_gate_navigation():
    policy = JdDiscoveryPolicy()
    assert policy.decide(RequestInfo(url="https://evil.example/a.js")).reason == "external_requests_blocked"
    assert policy.decide(RequestInfo(url="https://img10.360buyimg.com/a.jpg", resource_type="image")).allow
    assert policy.decide(RequestInfo(url="https://x.jd.com/live.flv", resource_type="media")).reason == "media_blocked"
    assert policy.decide(RequestInfo(url="https://x.jd.com/a.woff2", resource_type="font")).reason == "font_blocked"
    login = RequestInfo(url="https://plogin.m.jd.com/login", is_navigation=True, resource_type="document")
    assert policy.decide(login).gate == "login_wall"
    slider = RequestInfo(url="https://jcap.m.jd.com/x", is_navigation=True, resource_type="document")
    assert policy.decide(slider).gate == "challenge"


def test_gate_latch_blocks_everything_after_a_gate():
    latch = GateLatch(JdDiscoveryPolicy())
    assert latch.decide(RequestInfo(url="https://item.m.jd.com/product/1234.html")).allow
    latch.decide(RequestInfo(url="https://passport.m.jd.com/x", is_navigation=True))
    assert latch.decide(RequestInfo(url="https://item.m.jd.com/product/1234.html")).reason == "gate_latched"


def test_monitor_policy_is_a_different_class_with_its_own_rules():
    discovery, monitor = JdDiscoveryPolicy(), JdMonitorPolicy()
    assert type(discovery) is not type(monitor) and discovery.name != monitor.name
    # Monitor keeps the legacy behaviour: any POST/host passes, only stream media and fonts drop.
    assert monitor.decide(post("trackEvent")).allow
    assert monitor.decide(RequestInfo(url="https://evil.example/x.js")).allow
    for url, kind in [("https://x.jd.com/a.m3u8", "xhr"), ("https://x.jd.com/v.flv", "media"),
                      ("https://x.jd.com/a.mp4", "other"), ("https://x.jd.com/f.woff", "font"),
                      ("https://x.jd.com/f.ttf", "other")]:
        assert not monitor.decide(RequestInfo(url=url, resource_type=kind)).allow, url
    assert monitor.decide(RequestInfo(url="https://x.jd.com/a.png", resource_type="image")).allow
    assert not JdMonitorPolicy(block_images=True).decide(RequestInfo(url="https://x.jd.com/a.png", resource_type="image")).allow


def test_known_read_flag_follows_legacy_allow_list():
    assert all(public_post_read(name) for name in ["pc_detailpage_wareBusiness", "graphic_detail"])
    assert {n.lower() for n in VERIFIED_READS} >= EXPLICIT_READS
