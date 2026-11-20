"""JD monitor layer (A). Defect A fix around the unchanged legacy evidence rules.

Every state decision still comes from ``single_room_probe.public_detail`` /
``final_evidence`` (imported, not copied). Changes against legacy ``collect()``:

1. one shared Chromium per run, one fresh context per room (legacy: one browser per room);
2. a single room budget (default 12 s) instead of goto(25 s) + a fixed 7 x 1 s loop;
3. return early once an admitted ``getImmediatePlayToM`` response for this room arrived,
   after a short grace window for in-flight duplicates (conflicts stay detectable);
4. JdMonitorPolicy drops stream media and fonts (legacy dropped media only).
"""

from __future__ import annotations

import asyncio
import re

from playwright.async_api import Error as PlaywrightError

import single_room_probe as legacy
from core.base import MonitorEngine, RunContext
from core.canary import positive_live_control
from core.config import JD_GROUP, Target
from core.errors import DETERMINED_CODES, Code
from core.models import inherited_room, snapshot_room
from core.network import NetworkAudit, install_policy
from core.runtime import bounded_map, guarded

from .discovery import sku_control_verdict
from .policy import JdMonitorPolicy

GATE_REASONS = {"login_host", "gate_text_hit"}
LOGIN_TEXT = legacy.GATE_TEXT[:3]          # "京东登录注册", "账号密码登录", "请登录后观看"
CHALLENGE_TEXT = legacy.GATE_TEXT[3:]
GRACE_SECONDS = 0.75
POLL_SECONDS = 0.5
DIAGNOSTIC_FIELDS = ("page_loaded", "final_host", "final_path_redacted", "fragment_matched",
                     "final_fragment_shape", "route_mode", "body_text_len", "page_gate_reason",
                     "login_or_captcha_blocked", "room_id_matched", "snapshot_status", "app_prompt_cleanup",
                     "reasons", "evidence_endpoints", "diagnostics")


def gate_kind(page_gate_reason: str | None, visible_text: str, network_status: int | None,
              restricted: bool) -> str | None:
    if page_gate_reason == "login_host":
        return "login"
    if page_gate_reason == "gate_text_hit":
        if any(word in visible_text for word in CHALLENGE_TEXT):
            return "challenge"
        return "login" if any(word in visible_text for word in LOGIN_TEXT) else "challenge"
    if network_status == 401:
        return "login"
    if network_status in (403, 429):
        return "access"
    if restricted:
        return "restricted"
    return None


def map_jd_result(result: dict, kind: str | None) -> tuple[Code, str]:
    """Legacy result fields -> unified code (SPEC.md 3.1). Pure; unit tested offline."""
    reasons = result.get("reasons") or []
    diag = result.get("diagnostics") or {}
    status = result.get("live_status")
    if "invalid_room_url" in reasons:
        return Code.SCHEMA_MISMATCH, "invalid_room_url"
    if result.get("login_or_captcha_blocked"):
        if kind == "login":
            return Code.LOGIN_REQUIRED, "login_wall"
        if kind == "restricted":
            return Code.LOGIN_REQUIRED, "restricted_room"
        if kind == "access":
            return Code.CAPTCHA_X5SEC, "http_access_restriction"
        return Code.CAPTCHA_X5SEC, "challenge"
    if result.get("page_gate_reason") == "url_or_fragment_changed":
        return Code.REDIRECTED, "url_or_fragment_changed"
    if result.get("room_id_matched") and result.get("page_loaded"):
        if status == "live":
            return Code.OK, "detail_live"
        if status in ("offline", "replay"):
            return Code.OFFLINE, "detail_" + status
    if "conflicting_detail_states" in reasons:
        return Code.SCHEMA_MISMATCH, "conflicting_detail_states"
    if result.get("room_id_matched") and status == "unknown" and result.get("page_loaded"):
        return Code.SCHEMA_MISMATCH, "unrecognized_detail_status"
    if diag.get("target_room_mismatch_count") and not result.get("room_id_matched"):
        return Code.REDIRECTED, "room_mismatch"
    if diag.get("target_schema_mismatch_count"):
        return Code.SCHEMA_MISMATCH, "detail_schema_mismatch"
    if result.get("page_gate_reason") == "empty_body":
        return Code.NAV_TIMEOUT, "empty_body"
    if "navigation_timeout_or_error" in reasons:
        return Code.NAV_TIMEOUT, "navigation_timeout_or_error"
    return Code.NAV_TIMEOUT, "signal_not_observed_within_budget"


