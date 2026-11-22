"""Engine interfaces and the per-run context handed to every platform."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path

from .breaker import GroupCircuitBreaker
from .config import Settings, Target
from .models import Resolution


@dataclass
class RunContext:
    settings: Settings
    breaker: GroupCircuitBreaker
    evidence_dir: Path
    run_id: str = "local"
    browser: object | None = None   # core.browser.BrowserFactory, or None for offline engines
    legacy_results: dict = field(default_factory=dict)  # target_key -> legacy JD probe result (canary)
    human: object | None = None     # core.human_verify.HumanVerifier when a person may finish challenges

    @property
    def budget(self) -> float:
        return float(self.settings.limits.room_budget_seconds)

    def thumbnail_path(self, target: Target) -> Path:
        return self.evidence_dir / "thumbs" / f"{target.key}.jpg"


class DiscoveryEngine(ABC):
    """Layer B. Returns one raw Resolution per target; the runner applies cache degradation."""

    platforms: tuple[str, ...] = ()

    @abstractmethod
    async def resolve_all(self, targets: list[Target], ctx: RunContext) -> dict[str, Resolution]:
        raise NotImplementedError

    async def close(self) -> None:
        return None


class MonitorEngine(ABC):
    """Layer A. Consumes validated resolved rooms and returns snapshot room dicts."""

    platforms: tuple[str, ...] = ()

    @abstractmethod
    async def monitor_all(self, pairs: list[tuple[Target, dict]], ctx: RunContext) -> dict[str, dict]:
        raise NotImplementedError

    async def close(self) -> None:
        return None
