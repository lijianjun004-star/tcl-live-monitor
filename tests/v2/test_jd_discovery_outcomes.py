"""SKU and shop discovery outcomes, including the blocked operations observed in live runs C/D."""
import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from core.errors import Code
from core.network import Decision, NetworkAudit, RequestInfo
from platforms.jd import discovery
from platforms.jd.policy import JdDiscoveryPolicy

API = "https://api.m.jd.com/api"
SKU_BLOCKS = ("comment_getCommentList", "crosssitesync.upload", "reportInvokeLog")
SHOP_BLOCKS = ("getTokenC", "m_address_cmpnt_queryAddress", "reportInvokeLog")


def inspect_page(monkeypatch, surface, audit, *, status="loaded", candidates=(), **page_details):
    target = SimpleNamespace(mode="sku_discover" if surface == "h5" else "shop_discover",
                             sku_id="100133134399", shop_id="12345", vender_id=None)
    ctx = SimpleNamespace(browser=None, budget=12)
    page = {"status": status, "loaded_product_page": status == "loaded", **page_details}
    evidence = discovery.Evidence()
    for identifier in candidates:
        evidence.record(identifier, ("dom", "", "public_live_route"), candidate=True)
    if surface == "h5":
        sample = (page, evidence, discovery.Evidence(), audit)
        monkeypatch.setattr(discovery, "observe_h5", AsyncMock(return_value=sample))
    else:
        monkeypatch.setattr(discovery, "observe_shop", AsyncMock(return_value=(page, evidence, audit)))
    return asyncio.run(discovery.JdDiscovery().resolve_one(target, ctx))


def record(audit, request):
    decision = JdDiscoveryPolicy().decide(request)
    audit.record(decision)
    return decision


@pytest.mark.parametrize("surface,known,non_api_count,expected", [
    ("h5", SKU_BLOCKS, 24, "no_live_entry_in_guest_h5"),  # C
    ("h5", SKU_BLOCKS, 22, "no_live_entry_in_guest_h5"),  # D
    ("shop", SHOP_BLOCKS, 31, "no_live_candidate_in_guest_shop"),
    ("h5", (), 1, "no_live_entry_in_guest_h5"),
    ("shop", (), 0, "no_live_candidate_in_guest_shop"),
])
def test_expected_blocks_and_unclassified_allowed_reads(monkeypatch, surface, known, non_api_count, expected):
    audit = NetworkAudit("jd_discovery")
    for name in known:
        assert not record(audit, RequestInfo(f"{API}?functionId={name}", method="POST")).allow
    for _ in range(non_api_count):
        record(audit, RequestInfo("https://wl.jd.com/log.gif", method="POST"))
    assert record(audit, RequestInfo(f"{API}?functionId=mcommon_getHeaderInfo")).allow
    assert "mcommon_getHeaderInfo" in audit.unknown_reads
    result = inspect_page(monkeypatch, surface, audit)
    assert (result.code, result.reason, result.live_id) == (Code.SCHEMA_MISMATCH, expected, None)
    assert result.audit["network"] == audit.report()


@pytest.mark.parametrize("request_info", [
    RequestInfo(f"{API}?functionId=reportNewLiveCard", method="POST"),  # classified by a keyword only
    RequestInfo(API, method="POST", post_data="functionId=getA&functionId=getB"),
    RequestInfo("https://api.m.jd.com/other?functionId=queryCard", method="POST"),
    RequestInfo(f"{API}?functionId=queryCard", method="PATCH"),
])
def test_unreviewed_block_remains_distinct(monkeypatch, request_info):
    audit = NetworkAudit("jd_discovery")
    assert not record(audit, request_info).allow
    result = inspect_page(monkeypatch, "h5", audit)
    assert (result.code, result.reason) == (Code.POST_AUDIT_BLOCKED, "unreviewed_discovery_api_block")


def test_name_bound_does_not_hide_an_unknown_block(monkeypatch):
    monkeypatch.setattr("core.network.MAX_AUDITED_NAMES", 1)
    audit = NetworkAudit("jd_discovery")
    record(audit, RequestInfo(f"{API}?functionId=reportInvokeLog"))
    record(audit, RequestInfo(f"{API}?functionId=reportNewLiveCard"))
    assert audit.truncated and audit.blocked == {"reportInvokeLog"}
    result = inspect_page(monkeypatch, "shop", audit)
    assert (result.code, result.reason) == (Code.SCHEMA_MISMATCH, "discovery_audit_incomplete")


