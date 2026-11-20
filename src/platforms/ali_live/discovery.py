"""Tmall/Taobao discovery (B). anchor_entry needs no network; m.tb.cn links are an uncalibrated hook."""

from __future__ import annotations

import asyncio
import re
from collections import OrderedDict
from urllib.parse import parse_qsl, urlsplit

from core.base import DiscoveryEngine, RunContext
from core.config import Target
from core.errors import Code
from core.models import Resolution
from core.network import NetworkAudit, install_policy
from core.runtime import guarded

from .classifier import LIVE_PAGE, limit_url_kind, response_limit
from .policy import AliDiscoveryPolicy, ali_host
from .session import AliSession

ACCOUNT_ID = re.compile(r"^[0-9]{5,16}$")
# The verified live entry page. Other landing pages are reported by shape only.
VERIFIED_LANDING = ("h5.m.taobao.com", "/taolive/video.html")
# Query parameter names trusted to carry the anchor account id on the verified landing page.
# Extend only after a sanitized landing sample shows another name on that page.
SHORT_LINK_PARAM_HOOKS: tuple[str, ...] = ("userId",)
SENSITIVE_PARAM = re.compile(r"token|tk|sign|session|sid|cookie|ticket|secret|pass|uid|nick|phone|spm|scm|ut_sk", re.I)


def route_shape(url: str) -> dict:
    try:
        parts = urlsplit(url)
        host = (parts.hostname or "").lower()
    except ValueError:
        return {"host": "unparseable"}
    segments = [re.sub(r"[0-9]{3,}", "{n}", s) if re.fullmatch(r"[A-Za-z0-9_.{}-]{1,40}", s) else "{segment}"
                for s in parts.path.split("/")[1:8]]
    keys = sorted({k if not SENSITIVE_PARAM.search(k) and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,30}", k) else "{other}"
                   for k, _ in parse_qsl(parts.query[:4096], keep_blank_values=True)})[:20]
    return {"host": host if ali_host(host) else "other", "path": "/" + "/".join(segments), "query_keys": keys}


def account_from_landing(url: str) -> tuple[str | None, str]:
    try:
        parts = urlsplit(url)
        host = (parts.hostname or "").lower()
    except ValueError:
        return None, "landing_unparseable"
    if (host, parts.path) != VERIFIED_LANDING:
        return None, "landing_route_uncalibrated"
    values = {value for key, value in parse_qsl(parts.query[:4096]) if key in SHORT_LINK_PARAM_HOOKS}
    if len(values) != 1:
        return None, "landing_without_unique_account" if values else "landing_without_account"
    value = values.pop()
    return (value, "landing_account") if ACCOUNT_ID.fullmatch(value) else (None, "landing_account_invalid")


def grouped(targets: list[Target]) -> "OrderedDict[int, list[Target]]":
    groups: OrderedDict[int, list[Target]] = OrderedDict()
    for target in targets:
        groups.setdefault(target.account_group, []).append(target)
    return groups


class AliDiscovery(DiscoveryEngine):
    platforms = ("tmall", "taobao")

    def __init__(self, session: AliSession):
        self.session = session

    async def resolve_all(self, targets: list[Target], ctx: RunContext) -> dict[str, Resolution]:
        async def run_group(items: list[Target]) -> dict[str, Resolution]:
            out = {}
            for index, target in enumerate(items):
                out[target.key] = result = await self._guarded(target, ctx)
                if result.networked and index < len(items) - 1:
                    await asyncio.sleep(ctx.settings.limits.inter_room_delay_seconds)
            return out

        merged: dict[str, Resolution] = {}
        for part in await asyncio.gather(*(run_group(items) for items in grouped(targets).values())):
            merged.update(part)
        return merged

    async def _guarded(self, target: Target, ctx: RunContext) -> Resolution:
        mode_audit = {"cookie_mode": self.session.mode(target.account_group)}
        if target.mode == "anchor_entry":
            return Resolution(Code.OK, "anchor_entry", room_url=LIVE_PAGE + target.account_id,
                              verification="config", audit=mode_audit)
        if ctx.breaker.is_open(target.group_key):
            return Resolution.failure(Code.GROUP_CIRCUIT_OPEN, "group_circuit_open", networked=False, audit=mode_audit)
        result = await guarded(lambda: self.resolve_short_link(target, ctx), ctx.budget + 20,
                               lambda code, why: Resolution.failure(code, why, audit=mode_audit))
        result.audit.update(mode_audit)
        ctx.breaker.record(target.group_key, result.code, target_key=target.key, layer="discovery")
        return result

    async def resolve_short_link(self, target: Target, ctx: RunContext) -> Resolution:
        context = await self.session.context(ctx.browser, target.account_group)
        page = await context.new_page()
        policy = AliDiscoveryPolicy()
        audit = NetworkAudit(policy.name)
        state = {"limit": None, "http": None}

        def on_response(res):
            try:
                navigation = res.request.is_navigation_request() and res.request.frame == page.main_frame
                if navigation:
                    state["http"] = res.status
                denied = response_limit(res.url, res.status, navigation)
                if denied and not state["limit"]:
                    state["limit"] = "login" if res.status == 401 else "challenge"
            except Exception:
                pass

        page.on("response", on_response)
        await install_policy(page, policy, audit)
        loop = asyncio.get_running_loop()
        deadline = loop.time() + ctx.budget
        navigation_error = False
        try:
            try:
                await page.goto(target.short_link, wait_until="domcontentloaded",
                                timeout=int(max(3.0, ctx.budget - 2.0) * 1000))
            except Exception:
                navigation_error = True
            while loop.time() < deadline and not state["limit"]:
                kind = limit_url_kind(page.url)
                if kind:
                    state["limit"] = kind
                    break
                parts = urlsplit(page.url)
                if ((parts.hostname or "").lower(), parts.path) == VERIFIED_LANDING:
                    break
                await asyncio.sleep(0.5)
            final_url = page.url
        finally:
            await page.close()
        details = {"landing_route": route_shape(final_url), "http_status": state["http"],
                   "network": audit.report(), "calibrated": False}
        if state["limit"] == "login":
            return Resolution.failure(Code.LOGIN_REQUIRED, "login_redirect", audit=details)
        if state["limit"]:
            return Resolution.failure(Code.CAPTCHA_X5SEC, "platform_challenge", audit=details)
        account, why = account_from_landing(final_url)
        if account is None:
            if navigation_error and why in ("landing_route_uncalibrated", "landing_unparseable"):
                return Resolution.failure(Code.NAV_TIMEOUT, "navigation_timeout_or_error", audit=details)
            return Resolution.failure(Code.SCHEMA_MISMATCH, why, audit=details)
        if target.account_id and account != target.account_id:
            return Resolution.failure(Code.REDIRECTED, "short_link_identity_mismatch", audit=details)
        return Resolution(Code.OK, why, room_url=LIVE_PAGE + account, verification="entry_page",
                          networked=True, audit=details)
