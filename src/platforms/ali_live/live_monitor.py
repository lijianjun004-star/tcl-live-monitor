"""Tmall/Taobao monitor (A): passive livedetail capture on the guest/cookie entry page.

Flow follows probes/r329/tmall-daily-once.mjs: mobile context, read only the livedetail JSON
the page itself requests, stop on any limit signal. "Stop the whole run" becomes "open this
group's breaker"; rooms in a group run one after another with a delay between them.
"""

from __future__ import annotations

import asyncio
import re
from urllib.parse import parse_qsl, urlsplit

from core.base import MonitorEngine, RunContext
from core.browser import masked_thumbnail
from core.config import Target
from core.errors import DETERMINED_CODES, Code
from core.models import inherited_room, snapshot_room
from core.network import NetworkAudit, install_policy
from core.runtime import guarded

from .classifier import (classify_tmall, endpoint_evidence, is_access_limit, is_live_detail_url,
                         limit_url_kind, map_sample, parse_json_or_jsonp, pick_best, response_limit,
                         LOGIN_LIMIT)
from .discovery import grouped
from .policy import AliMonitorPolicy
from .session import AliSession

GRACE_SECONDS = 0.5
MAX_SAMPLES = 12
# Heuristic gate words for the DOM fallback. Uncalibrated; they can only open a breaker,
# never establish LIVE or OFFLINE.
CHALLENGE_TEXT = ("滑块", "拖动", "验证码", "安全验证", "人机验证", "访问被拒绝")
LOGIN_TEXT = ("请登录", "登录后")


def api_tokens(sample: dict | None) -> list[str]:
    values = (sample or {}).get("apiRet") or []
    return [re.sub(r"[^A-Z0-9_]", "_", str(value).upper())[:60] for value in values][:3]


def account_from_room_url(url: str | None) -> str | None:
    try:
        values = [v for k, v in parse_qsl(urlsplit(url or "").query) if k == "userId"]
    except ValueError:
        return None
    return values[0] if len(values) == 1 and re.fullmatch(r"[0-9]{5,16}", values[0]) else None


def dom_gate(text: str) -> str | None:
    if any(word in text for word in CHALLENGE_TEXT):
        return "challenge"
    if len(text) < 850 and any(word in text for word in LOGIN_TEXT):
        return "login"
    return None


def limit_code(kind: str, why: str) -> tuple[Code, str]:
    return (Code.LOGIN_REQUIRED, why) if kind == "login" else (Code.CAPTCHA_X5SEC, why)


