import hashlib
import json
import os
from pathlib import Path

import pytest

from experiments.jd_cookie_live import manual
from experiments.jd_cookie_live.fixtures import LIVE_ROOM


def page(*, candidates=(), gate=None, scoped=True, sent=True, observed=True):
    return {"gate": gate, "scope_available": scoped, "authenticated_request_sent": sent,
            "cookie_injected_count": int(sent), "page_observed": observed,
            "target_identity_matched": observed, "login_state_signal": "target_page_observed",
            "live_entry_signals": [], "candidate_live_ids": list(candidates),
            "observed_function_ids": [], "http_error_samples": []}


def room(room_id, *, code="OK", gate=None):
    return {"live_id": room_id, "live_status": "unknown" if gate or code != "OK" else "live",
            "code": code, "gate": gate, "room_id_matched": not gate and code == "OK",
            "detect_ms": None, "elapsed_ms": 12, "observed_function_ids": [], "http_error_samples": []}


def unexpected(*args):
    raise AssertionError("unexpected outgoing lookup")


def test_config_failure_precedes_all_page_operations():
    result = manual.collect(None, "item.m.jd.com", unexpected, unexpected)
    assert result["config_error"] == "missing_jd_cookie"
    assert [row["code"] for row in result["entries"]] == ["CONFIG_ERROR"] * 3


@pytest.mark.parametrize("input_format", ["raw_header", "json_array"])
@pytest.mark.parametrize("stage", ["entry", "candidate"])
def test_private_exceptions_and_extra_fields_are_absent_from_artifacts_and_logs(
        input_format, stage, tmp_path, monkeypatch, capsys):
    private_name = "example_private_marker"
    private_value = "never-include-this-synthetic-value"
    raw = (f"{private_name}={private_value}" if input_format == "raw_header" else
           json.dumps([{"name": private_name, "value": private_value, "domain": "item.m.jd.com", "path": "/"}]))
    monkeypatch.setenv("JD_COOKIES_JSON", raw)
    attempted = []

    def entry(entry_id, session):
        attempted.append(entry_id)
        assert "JD_COOKIES_JSON" not in os.environ
        if stage == "entry":
            raise RuntimeError(raw)
        return {**page(candidates=[LIVE_ROOM]), "headers": {private_name: private_value}}

    def candidate(room_id):
        raise RuntimeError(raw)

    collect = manual.collect
    monkeypatch.setattr(manual, "collect", lambda raw, origin: collect(raw, origin, entry, candidate))
    out = tmp_path / "reports"
    monkeypatch.setattr("sys.argv", ["manual", "--out", str(out)])
    assert manual.main() != 0
    assert set(p.name for p in out.iterdir()) == {"jd_cookie_experiment_result.json", "summary.md", "SHA256SUMS.txt"}
    assert len(attempted) == 1
    rendered = "".join(capsys.readouterr()) + "".join(p.read_text() for p in out.iterdir())
    assert private_name not in rendered and private_value not in rendered
    result = json.loads((out / "jd_cookie_experiment_result.json").read_bytes())
    assert result["stop"]["stage"] == stage
    assert [row["code"] for row in result["entries"]] == ["OBSERVATION_ERROR", "SKIPPED", "SKIPPED"]
    for line in (out / "SHA256SUMS.txt").read_text().splitlines():
        digest, filename = line.split("  ")
        assert hashlib.sha256((out / filename).read_bytes()).hexdigest() == digest


@pytest.mark.parametrize("obs,code", [
    (page(scoped=None, sent=False, observed=False), "PUBLIC_PAGE_UNVERIFIED"),
    (page(scoped=False, sent=False, candidates=[LIVE_ROOM]), "SESSION_OUT_OF_SCOPE"),
    (page(observed=False), "AUTHENTICATED_PAGE_UNVERIFIED"),
    (page(), "NO_ENTRY_IN_HTML"),
], ids=["guest-unreadable", "credential-out-of-scope", "empty-auth-document", "no-html-link"])
def test_document_outcomes_do_not_claim_offline(obs, code):
    report = manual.collect("example=test", "item.m.jd.com", lambda *args: obs, unexpected)
    assert [row["code"] for row in report["entries"]] == [code] * 3


def test_verified_candidate_is_deduplicated_and_later_gate_stops_runner():
    entries = iter([page(candidates=[LIVE_ROOM]), page(candidates=[LIVE_ROOM]),
                    page(gate="LOGIN_REQUIRED", sent=False, observed=False)])
    checks = []

    def verify(room_id):
        checks.append(room_id)
        return room(room_id)

    result = manual.collect("example=test", "item.m.jd.com", lambda *args: next(entries), verify)
    assert checks == [LIVE_ROOM]
    assert [row["code"] for row in result["entries"]] == ["ROOM_STATUS_OBSERVED", "ROOM_STATUS_OBSERVED", "LOGIN_REQUIRED"]
    assert result["stop"]["stage"] == "entry"


@pytest.mark.parametrize("code,gate", [("CAPTCHA_X5SEC", "CAPTCHA_X5SEC"), ("OBSERVATION_ERROR", None)])
def test_public_room_failure_stops_all_later_lookups(code, gate):
    calls = []
    def observe(entry, _session):
        calls.append(entry)
        return page(candidates=[LIVE_ROOM, "900000000099"])

    report = manual.collect("example=test", "item.m.jd.com", observe,
                            lambda value: room(value, code=code, gate=gate))
    assert len(calls) == 1
    assert report["stop"] == {"entry_id": calls[0], "stage": "candidate", "code": code}
    assert report["entries"][0]["unattempted_candidate_ids"] == ["900000000099"]


def test_branch_dispatch_secret_is_scoped_to_one_step():
    wf = (Path(__file__).resolve().parents[2] / ".github/workflows/v2-monitor.yml").read_text()
    before, job = wf.split("\n  jd-storefront:\n")
    assert "options: [fake, live, jd-storefront]" in before
    assert "JD_COOKIES_JSON" not in before
    assert "github.ref == 'refs/heads/experiment/jd-cookie-live-discovery'" in job
    assert "inputs.engine == 'jd-storefront'" in job
    assert job.count("secrets.") == job.count("secrets.JD_COOKIES_JSON") == 1
    assert job.index("Install pinned dependencies") < job.index("secrets.JD_COOKIES_JSON") < job.index("name: Verify the report files")
