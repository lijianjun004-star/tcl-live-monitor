"""Policy-driven request interception. Each platform/layer brings its own NetworkPolicy."""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections import Counter
from dataclasses import dataclass, field
from typing import Awaitable, Callable
from urllib.parse import urlsplit

MAX_AUDITED_NAMES = 300


@dataclass(frozen=True)
class RequestInfo:
    url: str
    method: str = "GET"
    resource_type: str = "other"
    is_navigation: bool = False
    is_main_frame: bool = True
    post_data: str | None = None
    headers: dict = field(default_factory=dict)
    frame_url: str | None = None

    @property
    def parts(self):
        return urlsplit(self.url)

    @property
    def host(self) -> str:
        try:
            return (self.parts.hostname or "").lower()
        except ValueError:
            return ""

    @classmethod
    def from_playwright(cls, request) -> "RequestInfo":
        try:
            post = request.post_data
        except Exception:  # binary or undecodable bodies are treated as absent
            post = None
        try:
            frame = request.frame
            main = frame.parent_frame is None
            frame_url = frame.url
        except Exception:
            main, frame_url = False, None
        try:
            navigation = request.is_navigation_request()
        except Exception:
            navigation = False
        try:
            headers = dict(request.headers)
        except Exception:
            headers = {}
        return cls(url=request.url, method=request.method, resource_type=request.resource_type,
                   is_navigation=navigation, is_main_frame=main, post_data=post, headers=headers,
                   frame_url=frame_url)


@dataclass(frozen=True)
class Decision:
    allow: bool
    reason: str
    name: str | None = None          # functionId / MTOP api observed on the request
    category: str | None = None      # unsafe category when blocked by name
    gate: str | None = None          # login_wall | challenge when a gate navigation was seen
    known_read: bool | None = None   # name recognised by the verified read allow-list


class NetworkPolicy(ABC):
    """Pure request -> decision function. Must not perform I/O."""

    name = "abstract"

    @abstractmethod
    def decide(self, request: RequestInfo) -> Decision:
        raise NotImplementedError


class GateLatch(NetworkPolicy):
    """After the first gate decision every later request is blocked (verified probe behaviour)."""

    def __init__(self, inner: NetworkPolicy):
        self.inner = inner
        self.name = inner.name
        self.gate: str | None = None

    def decide(self, request: RequestInfo) -> Decision:
        if self.gate:
            return Decision(False, "gate_latched")
        decision = self.inner.decide(request)
        if decision.gate:
            self.gate = decision.gate
        return decision


class NetworkAudit:
    """Bounded, value-free record of what a policy allowed and blocked."""

    def __init__(self, policy_name: str):
        self.policy_name = policy_name
        self.counts: Counter = Counter()
        self.categories: Counter = Counter()
        self.attempted: set[str] = set()
        self.allowed: set[str] = set()
        self.blocked: set[str] = set()
        self.unknown_reads: set[str] = set()
        self.gate: str | None = None
        self.truncated = False

    def record(self, decision: Decision) -> None:
        self.counts[decision.reason] += 1
        if decision.gate and not self.gate:
            self.gate = decision.gate
        if decision.category:
            self.categories[decision.category] += 1
        name = decision.name
        if not name:
            return
        if name not in self.attempted and len(self.attempted) >= MAX_AUDITED_NAMES:
            self.truncated = True
            return
        self.attempted.add(name)
        (self.allowed if decision.allow else self.blocked).add(name)
        if decision.allow and decision.known_read is False:
            self.unknown_reads.add(name)

    @property
    def blocked_writes(self) -> int:
        return sum(count for reason, count in self.counts.items()
                   if reason in {"unsafe_function_blocked", "post_without_function_id",
                                 "non_api_write_blocked", "api_write_path_not_allowed"})

    def report(self) -> dict:
        return {
            "policy": self.policy_name,
            "counts": dict(sorted(self.counts.items())),
            "blocked_by_category": dict(sorted(self.categories.items())),
            "function_ids": {
                "attempted": sorted(self.attempted),
                "allowed": sorted(self.allowed),
                "blocked": sorted(self.blocked),
                "unknown_read": sorted(self.unknown_reads),
            },
            "truncated": self.truncated,
        }


AllowedHook = Callable[[object, RequestInfo, Decision], None]


async def install_policy(target, policy: NetworkPolicy, audit: NetworkAudit,
                         on_allowed: AllowedHook | None = None,
                         on_blocked: Callable[[RequestInfo, Decision], None] | None = None) -> Callable[..., Awaitable]:
    """Route every request of a Playwright page or context through ``policy``."""

    async def handler(route) -> None:
        request = route.request
        info = RequestInfo.from_playwright(request)
        try:
            decision = policy.decide(info)
        except Exception:
            decision = Decision(False, "policy_error")
        audit.record(decision)
        try:
            if decision.allow:
                if on_allowed:
                    on_allowed(request, info, decision)
                # fallback() == continue_() when no other handler matches; it also lets tests
                # layer a fulfilling route underneath without touching the policy.
                await route.fallback()
            else:
                if on_blocked:
                    on_blocked(info, decision)
                await route.abort("blockedbyclient")
        except Exception:
            # The page or context may close while an event is in flight.
            pass

    await target.route("**/*", handler)
    return handler
