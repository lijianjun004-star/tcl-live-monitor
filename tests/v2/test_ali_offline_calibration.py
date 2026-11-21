import json
from copy import deepcopy

import pytest

from platforms.ali_live.calibration import compare_anchor_observations, livedetail_status_sample
from platforms.ali_live.classifier import DETAIL_PATH, classify_tmall
from test_ali_passive_observation import DETAIL, ENTRY, observe

ANCHOR = {"account_id": "1234567", "room_number": "778899", "display_name": "SYNTH"}
ID = "9876543211234"


def payload(**fields):
    data = {"roomStatus": 2, "streamStatus": "0", "liveId": "0", "accountId": "1234567",
            "roomNum": "778899", "broadCaster": {"accountId": "1234567", "accountName": "SYNTH", "roomNum": "778899"}}
    return {"ret": ["SUCCESS::sensitive-text"], "data": {**data, **fields}, "other": "private-note"}


def pair(*samples):
    observation = {"navigation_attempted": True, "livedetail_v4": {"responses": len(samples),
                   "json_objects": len(samples), "read_or_parse_errors": 0}}
    earlier = {"platform": "tmall", "room_url": ENTRY, "display_name": "SYNTH", "discovery": {"mode": "anchor_entry"},
               "live_id": ID, "code": "OK", "reason": "live_detail_room_and_stream_on", "live_status": "live",
               "observed_at": "2026-11-20T15:01:00Z",
               "diagnostics": {"identity_verified": True, "passive_observation": {"navigation_attempted": True,
                               "livedetail_v4": {"json_objects": 1}},
                               "endpoints": [{"path": DETAIL_PATH + "/", "http": 200}]}}
    current = {**earlier, "code": "OFFLINE", "reason": "live_detail_room_and_stream_off", "live_status": "offline",
               "live_id": None, "observed_at": "2026-11-20T19:10:00Z", "diagnostics": {
                   "identity_verified": True, "offline_evidence": True, "passive_observation": observation,
                   "livedetail_status_samples": [livedetail_status_sample(p, 200, ANCHOR) for p in samples]}}
    return earlier, current


def test_real_monitor_path_records_only_enum_values_and_identity_matches(make_settings):
    room = observe(make_settings, [(ENTRY, "document", 200, ""), (DETAIL, "xhr", 200, json.dumps(payload()))])
    assert room["live_status"] == "offline"
    assert room["diagnostics"]["offline_rule_validated"] is False  # one row cannot prove a transition
    assert room["diagnostics"]["livedetail_status_samples"] == [{
        "http_status": 200, "mtop_success": True, "room_status": 2, "stream_status": "0",
        "live_id_kind": "zero", "live_id": None, "broadcaster_account_matches": True,
        "broadcaster_name_matches": True, "room_number_matches": True, "data_account_matches": True}]
    assert "sensitive-text" not in json.dumps(room) and "private-note" not in json.dumps(room)


@pytest.mark.parametrize("live_id", [0, "0", ""])
def test_positive_comparison_is_anchor_only(live_id):
    prior, now = pair(payload(liveId=live_id), payload(liveId=live_id))
    assert compare_anchor_observations(prior, now) == {"offline_rule_validated": True,
            "reason": "same_anchor_live_then_explicit_offline", "session_relation": "no_current_live_id"}


@pytest.mark.parametrize("field,value", [
    ("roomStatus", None), ("streamStatus", False), ("roomStatus", "02"), ("liveId", None),
    ("liveId", []), ("liveId", False), ("accountId", "9999999"), ("roomNum", "999999"), ("broadCaster", {"accountName": "wrong"})])
def test_absent_invalid_or_mismatched_values_cannot_validate(field, value):
    prior, now = pair(payload(**{field: value}))
    assert not compare_anchor_observations(prior, now)["offline_rule_validated"]


def test_missing_live_id_or_unbounded_values_are_not_evidence():
    doc = payload()
    del doc["data"]["liveId"]
    prior, now = pair(doc)
    assert now["diagnostics"]["livedetail_status_samples"][0]["live_id_kind"] == "missing"
    assert not compare_anchor_observations(prior, now)["offline_rule_validated"]
    sample = livedetail_status_sample(payload(roomStatus="private", streamStatus=100000, liveId="private"), 200, ANCHOR)
    assert (sample["room_status"], sample["stream_status"], sample["live_id_kind"]) == (None, None, "invalid")
    assert "private" not in json.dumps(sample)


