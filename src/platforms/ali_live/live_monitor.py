"""Tmall/Taobao monitor (A): passive livedetail capture on the guest/cookie entry page.

Flow follows probes/r329/tmall-daily-once.mjs: mobile context, read only the livedetail JSON
the page itself requests. Login and challenge signals stop further access to the gated
resource. An optional product-list denial affects product fields only.
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
from core.network import GateLatch, NetworkAudit, install_policy
from core.runtime import guarded

from .business import business_report, business_sample, endpoint, request_live_id
from .calibration import livedetail_status_sample
from .classifier import (classify_tmall, endpoint_evidence, is_access_limit, is_live_detail_url,
                         limit_url_kind, map_sample, parse_json_or_jsonp, pick_best, response_limit,
                         LOGIN_LIMIT)
from .discovery import grouped
from .policy import MTOP_HOSTS, AliMonitorPolicy, mtop_api
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
        self._item_limits: dict[int, str] = {}

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
        if not resolved.get("room_url") or ctx.breaker.is_open(target.group_key):
            if not resolved.get("room_url"):
                room = inherited_room(target, resolved, keywords=keywords)
            else:
                room = inherited_room(target, resolved, Code.GROUP_CIRCUIT_OPEN, "group_circuit_open", keywords)
            room["diagnostics"]["business_evidence"] = business_report({}, None, room["reason"] or room["code"])[1]
            return room, False

        def failed(code, why):
            return snapshot_room(target, resolved, code=code, reason=why, keywords=keywords,
                                 diagnostics={"cookie_mode": self.session.mode(target.account_group),
                                              "business_evidence": business_report({}, None, why or code.value)[1]})

        human = getattr(ctx, "human", None)
        allowance = human.timeout_allowance if human is not None else 0
        room = await guarded(lambda: self.observe_room(target, resolved, ctx), ctx.budget + 20 + allowance, failed)
        ctx.breaker.record(target.group_key, room["code"], target_key=target.key, layer="monitor")
        return room, True

    async def _human_handoff(self, human, page, page_policy, state, signal, verifying, target) -> str:
        """Open the gated page for a person, then wait for a determined livedetail sample."""
        why = state["why"]
        page_policy.gate = None
        state.update(limit=None, why=None, page_gate=False)
        signal.clear()
        verifying[0] = True

        async def gate_present() -> bool:
            if limit_url_kind(page.url):
                return True
            try:
                text = await page.locator("body").inner_text(timeout=1000)
            except Exception:
                return True
            return dom_gate(text or "") == "challenge"

        try:
            try:
                # Requests after the latch were refused, so load the page and its challenge again once.
                await page.reload(wait_until="domcontentloaded", timeout=20000)
            except Exception:
                pass
            solved = await human.verify(page, label=target.display_name or target.key,
                                        solved=lambda: state["detect_at"] is not None,
                                        gate_present=gate_present, touch=True)
        except Exception:
            solved = False
        finally:
            verifying[0] = False
        if not solved:
            state["why"] = why
        return "solved" if solved else "not_solved"

    async def observe_room(self, target: Target, resolved: dict, ctx: RunContext) -> dict:
        identity = {"account_id": target.account_id or account_from_room_url(resolved["room_url"]),
                    "display_name": target.display_name, "room_number": target.room_number}
        context = await self.session.context(ctx.browser, target.account_group)
        page = await context.new_page()
        policy = AliMonitorPolicy(block_images=self.block_images)
        policy.block_itemlist = target.account_group in self._item_limits
        page_policy = GateLatch(policy)
        audit = NetworkAudit(policy.name)
        loop = asyncio.get_running_loop()
        started = loop.time()
        deadline = started + ctx.budget
        samples, pending, endpoints = [], [], []
        status_samples = []
        business = {"livedetail": [], "itemlist": []}
        item_tasks = []
        state = {"limit": None, "why": None, "page_gate": False, "http": None, "detect_at": None}
        human = getattr(ctx, "human", None)
        verifying = [False]
        signal = asyncio.Event()
        attached = [True]
        mtop = {"requests_allowed": 0, "requests_blocked": 0, "responses": 0}
        detail = {**mtop, "json_objects": 0, "read_or_parse_errors": 0}
        observation = {"navigation_attempted": False, "mtop": mtop, "livedetail_v4": detail}

        def count_endpoint(url: str, event: str) -> None:
            if not attached[0]:
                return
            try:
                parts = urlsplit(url)
                host = (parts.hostname or "").lower().rstrip(".")
            except ValueError:
                return
            if parts.scheme in {"http", "https"} and host in MTOP_HOSTS and mtop_api(parts.path):
                mtop[event] += 1
                if is_live_detail_url(url):
                    detail[event] += 1

        def stop(kind: str, why: str, *, page_gate=False) -> None:
            if verifying[0] and kind == "challenge":
                return  # a person is working on this challenge; keep the page's own requests open
            page_policy.gate = kind
            if page_gate or not state["limit"]:
                state["limit"], state["why"], state["page_gate"] = kind, why, page_gate
            signal.set()

        def stop_itemlist(why: str) -> None:
            policy.block_itemlist = True
            self._item_limits.setdefault(target.account_group, why)

        async def read_item(res):
            try:
                payload = parse_json_or_jsonp(await res.text())
            except Exception:
                payload = None
            if isinstance(payload, dict):
                gate = classify_tmall({"ret": payload.get("ret")}, identity)
                if is_access_limit(gate):
                    login = any(LOGIN_LIMIT.search(x) for x in gate["apiRet"])
                    stop_itemlist("api_need_login" if login else "api_access_limit")
            try:
                request_id = request_live_id(res.url, res.request.post_data)
            except Exception:
                request_id = None
            business["itemlist"].append(business_sample("itemlist", res.status, payload, request_id))

        async def read(res):
            payload = None
            try:
                payload = parse_json_or_jsonp(await res.text())
            except Exception:
                detail["read_or_parse_errors"] += 1
                sample = {"state": "UNKNOWN", "reason": "API_RESPONSE_PARSE_ERROR"}
            else:
                if isinstance(payload, dict):
                    detail["json_objects"] += 1
                    status_samples.append(livedetail_status_sample(payload, res.status, identity))
                try:
                    sample = classify_tmall(payload, identity)
                    if sample.get("state") in ("LIVE", "OFFLINE") and res.status != 200:
                        sample = {"state": "UNKNOWN", "reason": "HTTP_ERROR"}
                    if sample.get("state") == "LIVE" and not re.fullmatch(r"[1-9][0-9]{4,23}", sample["liveId"]):
                        sample = {"state": "UNKNOWN", "reason": "INVALID_LIVE_ID"}
                except Exception:
                    sample = {"state": "UNKNOWN", "reason": "API_RESPONSE_PARSE_ERROR"}
            business["livedetail"].append(business_sample("livedetail", res.status, payload, sample.get("liveId")
                                                           if sample.get("state") == "LIVE" else None))
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
                count_endpoint(res.url, "responses")
                navigation = res.request.is_navigation_request() and res.request.frame == page.main_frame
                if navigation:
                    state["http"] = res.status
                evidence = endpoint_evidence(res.url, res.status)
                if evidence and len(endpoints) < 30 and evidence not in endpoints:
                    endpoints.append(evidence)
                source = endpoint(res.url)
                if source == "itemlist" and not navigation and res.status in (401, 403, 429):
                    business[source].append(business_sample(source, res.status, None))
                    stop_itemlist(f"http_{res.status}")
                    return
                denied = response_limit(res.url, res.status, navigation)
                if denied:
                    if source:
                        business[source].append(business_sample(source, res.status, None))
                    stop("login" if res.status == 401 else "challenge", denied.lower(), page_gate=navigation)
                    return
                kind = limit_url_kind(res.url) if navigation else None
                if kind:
                    stop(kind, "login_redirect" if kind == "login" else "platform_challenge", page_gate=True)
                    return
                if source == "itemlist" and len(item_tasks) < MAX_SAMPLES:
                    item_tasks.append(asyncio.create_task(read_item(res)))
                if is_live_detail_url(res.url) and len(pending) < MAX_SAMPLES:
                    pending.append(asyncio.create_task(read(res)))
            except Exception:
                pass

        def detach() -> None:
            if attached[0]:
                attached[0] = False
                try:
                    page.remove_listener("response", on_response)
                except Exception:
                    pass

        page.on("response", on_response)
        await install_policy(
            page, page_policy, audit,
            on_allowed=lambda request, info, decision: count_endpoint(info.url, "requests_allowed"),
            on_blocked=lambda info, decision: count_endpoint(info.url, "requests_blocked"),
        )
        reasons, thumbnail = [], None
        try:
            try:
                observation["navigation_attempted"] = True
                await page.goto(resolved["room_url"], wait_until="domcontentloaded",
                                timeout=int(max(3.0, ctx.budget - 2.0) * 1000))
            except Exception:
                reasons.append("navigation_timeout_or_error")
            while not signal.is_set():
                kind = limit_url_kind(page.url)
                if kind:
                    stop(kind, "login_redirect" if kind == "login" else "platform_challenge", page_gate=True)
                    break
                remaining = deadline - loop.time()
                if remaining <= 0:
                    break
                try:
                    await asyncio.wait_for(signal.wait(), timeout=min(0.25, remaining))
                except asyncio.TimeoutError:
                    pass
            if human is not None and human.can_start() and pending and not state["limit"]:
                # Let already received livedetail answers report a challenge before deciding.
                await asyncio.wait(list(pending), timeout=4)
            if (human is not None and state["limit"] == "challenge" and state["detect_at"] is None
                    and human.can_start()):
                observation["human_verification"] = await self._human_handoff(
                    human, page, page_policy, state, signal, verifying, target)
                if observation["human_verification"] != "solved":
                    stop("challenge", state["why"] or "platform_challenge", page_gate=True)
            if signal.is_set() and not state["limit"]:
                await asyncio.sleep(max(0.0, min(GRACE_SECONDS, deadline - loop.time())))
            detach()
            if pending or item_tasks:
                _, unfinished = await asyncio.wait(pending + item_tasks, timeout=4)
                for task in unfinished:
                    task.cancel()
                await asyncio.gather(*unfinished, return_exceptions=True)
            if not state["limit"] and not samples:
                try:
                    text = await page.locator("body").inner_text(timeout=1500)
                except Exception:
                    text = ""
                kind = dom_gate(text or "")
                if kind:
                    stop(kind, "dom_" + kind, page_gate=True)
            best = pick_best(samples)
            code, why = map_sample(best)
            if state["page_gate"] or (state["limit"] and code not in DETERMINED_CODES):
                code, why = limit_code(state["limit"], state["why"])
            elif code is Code.NAV_TIMEOUT and reasons:
                why = reasons[0]
            if code is Code.OK and ctx.settings.thumbnails:
                try:
                    await masked_thumbnail(page, ctx.thumbnail_path(target))
                    thumbnail = f"thumbs/{target.key}.jpg"
                except Exception:
                    reasons.append("screenshot_failed")
        finally:
            detach()
            for task in pending + item_tasks:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*pending, *item_tasks, return_exceptions=True)
            await page.close()
        elapsed = int((loop.time() - started) * 1000)
        detect = None if state["detect_at"] is None else int((state["detect_at"] - started) * 1000)
        determined = code in DETERMINED_CODES
        live_id = best.get("liveId") if best and code is Code.OK else None
        fields, field_evidence = business_report(business, live_id, None if code is Code.OK else why,
                                                 item_limit=self._item_limits.get(target.account_group))
        diagnostics = {
            "business_evidence": field_evidence,
            "cookie_mode": self.session.mode(target.account_group),
            "passive_observation": observation,
            "livedetail_status_samples": status_samples,
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
                             keywords=ctx.settings.keywords, **fields)
