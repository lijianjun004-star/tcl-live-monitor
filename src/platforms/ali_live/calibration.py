"""Value-limited MTOP evidence and an offline comparison of two observed anchor snapshots."""

import re
from urllib.parse import parse_qsl, urlsplit

from core.timeutil import parse_iso

from .classifier import DETAIL_PATH, clean, status_enum

LIVE_ID = re.compile(r"[1-9][0-9]{4,23}")
PUBLIC_NUMBER = re.compile(r"[1-9][0-9]{0,23}")


def _number(value, pattern):
    if type(value) not in (str, int):
        return None
    text = str(value)
    return text if pattern.fullmatch(text) else None


def _wire_enum(value):
    # Preserve the JSON scalar type for reviewer inspection. Other scalars are opaque.
    if type(value) is int and -99 <= value <= 255:
        return value
    if type(value) is str and re.fullmatch(r"-?[0-9]{1,3}", value) and -99 <= int(value) <= 255:
        return value
    if type(value) is float and value.is_integer() and -99 <= value <= 255:
        return value
    return None


def livedetail_status_sample(payload, http_status, target):
    """Returns only enum values, identity comparisons, and a valid public session ID."""
    data = payload.get("data")
    data = data if isinstance(data, dict) else {}
    caster = data.get("broadCaster")
    caster = caster if isinstance(caster, dict) else {}
    ret = payload.get("ret")
    success = bool(isinstance(ret, list) and ret and len(ret) <= 3
                   and all(isinstance(token, str) and token.split("::", 1)[0] == "SUCCESS" for token in ret))
    live = data.get("liveId")
    live_id = _number(live, LIVE_ID)
    if "liveId" not in data:
        kind = "missing"
    elif live is None:
        kind = "null"
    elif type(live) is str and live == "":
        kind = "empty"
    elif type(live) in (int, str) and live in ("0", 0):
        kind = "zero"
    else:
        kind = "numeric" if live_id else "invalid"

    def number_matches(source, key, expected):
        if key not in source or source[key] is None or source[key] == "":
            return None
        value = _number(source[key], PUBLIC_NUMBER)
        return bool(value is not None and value == expected)
    name = caster.get("accountName")
    expect_name = target.get("display_name")
    expected_room = target.get("room_number")
    rooms = [_number(raw, PUBLIC_NUMBER) for raw in (caster.get("roomNum"), data.get("roomNum"))
             if raw is not None and raw != ""]
    if rooms:
        room_match = bool(rooms[0] and all(room == rooms[0] for room in rooms)
                          and (not expected_room or rooms[0] == str(expected_room)))
    else:
        room_match = False if expected_room else None
    return {
        "http_status": http_status,
        "mtop_success": success,
        "room_status": _wire_enum(data.get("roomStatus")),
        "stream_status": _wire_enum(data.get("streamStatus")),
        "live_id_kind": kind,
        "live_id": live_id,
        "broadcaster_account_matches": number_matches(caster, "accountId", target.get("account_id")),
        "broadcaster_name_matches": (bool(isinstance(name, str) and isinstance(expect_name, str)
                                          and clean(expect_name) and clean(name) == clean(expect_name))
                                     if name is not None else None),
        "room_number_matches": room_match,
        "data_account_matches": number_matches(data, "accountId", target.get("account_id")),
    }


def _anchor(row):
    if row.get("platform") not in {"tmall", "taobao"} or row.get("discovery", {}).get("mode") != "anchor_entry":
        return None
    try:
        parts = urlsplit(row.get("room_url") or "")
        qs = parse_qsl(parts.query, keep_blank_values=True)
    except ValueError:
        return None
    if (parts.scheme != "https" or parts.netloc != "h5.m.taobao.com" or parts.path != "/taolive/video.html"
            or parts.fragment or len(qs) != 1 or qs[0][0] != "userId" or not re.fullmatch(r"[1-9][0-9]{4,15}", qs[0][1])):
        return None
    return (row["platform"], qs[0][1])