@pytest.mark.parametrize("surface,page,reason", [
    ("h5", {"live_entry_signals": ["current_product_live"]}, "guest_h5_live_entry_without_candidate"),
    ("h5", {"status": "product_content_unconfirmed"}, "guest_h5_product_content_unconfirmed"),
    ("h5", {"limits_reached": ["response_count_limit"]}, "discovery_observation_incomplete"),
    ("shop", {"response_diagnostics": {"hook_read_errors": 1}}, "discovery_observation_incomplete"),
    ("h5", {"response_diagnostics": {"public_api_http_errors": 3}}, "discovery_observation_incomplete"),
    ("h5", {"candidates": ["1234"]}, "invalid_live_candidate_id"),
])
def test_partial_observation_is_not_absent_entry(monkeypatch, surface, page, reason):
    result = inspect_page(monkeypatch, surface, NetworkAudit("jd_discovery"), **page)
    assert (result.code, result.reason) == (Code.SCHEMA_MISMATCH, reason)


@pytest.mark.parametrize("surface,status,candidates,code,reason", [
    ("h5", "login_wall", (), Code.LOGIN_REQUIRED, "login_wall"),
    ("shop", "challenge", (), Code.CAPTCHA_X5SEC, "challenge"),
    ("h5", "redirected_elsewhere", (), Code.REDIRECTED, "redirected_elsewhere"),
    ("shop", "app_download_landing", (), Code.REDIRECTED, "app_download_landing"),
    ("h5", "loaded", ("123456", "234567"), Code.SCHEMA_MISMATCH, "ambiguous_live_candidates"),
    ("shop", "loaded", ("123456",), Code.OK, "unique_live_candidate"),
])
def test_page_gates_and_candidate_evidence_take_precedence(monkeypatch, surface, status, candidates, code, reason):
    audit = NetworkAudit("jd_discovery")
    audit.record(Decision(False, "post_without_function_id"))
    result = inspect_page(monkeypatch, surface, audit, status=status, candidates=candidates)
    assert (result.code, result.reason) == (code, reason)


@pytest.mark.parametrize("all_errors,expected_rows", [(False, 10), (True, 13)])
def test_http_error_samples_match_selected_diagnostic_mode(monkeypatch, all_errors, expected_rows):
    from collections import Counter

    monkeypatch.setenv("V2_JD_ALL_HTTP_ERROR_SAMPLES", "1" if all_errors else "0")
    counts, samples = Counter(), []
    for i in range(13):
        request = RequestInfo(f"{API}?tracking=user-{i}&functionId=graphic_detail",
                              headers={"cookie": "secret-cookie"})
        discovery._record_public_http_error(counts, samples, request, 404 if i % 2 == 0 else 503)
    assert counts == {"public_api_http_errors": 13}
    assert samples == [{"function_id": "graphic_detail", "http_status": status, "host": "api.m.jd.com"}
                       for status in ([404, 503] * 7)[:expected_rows]]


@pytest.mark.parametrize("query,body,expected", [
    ("", "functionId=mcommon_getHeaderInfo&body=private-value", "mcommon_getHeaderInfo"),
    ("functionId=crosssitesync.syncvisitkey", "", "crosssitesync.syncvisitkey"),
    ("functionId=querySkuLiveInfo&token=secret", "", "querySkuLiveInfo"),
    ("", "body=private-value", None),
    ("functionId=getPageConfig", "functionId=graphic_detail", None),
    ("functionId=eyJhbGciOiJIUzI1NiJ9.secret.signature", "", None),
    ("functionId=skuDisplayV13800138000", "", None),
    ("functionId=opaque-019393482174", "", None),
])
def test_error_samples_only_export_recognized_public_operation_labels(query, body, expected):
    from collections import Counter

    req = RequestInfo(f"{API}?{query}", method="POST", post_data=body, headers={"cookie": "secret"})
    samples = []
    discovery._record_public_http_error(Counter(), samples, req, 403)
    assert samples == [{"function_id": expected, "http_status": 403, "host": "api.m.jd.com"}]


def test_empty_http_samples_do_not_change_no_candidate_classification(monkeypatch):
    result = inspect_page(monkeypatch, "h5", NetworkAudit("jd_discovery"),
                          response_diagnostics={"public_api_http_error_samples": []})
    assert (result.code, result.reason) == (Code.SCHEMA_MISMATCH, "no_live_entry_in_guest_h5")
