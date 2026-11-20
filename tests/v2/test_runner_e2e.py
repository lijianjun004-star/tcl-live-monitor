"""Whole pipeline with the offline engines: contracts, evidence pack, cache degradation, dedupe."""

import hashlib
import json

import pytest

from conftest import EXAMPLE
from core.contracts import problems
import v2_run


def run(tmp_path, *extra, scenario=None, env=None):
    args = ["--targets", str(EXAMPLE), "--engine", "fake", "--state-dir", str(tmp_path / "state"),
            "--out", str(tmp_path / "ev"), "--dashboard", str(tmp_path / "docs" / "index.html"), "--no-drive", *extra]
    if scenario is not None:
        path = tmp_path / "scenario.json"
        path.write_text(json.dumps(scenario))
        args += ["--scenario", str(path)]
    return v2_run.asyncio.run(v2_run.run(v2_run.parse_args(args), env or {}))


def read(tmp_path, name):
    return json.loads((tmp_path / "ev" / name).read_text(encoding="utf-8"))


def verify_sums(root):
    lines = (root / "SHA256SUMS.txt").read_text(encoding="ascii").splitlines()
    assert lines
    for line in lines:
        digest, name = line.split("  ", 1)
        assert hashlib.sha256((root / name).read_bytes()).hexdigest() == digest
    return {line.split("  ", 1)[1] for line in lines}


def test_first_run_produces_a_valid_evidence_pack(tmp_path):
    assert run(tmp_path) == 0
    assert problems("resolved_rooms", read(tmp_path, "resolved_rooms.json")) == []
    snapshot = read(tmp_path, "monitor_snapshot.json")
    assert problems("monitor_snapshot", snapshot) == [] and snapshot["canary"]["passed"] is True
    names = verify_sums(tmp_path / "ev")
    assert {"run_summary.json", "control_live_result.json", "resolved_rooms.json", "monitor_snapshot.json", "index.html"} <= names
    summary = read(tmp_path, "run_summary.json")
    assert summary["verdict"] == "canary_passed" and summary["positive_live_control"] is True
    assert summary["contract_validation"] == {"resolved_rooms": "ok", "monitor_snapshot": "ok"}
    assert summary["notification"]["status"] == "not_configured" and summary["notification"]["fresh_events"] == 8
    assert (tmp_path / "docs" / "index.html").exists() and (tmp_path / "state" / "resolved_cache.json").exists()


def test_failed_discovery_on_a_later_run_degrades_to_cache(tmp_path):
    run(tmp_path)
    first = {r["target_key"]: r for r in read(tmp_path, "resolved_rooms.json")["rooms"]}
    scenario = {"jd-clip-link": {"discovery": {"code": "NAV_TIMEOUT", "reason": "navigation_timeout"}},
                "jd-sku-ac": {"discovery": {"code": "SCHEMA_MISMATCH", "reason": "no_live_candidate"}}}
    assert run(tmp_path, scenario=scenario) == 0
    rows = {r["target_key"]: r for r in read(tmp_path, "resolved_rooms.json")["rooms"]}
    assert rows["jd-clip-link"]["source"] == "cache" and rows["jd-clip-link"]["code"] == "NAV_TIMEOUT"
    assert rows["jd-clip-link"]["live_id"] == first["jd-clip-link"]["live_id"]
    # The SKU candidate was confirmed by the monitor in run 1, so it is cached too.
    assert rows["jd-sku-ac"]["source"] == "cache" and rows["jd-sku-ac"]["room_url"] == first["jd-sku-ac"]["room_url"]
    rooms = {r["target_key"]: r for r in read(tmp_path, "monitor_snapshot.json")["rooms"]}
    assert rooms["jd-clip-link"]["code"] == "OK" and rooms["jd-clip-link"]["discovery"]["source"] == "cache"


def test_repeat_run_sends_nothing_new_and_canary_failure_sets_exit_code(tmp_path):
    sent = []

    def fake_send(title, text, env, transport=None):
        sent.append(text)
        return {"status": "sent", "kind": "wecom", "http": 200}

    v2_run.notifiers.send, original = fake_send, v2_run.notifiers.send
    try:
        run(tmp_path, env={"WEBHOOK_URL": "https://qyapi.weixin.qq.com/x"})
        run(tmp_path, env={"WEBHOOK_URL": "https://qyapi.weixin.qq.com/x"})
        assert len(sent) == 1 and read(tmp_path, "run_summary.json")["notification"]["status"] == "no_changes"
        code = run(tmp_path, "--fail-on-canary", scenario={"jd-canary": {"monitor": {"code": "NAV_TIMEOUT"}}},
                   env={"WEBHOOK_URL": "https://qyapi.weixin.qq.com/x"})
        assert code == 3 and "【对照失败】" in sent[-1]
        assert read(tmp_path, "run_summary.json")["verdict"] == "canary_failed"
    finally:
        v2_run.notifiers.send = original


def test_breaker_in_the_pipeline(tmp_path):
    scenario = {"taobao-anchor": {"monitor": {"code": "CAPTCHA_X5SEC", "reason": "platform_challenge"}}}
    run(tmp_path, scenario=scenario)
    rooms = {r["target_key"]: r for r in read(tmp_path, "monitor_snapshot.json")["rooms"]}
    assert rooms["taobao-anchor"]["code"] == "CAPTCHA_X5SEC"
    assert rooms["taobao-share"]["code"] == "GROUP_CIRCUIT_OPEN"       # same group 2
    assert rooms["tmall-flagship"]["code"] == "OK"                     # group 1 unaffected
    assert read(tmp_path, "monitor_snapshot.json")["summary"]["circuit_open_groups"] == ["ali:group_2"]


def test_invalid_targets_exit_with_contract_code(tmp_path):
    bad = tmp_path / "bad.json"
    bad.write_text(json.dumps({"schema_version": "2.0", "targets": [{"key": "x", "platform": "jd", "mode": "direct"}]}))
    args = v2_run.parse_args(["--targets", str(bad), "--engine", "fake", "--out", str(tmp_path / "ev"),
                              "--state-dir", str(tmp_path / "s"), "--no-drive", "--no-notify"])
    assert v2_run.asyncio.run(v2_run.run(args, {})) == 2


@pytest.mark.parametrize("secret", ["ALI_COOKIE_GROUP_1"])
def test_malformed_cookie_secret_stops_before_any_browser(tmp_path, secret, capsys):
    args = v2_run.parse_args(["--targets", str(EXAMPLE), "--engine", "live", "--out", str(tmp_path / "ev"),
                              "--state-dir", str(tmp_path / "s"), "--no-drive", "--no-notify"])
    assert v2_run.asyncio.run(v2_run.run(args, {secret: "bad cookie with SECRETVALUE"})) == 2
    assert "SECRETVALUE" not in capsys.readouterr().out
