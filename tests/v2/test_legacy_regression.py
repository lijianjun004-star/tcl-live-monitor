"""No regression: legacy self-test passes and the ported blocks behave exactly like the originals."""

import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest

import single_room_probe
from platforms.jd import discovery as v2_discovery, policy as v2_policy, short_link

ROOT = Path(__file__).resolve().parents[2]
EXPERIMENT = ROOT / "experiments" / "jd_sku_live"


def load(name):
    spec = importlib.util.spec_from_file_location(f"legacy_{name}", EXPERIMENT / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_single_room_probe_self_test_still_passes():
    single_room_probe.self_test()


def test_single_room_probe_cli_self_test_is_unchanged():
    run = subprocess.run([sys.executable, str(ROOT / "src" / "single_room_probe.py"), "--self-test"],
                         capture_output=True, text=True, timeout=60)
    assert run.returncode == 0 and "Passed strict admission" in run.stdout


@pytest.mark.parametrize("role,url", [
    ("control", "https://lives.jd.com/#/49019552"), ("clip", "https://lives.jd.com/#/49019552/replay"),
    ("product", "https://item.m.jd.com/product/100012345678.html"), ("product", "https://item.jd.com/100012345678.html"),
    ("control", "https://m.jd.com/x?liveId=49019552"), ("control", "https://evil.example/#/49019552"),
    ("clip", "https://lives.jd.com/?liveId=1&liveId=2"),
])
def test_short_link_helpers_match_the_experiment(role, url):
    original = load("resolve")
    assert short_link.identifiers(role, url) == original.identifiers(role, url)
    assert short_link.route_shape(url) == original.route_shape(url)
    assert short_link.url_gate(url) == original.url_gate(url) and short_link.permitted(url) == original.permitted(url)


def test_evidence_walker_matches_the_experiment():
    original = load("discovery")
    payload = {"data": {"liveId": "49019552", "liveInfo": {"roomId": "49654695", "url": "https://lives.jd.com/#/49011111"},
                        "items": [{"skuId": "100012345678", "userName": "private-1234567"}]}}
    links = ["https://lives.jd.com/#/49022222/live", "https://h5.m.jd.com/x?liveId=49033333", "https://evil.example/#/4904444"]
    ours, theirs = v2_discovery.Evidence(), original.Evidence()
    for evidence in (ours, theirs):
        evidence.payload(payload, ("api", "fn"))
        for link in links:
            evidence.link(link, ("dom", ""))
    assert ours.candidates == theirs.candidates and ours.numbers == theirs.numbers
    assert set(ours.candidates) == {"49019552", "49654695", "49011111", "49022222", "49033333"}


def test_function_id_parsing_and_read_allow_list_match_the_experiment():
    original = load("discovery")

    class Request:
        def __init__(self, url, method="GET", post_data=None):
            self.url, self.method, self.post_data = url, method, post_data

    cases = [Request("https://api.m.jd.com/api?functionId=getA"),
             Request("https://api.m.jd.com/api", "POST", "functionId=getB&body=%7B%7D"),
             Request("https://api.m.jd.com/api", "POST", json.dumps({"functionId": "getC"})),
             Request("https://api.m.jd.com/api?functionId=x", "POST", "functionId=y")]
    for request in cases:
        assert v2_policy.func_id(request) == original.func_id(request)
    for name in ["pc_detailpage_wareBusiness", "getSkuLiveInfo", "addCart", "graphic_detail", "loadDataList", None]:
        assert v2_policy.public_post_read(name) == original.public_post_read(name)
    assert v2_policy.PROHIBITED_FUNCTION.pattern == original.PROHIBITED_FUNCTION.pattern
    assert v2_policy.PRIVATE.pattern == original.PRIVATE.pattern


def test_sku_verdicts_keep_the_experiment_vocabulary():
    verdict = v2_discovery.sku_control_verdict
    assert verdict("1", "9", True, {"9"}, set(), False, True) == "matching_live_id_uniquely_discovered_in_this_run"
    assert verdict("1", "9", True, {"9", "8"}, set(), False, True) == "matching_live_id_among_candidates_or_partial_results"
    assert verdict("1", "9", True, set(), {"9"}, False, False) == "matching_live_id_in_sku_response_before_redirect"
    assert verdict("1", "9", False, {"9"}, set(), False, True) == "inconclusive_no_confirmed_live_control"
    assert verdict(None, "9", True, set(), set(), False, True) == "inconclusive_sku_unresolved"
