"""Deterministic offline engines for dry runs and tests. No browser, no network.

Scenario JSON (optional): ``{"<target_key>": {"discovery": {...}, "monitor": {...}}}`` where
discovery may set code/reason/live_id and monitor may set code/reason/live_status/online_count/
item_title/item_price. Unspecified rooms resolve and report LIVE. Breaker rules are applied
exactly as the real engines do (per-group sequential order, no request once a group is open).
"""

from __future__ import annotations

import hashlib
from collections import OrderedDict

from .base import DiscoveryEngine, MonitorEngine, RunContext
from .config import Target
from .errors import DETERMINED_CODES, TRIPPING_CODES, Code
from .models import Resolution, inherited_room, snapshot_room

JD_ROOM = "https://lives.jd.com/#/{}"
ALI_ROOM = "https://h5.m.taobao.com/taolive/video.html?userId={}"


def fake_id(key: str, digits: int = 11) -> str:
    number = int(hashlib.sha256(key.encode()).hexdigest(), 16)
    return "9" + str(number)[: digits - 1]


class FakeDiscovery(DiscoveryEngine):
    platforms = ("jd", "tmall", "taobao")

    def __init__(self, scenario: dict | None = None):
        self.scenario = scenario or {}
        self.calls: list[str] = []

    async def resolve_all(self, targets: list[Target], ctx: RunContext) -> dict[str, Resolution]:
        return {target.key: self._resolve(target, ctx) for target in targets}

    def _resolve(self, target: Target, ctx: RunContext) -> Resolution:
        plan = self.scenario.get(target.key, {}).get("discovery", {})
        if target.mode in ("direct", "anchor_entry") and (target.live_id or target.account_id) and not plan:
            if target.is_ali:
                return Resolution(Code.OK, "anchor_entry", room_url=ALI_ROOM.format(target.account_id), verification="config")
            return Resolution(Code.OK, "configured_live_id", live_id=target.live_id,
                              room_url=JD_ROOM.format(target.live_id), verification="config")
        if ctx.breaker.is_open(target.group_key):
            return Resolution.failure(Code.GROUP_CIRCUIT_OPEN, "group_circuit_open", networked=False)
        self.calls.append(target.key)
        code = Code(plan.get("code", "OK"))
        if code is not Code.OK:
            ctx.breaker.record(target.group_key, code, target_key=target.key, layer="discovery")
            return Resolution.failure(code, plan.get("reason", "fake_failure"))
        if target.is_ali:
            account = target.account_id or fake_id(target.key, 10)
            return Resolution(Code.OK, "fake_entry", room_url=ALI_ROOM.format(account),
                              verification="entry_page", networked=True)
        live_id = plan.get("live_id") or target.live_id or fake_id(target.key)
        verification = "candidate_unverified" if target.mode in ("sku_discover", "shop_discover") else "resolved_link"
        return Resolution(Code.OK, "fake_resolved", live_id=live_id, room_url=JD_ROOM.format(live_id),
                          verification=verification, networked=True)


class FakeMonitor(MonitorEngine):
    platforms = ("jd", "tmall", "taobao")

    def __init__(self, scenario: dict | None = None):
        self.scenario = scenario or {}
        self.calls: list[str] = []

    async def monitor_all(self, pairs: list[tuple[Target, dict]], ctx: RunContext) -> dict[str, dict]:
        groups: OrderedDict[str, list] = OrderedDict()
        for target, resolved in sorted(pairs, key=lambda pair: not pair[0].canary):
            groups.setdefault(target.group_key, []).append((target, resolved))
        out = {}
        for items in groups.values():
            for target, resolved in items:
                out[target.key] = self._room(target, resolved, ctx)
        return out

    def _room(self, target: Target, resolved: dict, ctx: RunContext) -> dict:
        keywords = ctx.settings.keywords
        if not resolved.get("room_url"):
            return inherited_room(target, resolved, keywords=keywords)
        if ctx.breaker.is_open(target.group_key):
            return inherited_room(target, resolved, Code.GROUP_CIRCUIT_OPEN, "group_circuit_open", keywords)
        self.calls.append(target.key)
        plan = self.scenario.get(target.key, {}).get("monitor", {})
        code = Code(plan.get("code", "OK"))
        status = plan.get("live_status", "live" if code is Code.OK else "offline" if code is Code.OFFLINE else None)
        live_id = resolved.get("live_id") or (fake_id(target.key, 12) if target.is_ali and code is Code.OK else None)
        room = snapshot_room(target, resolved, code=code, reason=plan.get("reason", "fake"),
                             live_status=status if code in DETERMINED_CODES else None, elapsed_ms=1200,
                             detect_ms=800 if code in DETERMINED_CODES else None, live_id=live_id,
                             online_count=plan.get("online_count"), item_title=plan.get("item_title"),
                             item_price=plan.get("item_price"), diagnostics={"engine": "fake"}, keywords=keywords)
        ctx.breaker.record(target.group_key, code, target_key=target.key, layer="monitor")
        if target.canary:
            ctx.legacy_results[target.key] = {
                "room_id": room["live_id"], "room_id_matched": code in DETERMINED_CODES,
                "page_loaded": code in DETERMINED_CODES, "login_or_captcha_blocked": code in TRIPPING_CODES,
                "live_status": room["live_status"], "generated_at": room["observed_at"],
                "page_gate_reason": "ok", "route_mode": "root", "reasons": [],
            }
        return room
