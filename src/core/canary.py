"""Positive live control. The predicate is copied verbatim from experiments/jd_sku_live/run.py."""

from __future__ import annotations

from .timeutil import iso

LEGACY_FIELDS = ("generated_at", "room_id_matched", "login_or_captcha_blocked", "page_loaded",
                 "live_status", "page_gate_reason", "route_mode", "reasons")


def positive_live_control(legacy: dict) -> bool:
    return (
        legacy.get("room_id_matched") is True and legacy.get("page_loaded") is True
        and legacy.get("login_or_captcha_blocked") is False and legacy.get("live_status") == "live"
    )


def control_row(target_key: str | None, room: dict | None, legacy: dict | None, started: str | None) -> dict:
    """Same shape as the experiment's control_live_result.json, plus the V2 code."""
    row = {"observed_from": started or iso(), "status": "not_run_no_canary", "target_key": target_key,
           "room_id": None, "positive_live_control": False, "live_status": "unknown", "room_id_matched": None,
           "login_or_captcha_blocked": None, "page_loaded": None, "code": None, "observed_until": iso()}
    if target_key is None:
        return row
    row["status"] = "not_run_room_unresolved"
    if room is not None:
        row["code"] = room["code"]
        row["room_id"] = room.get("live_id")
    if legacy is None:
        return row
    row["status"] = "observed"
    for name in LEGACY_FIELDS:
        row[name] = legacy.get(name)
    row["room_id"] = legacy.get("room_id") or row["room_id"]
    row["positive_live_control"] = positive_live_control(legacy)
    return row


def snapshot_canary(target_key: str | None, room: dict | None, legacy: dict | None) -> dict:
    if target_key is None:
        return {"target_key": None, "passed": None, "code": None, "live_status": None}
    return {
        "target_key": target_key,
        "passed": bool(legacy is not None and positive_live_control(legacy) and room and room["code"] == "OK"),
        "code": room["code"] if room else None,
        "live_status": room["live_status"] if room else "unknown",
    }