async def visible_text(page) -> str:
    title, body = "", ""
    try:
        title = await asyncio.wait_for(page.title(), timeout=1.5)
    except (PlaywrightError, asyncio.TimeoutError):
        pass
    try:
        body = await page.locator("body").inner_text(timeout=1500)
    except PlaywrightError:
        pass
    return f"{title}\n{body or ''}"


async def wait_for_signal(page, room_id: str, signal: asyncio.Event, state: dict, deadline: float,
                          gate_check=legacy.gate_state) -> bool:
    """Poll gates until a matched detail arrives, a gate shows, or the budget ends.

    Returns whether a visible gate was seen. Pure control flow; tested with fakes.
    """
    loop = asyncio.get_running_loop()
    while True:
        gate = await gate_check(page, room_id)
        if gate["page_gate_reason"] in GATE_REASONS:
            return True
        if state["network_blocked"]:
            return False
        if signal.is_set():
            await asyncio.sleep(max(0.0, min(GRACE_SECONDS, deadline - loop.time())))
            return False
        remaining = deadline - loop.time()
        if remaining <= 0:
            return False
        try:
            await asyncio.wait_for(signal.wait(), timeout=min(POLL_SECONDS, remaining))
        except asyncio.TimeoutError:
            pass


class JdLiveMonitor(MonitorEngine):
    platforms = ("jd",)

    def __init__(self, block_images: bool = False):
        self.block_images = block_images

    async def monitor_all(self, pairs: list[tuple[Target, dict]], ctx: RunContext) -> dict[str, dict]:
        results: dict[str, dict] = {}
        for target, resolved in [p for p in pairs if p[0].canary]:
            results[target.key] = await self._guarded_room(target, resolved, ctx)
        rest = [p for p in pairs if not p[0].canary]
        rooms = await bounded_map(rest, ctx.settings.limits.max_concurrency,
                                  lambda pair: self._guarded_room(pair[0], pair[1], ctx))
        for (target, _), room in zip(rest, rooms):
            results[target.key] = room
        self._attach_sku_verdicts(pairs, results, ctx)
        return results

    def _attach_sku_verdicts(self, pairs, results, ctx) -> None:
        canary = ctx.settings.canary
        legacy_result = ctx.legacy_results.get(canary.key) if canary else None
        control_id = legacy_result.get("room_id") if legacy_result else None
        positive = bool(legacy_result and positive_live_control(legacy_result))
        for target, resolved in pairs:
            if target.mode != "sku_discover":
                continue
            audit = resolved.get("audit") or {}
            verdict = sku_control_verdict(audit.get("sku_id"), control_id, positive, audit.get("candidate_ids", []),
                                          audit.get("prior_candidate_ids", []),
                                          bool((audit.get("h5") or {}).get("limits_reached")),
                                          bool(audit.get("loaded_product_page")))
            results[target.key]["diagnostics"]["sku_control_verdict"] = verdict

    async def _guarded_room(self, target: Target, resolved: dict, ctx: RunContext) -> dict:
        keywords = ctx.settings.keywords
        if not resolved.get("room_url"):
            return inherited_room(target, resolved, keywords=keywords)
        if ctx.breaker.is_open(JD_GROUP):
            return inherited_room(target, resolved, Code.GROUP_CIRCUIT_OPEN, "group_circuit_open", keywords)

        def failed(code, reason):
            return snapshot_room(target, resolved, code=code, reason=reason, keywords=keywords,
                                 diagnostics={"budget_seconds": ctx.budget})

        room = await guarded(lambda: self.observe_room(target, resolved, ctx), ctx.budget + 25, failed)
        ctx.breaker.record(JD_GROUP, room["code"], target_key=target.key, layer="monitor")
        return room

    async def observe_room(self, target: Target, resolved: dict, ctx: RunContext) -> dict:
        url, room_id = legacy.canonical_room(resolved["room_url"])
        result = legacy.initial_result(room_id)
        thumb = ctx.thumbnail_path(target) if ctx.settings.thumbnails else None
        timing = await self._collect(ctx.browser, url, room_id, thumb, result, ctx.budget)
        result["generated_at"] = legacy.timestamp()
        if target.canary:
            ctx.legacy_results[target.key] = result
        code, reason = map_jd_result(result, timing["gate_kind"])
        determined = code in DETERMINED_CODES
        diagnostics = {name: result.get(name) for name in DIAGNOSTIC_FIELDS}
        diagnostics.update(budget_seconds=ctx.budget, early_return=timing["early_return"],
                           navigation_ms=timing["navigation_ms"], network=timing["network"])
        return snapshot_room(
            target, resolved, code=code, reason=reason,
            live_status=result["live_status"] if determined else None,
            observed_at=result["generated_at"], elapsed_ms=timing["elapsed_ms"], detect_ms=timing["detect_ms"],
            live_id=room_id, online_count=result.get("online_count"), item_title=result.get("item_title"),
            item_price=result.get("item_price"),
            thumbnail=f"thumbs/{target.key}.jpg" if result.get("snapshot_status") == "saved" else None,
            diagnostics=diagnostics, keywords=ctx.settings.keywords,
        )

    async def _collect(self, factory, url: str, room_id: str, thumb_path, result: dict, budget: float) -> dict:
        """Legacy collect() handlers with the V2 budget, early return and monitor policy."""
        loop = asyncio.get_running_loop()
        started = loop.time()
        deadline = started + budget
        sources, records, tasks = set(), [], []
        diagnostics = legacy.ProbeDiagnostics()
        counters = {"responses": 0, "live_detail": 0, "frames": 0}
        state = {"network_blocked": False, "network_status": None, "accepting": True, "detect_at": None}
        signal = asyncio.Event()
        policy = JdMonitorPolicy(block_images=self.block_images)
        audit = NetworkAudit(policy.name)
        timing = {"elapsed_ms": 0, "detect_ms": None, "navigation_ms": None, "early_return": False,
                  "gate_kind": None, "network": {}}

        async def inspect_response(response, seq, target, eligible_probe, inspect_live_detail):
            payload = None
            read_body = False
            try:
                length = response.headers.get("content-length", "")
                if re.fullmatch(r"\d{1,12}", length) and int(length) > legacy.MAX_BODY:
                    return
                body = await asyncio.wait_for(response.body(), timeout=3)
                if len(body) > legacy.MAX_BODY:
                    return
                read_body = True
                payload = legacy.decode_json(body.decode("utf-8"))
                if inspect_live_detail:
                    outcome, keys = legacy.live_detail_key_observation(payload, room_id)
                    diagnostics.live_detail_outcomes.add(outcome)
                    diagnostics.live_detail_keys.update(keys)
                if not eligible_probe or not isinstance(payload, (dict, list)):
                    return
                sources.add(legacy.source_label(response.url))
                match = legacy.public_detail(response.request, payload, room_id) if response.url == response.request.url else None
                if match is not None:
                    records.append((seq, match))
                    if target and "state" in match:
                        diagnostics.accepted_detail(response.request, payload["data"])
                    if state["detect_at"] is None:
                        state["detect_at"] = loop.time()
                    signal.set()
            except (ValueError, asyncio.TimeoutError, PlaywrightError):
                return
            finally:
                if inspect_live_detail and not read_body:
                    diagnostics.live_detail_outcomes.add("body_unavailable")
                if target and (read_body or not 200 <= response.status < 300):
                    diagnostics.finish(response.request, legacy.diagnose_target(response.status, payload, room_id))

        def on_request(request):
            if state["accepting"]:
                diagnostics.register(request)

        def on_response(response):
            if not state["accepting"] or not legacy.eligible(response.url):
                return
            target = diagnostics.register(response.request)
            if legacy.is_network_gate(response):
                state["network_blocked"] = True
                state["network_status"] = state["network_status"] or response.status
                signal.set()
            mime = response.headers.get("content-type", "").split(";", 1)[0].strip().lower()
            json_mime = legacy.mime_category(mime) in {"json", "javascript"}
            eligible_probe = 200 <= response.status < 300 and counters["responses"] < legacy.MAX_RESPONSES and json_mime
            inspect_live_detail = False
            ids, _ = legacy.request_function_ids(response.request)
            if legacy.LIVE_DETAIL_FUNCTION in ids and counters["live_detail"] < legacy.MAX_LIVE_DETAIL_RESPONSES:
                counters["live_detail"] += 1
                if response.url != response.request.url or legacy.detail_request_rejection(
                    response.request, legacy.LIVE_DETAIL_FUNCTION
                ) is not None:
                    diagnostics.live_detail_outcomes.add("request_not_admitted")
                elif (http_outcome := legacy.live_detail_http_outcome(response.status)) is not None:
                    diagnostics.live_detail_outcomes.add(http_outcome)
                elif not json_mime:
                    diagnostics.live_detail_outcomes.add("mime_not_admitted")
                else:
                    inspect_live_detail = True
            if target:
                diagnostics.sample_response(response, mime, eligible_probe, counters["responses"])
            if eligible_probe:
                counters["responses"] += 1
            if target or eligible_probe or inspect_live_detail:
                tasks.append(asyncio.create_task(inspect_response(
                    response, counters["responses"], target, eligible_probe, inspect_live_detail)))

        def on_socket(socket):
            if not legacy.eligible(socket.url):
                return

            def on_frame(frame):
                if not state["accepting"] or counters["frames"] >= legacy.MAX_FRAMES or not isinstance(frame, str):
                    return
                counters["frames"] += 1
                if len(frame) <= legacy.MAX_BODY and isinstance(legacy.decode_json(frame), (dict, list)):
                    sources.add(legacy.source_label(socket.url))

            socket.on("framereceived", on_frame)

        context = await factory.new_context("jd_live_desktop")
        try:
            page = await context.new_page()
            page.on("request", on_request)
            page.on("response", on_response)
            page.on("websocket", on_socket)
            await install_policy(page, policy, audit)
            try:
                await page.goto(url, wait_until="domcontentloaded", timeout=int(max(3.0, budget - 2.0) * 1000))
            except PlaywrightError:
                result["reasons"].append("navigation_timeout_or_error")
            timing["navigation_ms"] = int((loop.time() - started) * 1000)
            visible_gate = await wait_for_signal(page, room_id, signal, state, deadline)
            timing["early_return"] = signal.is_set() and loop.time() < deadline
            state["accepting"] = False
            if tasks:
                await asyncio.wait(tasks, timeout=5)
            gate = await legacy.gate_state(page, room_id)
            result.update(gate)
            blocked = visible_gate or gate["page_gate_reason"] in GATE_REASONS or state["network_blocked"]
            ordered = [record for _, record in sorted(records, key=lambda pair: pair[0])]
            legacy.final_evidence(result, ordered, blocked)
            result["page_loaded"] = gate["page_gate_reason"] == "ok" and not result["login_or_captcha_blocked"]
            result["evidence_endpoints"] = sorted(sources)[:15]
            if result["login_or_captcha_blocked"]:
                text = await visible_text(page) if gate["page_gate_reason"] == "gate_text_hit" else ""
                timing["gate_kind"] = gate_kind(gate["page_gate_reason"], text, state["network_status"],
                                                any(r.get("restricted") for r in ordered))
            timing["detect_ms"] = None if state["detect_at"] is None else int((state["detect_at"] - started) * 1000)
            await self._legacy_snapshot(page, room_id, thumb_path, result)
        finally:
            timing["elapsed_ms"] = int((loop.time() - started) * 1000)
            state["accepting"] = False
            for task in tasks:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            result["diagnostics"] = diagnostics.report()
            timing["network"] = audit.report()["counts"]
            await context.close()
        return timing

    @staticmethod
    async def _legacy_snapshot(page, room_id: str, thumb_path, result: dict) -> None:
        """The legacy snapshot block, verbatim apart from the output path and the opt-out."""
        if result["login_or_captcha_blocked"]:
            result["reasons"].append("login_or_access_gate")
            result["snapshot_status"] = "omitted_access_gate"
        elif thumb_path is None:
            result["snapshot_status"] = "disabled"
        elif result["page_loaded"] and result["room_id_matched"] and result["live_status"] != "unknown":
            try:
                result["app_prompt_cleanup"] = await legacy.dismiss_app_prompt(page)
                snapshot_gate = await legacy.gate_state(page, room_id)
                if snapshot_gate["page_gate_reason"] != "ok":
                    result["snapshot_status"] = "omitted_page_changed"
                    return
                thumb_path.parent.mkdir(parents=True, exist_ok=True)
                await legacy.snapshot(page, thumb_path)
                state = await legacy.gate_state(page, room_id)
                result.update(state)
                if state["page_gate_reason"] != "ok":
                    thumb_path.unlink(missing_ok=True)
                    result["snapshot_status"] = "omitted_page_changed"
                    result["page_loaded"] = False
                    result["login_or_captcha_blocked"] = state["page_gate_reason"] in GATE_REASONS
                    result["live_status"] = "unknown"
                    for key in ("online_count", "item_title", "item_price"):
                        result[key] = None
                else:
                    result["snapshot_status"] = "saved"
            except (OSError, PlaywrightError):
                thumb_path.unlink(missing_ok=True)
                result["snapshot_status"] = "screenshot_failed"
        else:
            result["snapshot_status"] = "omitted_unverified_page"
        if not result["room_id_matched"]:
            result["reasons"].append("no_independent_room_match")
