import json

import pytest

from experiments.jd_cookie_live import run
from experiments.jd_cookie_live.fixture_session import RAW_COOKIE_FIXTURE
from experiments.jd_cookie_live.fixtures import FLAGSHIP, LIGHTING, LIVE_ROOM, PAGES, SKU, VERIFICATIONS


def unexpected(*args):
    pytest.fail("looked up a fixture after a terminal condition")


def test_default_cli_generates_matching_offline_reports(tmp_path, monkeypatch):
    sentinel = "offline-isolation-canary"
    monkeypatch.setenv("JD_COOKIES_JSON", sentinel)
    monkeypatch.setattr("sys.argv", ["experiment", "--out", str(tmp_path)])
    assert run.main() == 0
    json_text = (tmp_path / "jd_cookie_experiment_result.json").read_text()
    markdown = (tmp_path / "summary.md").read_text()
    assert sentinel not in json_text + markdown
    report = json.loads(json_text)
    assert report["mode"] == "offline_fixture"
    assert [r["code"] for r in report["entries"]] == ["ROOM_STATUS_OBSERVED", "CANDIDATE_ONLY", "LOGIN_REQUIRED"]
    assert report["entries"][0]["verifications"][0]["live_status"] == "live"
    assert "HTTP 503" in markdown and "HTTP 403" in markdown and "模拟" in markdown


@pytest.mark.parametrize("gate", ["LOGIN_REQUIRED", "CAPTCHA_X5SEC", "ACCESS_RESTRICTED"])
def test_gate_prevents_lookup_of_all_subsequent_targets(gate):
    looked_up = []

    def page(entry_id):
        looked_up.append(entry_id)
        return {"gate": gate}

    report = run.replay(page, unexpected, RAW_COOKIE_FIXTURE)
    assert looked_up == [SKU]
    assert report["stop"] == {"entry_id": SKU, "stage": "entry", "code": gate}
    assert [r["code"] for r in report["entries"]] == [gate, "SKIPPED_AFTER_GATE", "SKIPPED_AFTER_GATE"]


def test_candidate_gate_stops_other_candidates_and_subsequent_entries():
    checked = []
    def verify(room_id):
        checked.append(room_id)
        return {"gate": "CAPTCHA_X5SEC"}

    def page(entry_id):
        assert entry_id == SKU
        return {**PAGES[SKU], "dom_live_ids": [LIVE_ROOM, "900000000099"]}

    report = run.replay(page, verify, RAW_COOKIE_FIXTURE)
    assert checked == [LIVE_ROOM]
    assert report["entries"][0]["unattempted_candidate_ids"] == ["900000000099"]
    assert report["stop"]["stage"] == "candidate"
    assert report["entries"][1]["code"] == "SKIPPED_AFTER_GATE"


def test_no_observed_entry_and_missing_page_are_not_offline():
    def page(entry_id):
        if entry_id == SKU:
            return {"final_url": PAGES[SKU]["final_url"], "http_status": 200, "document_observed": True}
        return None

    report = run.replay(page, unexpected, RAW_COOKIE_FIXTURE)
    assert [r["code"] for r in report["entries"]] == ["NO_ENTRY_OBSERVED", "NO_PAGE_EVIDENCE", "NO_PAGE_EVIDENCE"]
    assert all(not r["verifications"] for r in report["entries"])


def test_configuration_error_stops_before_reading_samples():
    report = run.replay(unexpected, unexpected, None)
    assert report["config_error"] == "missing_jd_cookie"
    assert [row["code"] for row in report["entries"]] == ["CONFIG_ERROR"] * 3


def test_shared_candidate_is_classified_once_across_entrances():
    checked = []
    def verify(room_id):
        checked.append(room_id)
        return VERIFICATIONS[room_id]

    def page(entry_id):
        if entry_id == LIGHTING:
            return None
        return {**PAGES[entry_id], "dom_hrefs": PAGES[SKU]["dom_hrefs"]}

    report = run.replay(page, verify, RAW_COOKIE_FIXTURE)
    assert checked == [LIVE_ROOM]
    assert [r["entry_id"] for r in report["entries"]] == [SKU, FLAGSHIP, LIGHTING]
    assert report["entries"][1]["verifications"] == report["entries"][0]["verifications"]
