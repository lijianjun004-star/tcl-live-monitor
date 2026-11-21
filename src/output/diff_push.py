"""Snapshot diff -> deduplicated, merged notification (SPEC.md section 9). Platform independent."""

from __future__ import annotations

import hashlib
import json
import os
from datetime import datetime, timedelta
from pathlib import Path

PLATFORM_LABEL = {"jd": "京东", "tmall": "天猫", "taobao": "淘宝"}
EVENT_LABEL = {"NEW_LIVE": "新开播", "PRICE_CHANGE": "改价", "KEYWORD_HIT": "命中关键词",
               "CIRCUIT_OPEN": "熔断", "CAPTCHA": "滑块/验证", "CANARY_FAILED": "对照失败"}
LEDGER_LIMIT = 2000


def _rooms(snapshot: dict | None) -> dict[str, dict]:
    return {room["target_key"]: room for room in (snapshot or {}).get("rooms", [])}


def compute_events(previous: dict | None, current: dict) -> list[dict]:
    before, events = _rooms(previous), []
    for key, room in _rooms(current).items():
        old = before.get(key, {})
        name = room.get("display_name") or key
        if room["live_status"] == "live" and old.get("live_status") != "live":
            events.append({"type": "NEW_LIVE", "key": key, "name": name, "platform": room["platform"],
                           "value": room.get("live_id") or "", "url": room.get("room_url")})
        new_price, old_price = room.get("item_price"), old.get("item_price")
        if room["code"] == "OK" and old.get("code") == "OK" and isinstance(new_price, (int, float)) \
                and isinstance(old_price, (int, float)) and new_price != old_price:
            events.append({"type": "PRICE_CHANGE", "key": key, "name": name, "platform": room["platform"],
                           "value": f"{old_price}->{new_price}", "url": room.get("room_url")})
        fresh_words = sorted(set(room.get("keywords_hit") or []) - set(old.get("keywords_hit") or []))
        if fresh_words:
            events.append({"type": "KEYWORD_HIT", "key": key, "name": name, "platform": room["platform"],
                           "value": ",".join(fresh_words), "url": room.get("room_url")})
        if room["code"] == "CAPTCHA_X5SEC" and old.get("code") != "CAPTCHA_X5SEC":
            events.append({"type": "CAPTCHA", "key": key, "name": name, "platform": room["platform"],
                           "value": room.get("reason") or "", "url": None})
    old_open = set(((previous or {}).get("summary") or {}).get("circuit_open_groups", []))
    for group in current["summary"]["circuit_open_groups"]:
        if group not in old_open:
            events.append({"type": "CIRCUIT_OPEN", "key": group, "name": group, "platform": group.split(":")[0],
                           "value": group, "url": None})
    canary, old_canary = current.get("canary") or {}, (previous or {}).get("canary") or {}
    if canary.get("passed") is False and old_canary.get("passed") is not False:
        events.append({"type": "CANARY_FAILED", "key": canary.get("target_key") or "canary", "name": "阳性对照",
                       "platform": "jd", "value": canary.get("code") or "", "url": None})
    return events


def fingerprint(event: dict) -> str:
    blob = json.dumps([event["type"], event["key"], event["value"]], ensure_ascii=False)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:32]


class NotifyLedger:
    """Fingerprints of events already pushed, so a repeat inside the window is skipped."""

    def __init__(self, path: Path, window_hours: float):
        self.path, self.window = path, timedelta(hours=window_hours)
        self.sent: dict[str, str] = {}
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(data, dict) and isinstance(data.get("sent"), dict):
                self.sent = {k: v for k, v in data["sent"].items() if isinstance(k, str) and isinstance(v, str)}
        except (OSError, ValueError):
            pass

    def fresh(self, events: list[dict], now: datetime) -> list[dict]:
        out = []
        for event in events:
            seen = self.sent.get(fingerprint(event))
            try:
                recent = seen is not None and now - datetime.fromisoformat(seen) < self.window
            except ValueError:
                recent = False
            if not recent:
                out.append(event)
        return out

    def mark(self, events: list[dict], now: datetime) -> None:
        for event in events:
            self.sent[fingerprint(event)] = now.isoformat(timespec="seconds")
        horizon = now - max(self.window, timedelta(hours=1)) * 2
        kept = {}
        for key, at in sorted(self.sent.items(), key=lambda item: item[1], reverse=True):
            try:
                if datetime.fromisoformat(at) >= horizon and len(kept) < LEDGER_LIMIT:
                    kept[key] = at
            except ValueError:
                continue
        self.sent = kept

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_name(self.path.name + ".tmp")
        temporary.write_text(json.dumps({"sent": self.sent}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.replace(temporary, self.path)


def build_message(events: list[dict], snapshot: dict) -> tuple[str, str]:
    summary = snapshot["summary"]
    title = f"TCL直播监控：{len(events)} 条变化"
    lines = [f"在播 {summary['live']} / 未播 {summary['offline']} / 异常 {summary['abnormal']} / 共 {summary['total']}"]
    for event in events[:30]:
        platform = PLATFORM_LABEL.get(event["platform"], event["platform"])
        line = f"【{EVENT_LABEL[event['type']]}】{platform} {event['name']}"
        if event["value"] and event["type"] != "NEW_LIVE":
            line += f"：{event['value']}"
        if event.get("url"):
            line += f"\n{event['url']}"
        lines.append(line)
    if len(events) > 30:
        lines.append(f"……另有 {len(events) - 30} 条")
    lines.append(f"批次 {snapshot['run_id']} · {snapshot['generated_at']}")
    return title, "\n".join(lines)