class AliLiveMonitor(MonitorEngine):
    platforms = ("tmall", "taobao")

    def __init__(self, session: AliSession, block_images: bool = False):
        self.session = session
        self.block_images = block_images

    async def close(self) -> None:
        await self.session.close()  # idempotent; both Ali engines share one session

    async def monitor_all(self, pairs: list[tuple[Target, dict]], ctx: RunContext) -> dict[str, dict]:
        lookup = {target.key: resolved for target, resolved in pairs}

        async def run_group(items: list[Target]) -> dict[str, dict]:
            out = {}
            for index, target in enumerate(items):
                room, networked = await self.room(target, lookup[target.key], ctx)
                out[target.key] = room
                if networked and index < len(items) - 1:
                    await asyncio.sleep(ctx.settings.limits.inter_room_delay_seconds)
            return out

        merged: dict[str, dict] = {}
        for part in await asyncio.gather(*(run_group(items) for items in grouped([t for t, _ in pairs]).values())):
            merged.update(part)
        return merged

    async def room(self, target: Target, resolved: dict, ctx: RunContext) -> tuple[dict, bool]:
        keywords = ctx.settings.keywords
        if not resolved.get("room_url"):
            return inherited_room(target, resolved, keywords=keywords), False
        if ctx.breaker.is_open(target.group_key):
            return inherited_room(target, resolved, Code.GROUP_CIRCUIT_OPEN, "group_circuit_open", keywords), False

        def failed(code, why):
            return snapshot_room(target, resolved, code=code, reason=why, keywords=keywords,
                                 diagnostics={"cookie_mode": self.session.mode(target.account_group)})

        room = await guarded(lambda: self.observe_room(target, resolved, ctx), ctx.budget + 20, failed)
        ctx.breaker.record(target.group_key, room["code"], target_key=target.key, layer="monitor")
        return room, True

    async def observe_room(self, target: Target, resolved: dict, ctx: RunContext) -> dict:
        identity = {"account_id": target.account_id or account_from_room_url(resolved["room_url"]),
                    "display_name": target.display_name, "room_number": target.room_number}
        context = await self.session.context(ctx.browser, target.account_group)
        page = await context.new_page()
        policy = AliMonitorPolicy(block_images=self.block_images)
        audit = NetworkAudit(policy.name)
        loop = asyncio.get_running_loop()
        started = loop.time()
        deadline = started + ctx.budget
        samples, pending, endpoints = [], [], []
        state = {"limit": None, "why": None, "http": None, "detect_at": None}
        signal = asyncio.Event()

        def stop(kind: str, why: str) -> None:
            if not state["limit"]:
                state["limit"], state["why"] = kind, why
            signal.set()

        async def read(res):
            try:
                sample = classify_tmall(parse_json_or_jsonp(await res.text()), identity)
            except Exception:
                sample = {"state": "UNKNOWN", "reason": "API_RESPONSE_PARSE_ERROR"}
            if len(samples) < MAX_SAMPLES:
                samples.append(sample)
            if is_access_limit(sample):
                login = any(LOGIN_LIMIT.search(str(x)) for x in sample.get("apiRet", []))
                stop("login" if login else "challenge", "api_need_login" if login else "api_access_limit")
            elif sample.get("state") in ("LIVE", "OFFLINE"):
                if state["detect_at"] is None:
                    state["detect_at"] = loop.time()
                signal.set()

        def on_response(res):
            try:
                navigation = res.request.is_navigation_request() and res.request.frame == page.main_frame
                if navigation:
                    state["http"] = res.status
                evidence = endpoint_evidence(res.url, res.status)
                if evidence and len(endpoints) < 30 and evidence not in endpoints:
                    endpoints.append(evidence)
                denied = response_limit(res.url, res.status, navigation)
                if denied:
                    stop("login" if res.status == 401 else "challenge", denied.lower())
                    return
                kind = limit_url_kind(res.url) if navigation else None
                if kind:
                    stop(kind, "login_redirect" if kind == "login" else "platform_challenge")
                    return
                if is_live_detail_url(res.url) and len(pending) < MAX_SAMPLES:
                    pending.append(asyncio.create_task(read(res)))
            except Exception:
                pass

        page.on("response", on_response)
        await install_policy(page, policy, audit)
        reasons, thumbnail = [], None
        try:
            try:
                await page.goto(resolved["room_url"], wait_until="domcontentloaded",
                                timeout=int(max(3.0, ctx.budget - 2.0) * 1000))
            except Exception:
                reasons.append("navigation_timeout_or_error")
            while not signal.is_set():
                kind = limit_url_kind(page.url)
                if kind:
                    stop(kind, "login_redirect" if kind == "login" else "platform_challenge")
                    break
                remaining = deadline - loop.time()
                if remaining <= 0:
                    break
                try:
                    await asyncio.wait_for(signal.wait(), timeout=min(0.25, remaining))
                except asyncio.TimeoutError:
                    pass
            if signal.is_set() and not state["limit"]:
                await asyncio.sleep(max(0.0, min(GRACE_SECONDS, deadline - loop.time())))
            if pending:
                await asyncio.wait(pending, timeout=4)
            if not state["limit"] and not samples:
                try:
                    text = await page.locator("body").inner_text(timeout=1500)
                except Exception:
                    text = ""
                kind = dom_gate(text or "")
                if kind:
                    stop(kind, "dom_" + kind)
            best = pick_best(samples)
            if state["limit"]:
                code, why = limit_code(state["limit"], state["why"])
            else:
                code, why = map_sample(best)
                if code is Code.NAV_TIMEOUT and reasons:
                    why = reasons[0]
            if code is Code.OK and ctx.settings.thumbnails:
                try:
                    await masked_thumbnail(page, ctx.thumbnail_path(target))
                    thumbnail = f"thumbs/{target.key}.jpg"
                except Exception:
                    reasons.append("screenshot_failed")
        finally:
            for task in pending:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*pending, return_exceptions=True)
            await page.close()
        elapsed = int((loop.time() - started) * 1000)
        detect = None if state["detect_at"] is None else int((state["detect_at"] - started) * 1000)
        determined = code in DETERMINED_CODES
        live_id = best.get("liveId") if best and code is Code.OK else None
        if live_id is not None and not re.fullmatch(r"[1-9][0-9]{4,23}", str(live_id)):
            live_id = None  # the classifier accepts leading zeros; the contract does not
        diagnostics = {
            "cookie_mode": self.session.mode(target.account_group),
            "http_status": state["http"], "responses": len(samples), "endpoints": endpoints,
            "classifier_reason": (best or {}).get("reason"), "api_ret": api_tokens(best),
            "identity_verified": bool(best and (best.get("state") in ("LIVE", "OFFLINE")
                                                or best.get("reason") in ("AMBIGUOUS_STATUS", "UNRECOGNIZED_STATUS"))),
            "offline_evidence": bool(best and best.get("offlineEvidence")), "offline_rule_validated": False,
            "source_start_time": best.get("sourceStartTime") if best and code is Code.OK else None,
            "reasons": reasons, "network": audit.report()["counts"], "budget_seconds": ctx.budget,
        }
        status = None
        if determined:
            status = "live" if code is Code.OK else "offline"
        return snapshot_room(target, resolved, code=code, reason=why, live_status=status, elapsed_ms=elapsed,
                             detect_ms=detect, live_id=live_id, thumbnail=thumbnail, diagnostics=diagnostics,
                             keywords=ctx.settings.keywords)
