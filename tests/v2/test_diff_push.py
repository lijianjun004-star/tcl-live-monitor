"""Snapshot diff, dedupe ledger, merged message and the four webhook payload formats."""

import base64
import hashlib
import hmac
import json
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs, unquote, urlsplit

import pytest

from output.diff_push import NotifyLedger, build_message, compute_events
from output.notifiers import build_request, detect_kind, send

NOW = datetime(2026, 11, 20, 12, 0, tzinfo=timezone.utc)


def room(key, code="OK", status="live", price=None, words=(), platform="jd"):
    return {"target_key": key, "display_name": key, "platform": platform, "code": code, "live_status": status,
            "live_id": "49019552", "room_url": "https://lives.jd.com/#/49019552", "item_price": price,
            "keywords_hit": list(words), "reason": "x"}


def snap(rooms, open_groups=(), canary=True, run="r1"):
    return {"run_id": run, "generated_at": "2026-11-20T12:00:00+00:00", "rooms": rooms,
            "canary": {"target_key": "c", "passed": canary, "code": "OK" if canary else "NAV_TIMEOUT"},
            "summary": {"total": len(rooms), "live": 1, "offline": 0, "abnormal": 0, "circuit_open_groups": list(open_groups)}}


def test_event_types():
    before = snap([room("a", "OFFLINE", "offline"), room("b", price=10.0), room("c", words=["TCL"]), room("d")])
    after = snap([room("a"), room("b", price=12.5), room("c", words=["TCL", "空调"]),
                  room("d", "CAPTCHA_X5SEC", "unknown")], open_groups=["ali:group_1"], canary=False)
    events = {(e["type"], e["key"]): e for e in compute_events(before, after)}
    assert ("NEW_LIVE", "a") in events
    assert events[("PRICE_CHANGE", "b")]["value"] == "10.0->12.5"
    assert events[("KEYWORD_HIT", "c")]["value"] == "空调"
    assert ("CAPTCHA", "d") in events and ("CIRCUIT_OPEN", "ali:group_1") in events
    assert ("CANARY_FAILED", "c") in events


def test_unchanged_snapshot_produces_no_events():
    current = snap([room("a", price=10.0, words=["TCL"])])
    assert compute_events(current, current) == []
    assert [e["type"] for e in compute_events(None, current)] == ["NEW_LIVE", "KEYWORD_HIT"]


def test_ledger_dedupes_within_window_and_persists(tmp_path):
    events = compute_events(None, snap([room("a")]))
    ledger = NotifyLedger(tmp_path / "ledger.json", window_hours=12)
    assert ledger.fresh(events, NOW) == events
    ledger.mark(events, NOW)
    ledger.save()
    again = NotifyLedger(tmp_path / "ledger.json", window_hours=12)
    assert again.fresh(events, NOW + timedelta(hours=1)) == []
    assert again.fresh(events, NOW + timedelta(hours=13)) == events


def test_merged_message_lists_every_event_once():
    events = compute_events(None, snap([room("a"), room("b")]))
    title, text = build_message(events, snap([room("a"), room("b")]))
    assert "2 条变化" in title and text.count("【新开播】") == 2 and "批次 r1" in text


def test_payload_formats_and_signatures():
    url, body, _ = build_request("dingtalk", "https://oapi.dingtalk.com/robot/send?access_token=T", "t", "x",
                                 secret="SEC", now=1_700_000_000.0)
    query = parse_qs(urlsplit(url).query)
    expected = base64.b64encode(hmac.new(b"SEC", b"1700000000000\nSEC", hashlib.sha256).digest()).decode()
    assert query["timestamp"] == ["1700000000000"] and unquote(query["sign"][0]) == expected
    assert json.loads(body) == {"msgtype": "text", "text": {"content": "t\nx"}}
    _, body, _ = build_request("feishu", "https://open.feishu.cn/open-apis/bot/v2/hook/H", "t", "x", secret="SEC", now=1_700_000_000.0)
    data = json.loads(body)
    assert data["msg_type"] == "text" and data["timestamp"] == "1700000000"
    assert data["sign"] == base64.b64encode(hmac.new(b"1700000000\nSEC", digestmod=hashlib.sha256).digest()).decode()
    _, body, _ = build_request("wecom", "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=K", "t", "x")
    assert json.loads(body)["msgtype"] == "text"
    _, body, _ = build_request("bark", "https://api.day.app/KEY", "t", "x")
    assert json.loads(body) == {"title": "t", "body": "x", "group": "tcl-live-monitor"}
    assert [detect_kind(u) for u in ("https://oapi.dingtalk.com/r", "https://open.larksuite.com/h",
                                     "https://qyapi.weixin.qq.com/w", "https://api.day.app/k")] == ["dingtalk", "feishu", "wecom", "bark"]


def test_send_reports_status_without_leaking_the_url():
    calls = []

    def transport(url, data, headers):
        calls.append(url)
        return 200, b'{"errcode":0}'

    env = {"WEBHOOK_URL": "https://oapi.dingtalk.com/robot/send?access_token=SECRET_TOKEN"}
    result = send("t", "x", env, transport)
    assert result == {"status": "sent", "kind": "dingtalk", "http": 200} and len(calls) == 1
    assert "SECRET_TOKEN" not in json.dumps(result)
    assert send("t", "x", {}, transport) == {"status": "not_configured"}
    assert send("t", "x", {"WEBHOOK_URL": "http://insecure.example/x", "WEBHOOK_KIND": "wecom"}, transport)["status"] == "config_error"

    def broken(url, data, headers):
        raise OSError("connection reset by https://oapi.dingtalk.com/robot/send?access_token=SECRET_TOKEN")

    failure = send("t", "x", env, broken)
    assert failure == {"status": "transport_error", "error_type": "OSError"}


@pytest.mark.parametrize("raw,ok", [(b'{"errcode":0}', True), (b'{"errcode":310000}', False)])
def test_rejected_webhook_is_not_marked_sent(raw, ok):
    env = {"WEBHOOK_URL": "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=K"}
    assert (send("t", "x", env, lambda *a: (200, raw))["status"] == "sent") is ok