def compare_anchor_observations(earlier, current):
    """Compare signed/verified real-run artifact rows. This never asserts an exact stop time."""
    def result(reason, relation="unknown", validated=False):
        return {"offline_rule_validated": validated, "reason": reason, "session_relation": relation}

    earlier, current = earlier or {}, current or {}
    anchor = _anchor(earlier)
    if not anchor or _anchor(current) != anchor or not earlier.get("display_name") or earlier["display_name"] != current.get("display_name"):
        return result("anchor_mismatch_or_missing")
    start, end = parse_iso(earlier.get("observed_at")), parse_iso(current.get("observed_at"))
    if start is None or end is None or end <= start:
        return result("observations_not_ordered")
    old = earlier.get("diagnostics", {})
    prior_id = _number(earlier.get("live_id"), LIVE_ID)
    olds = old.get("passive_observation", {})
    old_detail = olds.get("livedetail_v4", {})
    prior_count = old_detail.get("json_objects")
    if (earlier.get("code") != "OK" or earlier.get("live_status") != "live"
            or earlier.get("reason") != "live_detail_room_and_stream_on" or not prior_id
            or old.get("identity_verified") is not True or olds.get("navigation_attempted") is not True
            or type(prior_count) is not int or prior_count <= 0
            or not any(ep.get("path", "").rstrip("/") == DETAIL_PATH and ep.get("http") == 200
                       for ep in old.get("endpoints", []))):
        return result("prior_live_unverified")

    if current.get("code") not in {"OK", "OFFLINE", "SCHEMA_MISMATCH"}:
        return result("current_blocked_skipped_or_unknown")
    diag = current.get("diagnostics", {})
    observation = diag.get("passive_observation", {})
    detail = observation.get("livedetail_v4", {})
    samples = diag.get("livedetail_status_samples", [])
    if (diag.get("identity_verified") is not True or observation.get("navigation_attempted") is not True
            or not isinstance(samples, list) or not 0 < len(samples) <= 12 or detail.get("responses") != len(samples)
            or detail.get("json_objects") != len(samples) or detail.get("read_or_parse_errors") != 0):
        return result("current_detail_incomplete")
    states = set()
    for s in samples:
        if not isinstance(s, dict):
            return result("current_detail_incomplete")
        if (type(s.get("http_status")) is not int or not 200 <= s["http_status"] < 300
                or s.get("mtop_success") is not True or s.get("broadcaster_account_matches") is not True
                or s.get("broadcaster_name_matches") is not True
                or "room_number_matches" not in s or (s["room_number_matches"] is not None and s["room_number_matches"] is not True)
                or "data_account_matches" not in s or (s["data_account_matches"] is not None and s["data_account_matches"] is not True)):
            return result("current_identity_or_response_unverified")
        kind, live_id = s.get("live_id_kind"), s.get("live_id")
        if not isinstance(kind, str) or (live_id is not None and not _number(live_id, LIVE_ID)):
            return result("current_detail_incomplete")
        states.add((status_enum(s.get("room_status"), 2), status_enum(s.get("stream_status"), 1),
                    kind, live_id))
    if len(states) != 1:
        return result("inconsistent_current_samples")
    room, stream, kind, live_id = states.pop()
    if (current.get("code") == "OFFLINE" and current.get("live_status") == "offline"
            and current.get("reason") == "live_detail_room_and_stream_off" and diag.get("offline_evidence") is True
            and room in (0, 2) and stream == 0 and kind in {"empty", "zero"} and live_id is None
            and current.get("live_id") is None):
        return result("same_anchor_live_then_explicit_offline", "no_current_live_id", True)
    if kind == "numeric" and _number(live_id, LIVE_ID):
        relation = "same_live_id" if live_id == prior_id else "different_live_id"
        if ((room, stream) == (1, 1) and current.get("code") == "OK"
                and current.get("live_status") == "live" and current.get("live_id") == live_id
                and all(s["data_account_matches"] is True for s in samples)):
            return result("current_anchor_live", relation)
        if room in (0, 2) and stream == 0:
            return result("stopped_stream_with_retained_id_unvalidated", relation)
    return result("explicit_offline_rule_not_observed")