@pytest.mark.parametrize("live_id,relation", [(ID, "same_live_id"), ("2222222222", "different_live_id")])
def test_positive_id_does_not_calibrate_offline_or_prove_earlier_session_ended(live_id, relation):
    prior, now = pair(payload(liveId=live_id))
    now.update(code="SCHEMA_MISMATCH", live_status="unknown", reason="ambiguous_status")
    assert compare_anchor_observations(prior, now) == {"offline_rule_validated": False,
        "reason": "stopped_stream_with_retained_id_unvalidated", "session_relation": relation}
    now.update(code="OK", reason="live_detail_room_and_stream_on", live_status="live", live_id=live_id)
    now["diagnostics"]["livedetail_status_samples"] = [livedetail_status_sample(
        payload(liveId=live_id, roomStatus=1, streamStatus=1), 200, ANCHOR)]
    assert compare_anchor_observations(prior, now) == {"offline_rule_validated": False,
        "reason": "current_anchor_live", "session_relation": relation}


def test_rejects_other_anchor_gate_invalid_order_inconsistent_or_partial_observations():
    prior, current = pair(payload())
    for patch in [
        {"room_url": ENTRY.replace("1234567", "1234568")}, {"display_name": "Other"}, {"code": "LOGIN_REQUIRED"},
        {"observed_at": prior["observed_at"]}, {"live_id": ID}, {"diagnostics": {}},
    ]:
        assert not compare_anchor_observations(prior, {**current, **patch})["offline_rule_validated"]
    for change in ["unparsed_response", "failed_envelope", "http_error", "missing_status", "contradiction"]:
        now = deepcopy(current)
        n = now["diagnostics"]["passive_observation"]["livedetail_v4"]
        samples = now["diagnostics"]["livedetail_status_samples"]
        if change == "unparsed_response":
            n["responses"] += 1
        elif change == "failed_envelope":
            samples[0]["mtop_success"] = False
        elif change == "http_error":
            samples[0]["http_status"] = 500
        elif change == "missing_status":
            del samples[0]["stream_status"]
        else:
            samples.append({**samples[0], "stream_status": 1})
            n.update(responses=2, json_objects=2)
        assert not compare_anchor_observations(prior, now)["offline_rule_validated"]
    assert not compare_anchor_observations({**prior, "code": "OFFLINE"}, current)["offline_rule_validated"]

@pytest.mark.parametrize("caster_number, data_number", [("778899", None), (None, "778899"),
                                                       ("778899", ""), ("", "778899")])
def test_one_matching_room_number_and_missing_duplicate_account_suffice(caster_number, data_number):
    doc = payload(roomNum=data_number)
    doc["data"]["broadCaster"]["roomNum"] = caster_number
    del doc["data"]["accountId"]
    prior, current = pair(doc)
    assert classify_tmall(doc, ANCHOR)["state"] == "OFFLINE"
    assert current["diagnostics"]["livedetail_status_samples"][0]["data_account_matches"] is None
    assert compare_anchor_observations(prior, current)["offline_rule_validated"]


def test_absent_unconfigured_room_numbers_are_optional_but_configured_number_is_required():
    doc = payload()
    del doc["data"]["roomNum"]
    del doc["data"]["broadCaster"]["roomNum"]
    prior, current = pair(doc)
    assert classify_tmall(doc, ANCHOR)["state"] == "UNKNOWN"
    assert not compare_anchor_observations(prior, current)["offline_rule_validated"]
    no_room = {**ANCHOR, "room_number": None}
    assert classify_tmall(doc, no_room)["state"] == "OFFLINE"
    sample = livedetail_status_sample(doc, 200, no_room)
    assert sample["room_number_matches"] is None
    current["diagnostics"]["livedetail_status_samples"] = [sample]
    assert compare_anchor_observations(prior, current)["offline_rule_validated"]
    del sample["room_number_matches"]
    assert not compare_anchor_observations(prior, current)["offline_rule_validated"]

def test_duplicate_room_omission_does_not_relax_live_admission():
    doc = payload(roomStatus=1, streamStatus=1, liveId=ID)
    del doc["data"]["roomNum"]
    assert classify_tmall(doc, ANCHOR)["reason"] == "CONFLICTING_ROOM_NUMBERS"
    del doc["data"]["broadCaster"]["accountId"]
    assert classify_tmall(doc, ANCHOR)["reason"] == "IDENTITY_MISMATCH"

def test_explicit_duplicate_account_conflict_stops_runtime_offline_classification():
    doc = payload(accountId="7654321")
    del doc["data"]["roomNum"]
    assert classify_tmall(doc, ANCHOR)["reason"] == "IDENTITY_MISMATCH"
