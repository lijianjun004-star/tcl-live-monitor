"""Load the target list from the V2_TARGETS_JSON secret (or a file) and validate it."""

from __future__ import annotations

import hashlib
import json
import os
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Mapping

from .contracts import problems

ALI_PLATFORMS = frozenset({"tmall", "taobao"})
JD_GROUP = "jd:anonymous"
IDENTITY_FIELDS = ("platform", "mode", "live_id", "short_link", "short_link_role", "sku_id",
                   "shop_id", "vender_id", "account_id", "room_number", "account_group")


class ConfigError(ValueError):
    """The target list is missing or invalid. Messages never echo secret values."""


@dataclass(frozen=True)
class Limits:
    max_targets: int = 20
    max_concurrency: int = 4
    per_group_max: int = 7
    room_budget_seconds: float = 12.0
    inter_room_delay_seconds: float = 3.0
    jd_circuit_breaker: bool = True
    cache_stale_hours: float = 72.0


@dataclass(frozen=True)
class Target:
    key: str
    platform: str
    mode: str
    display_name: str | None = None
    canary: bool = False
    live_id: str | None = None
    short_link: str | None = None
    short_link_role: str | None = None
    sku_id: str | None = None
    shop_id: str | None = None
    vender_id: str | None = None
    account_id: str | None = None
    room_number: str | None = None
    account_group: int | None = None

    @property
    def is_ali(self) -> bool:
        return self.platform in ALI_PLATFORMS

    @property
    def group_key(self) -> str:
        return f"ali:group_{self.account_group}" if self.is_ali else JD_GROUP

    def fingerprint(self) -> str:
        identity = {name: getattr(self, name) for name in IDENTITY_FIELDS}
        blob = json.dumps(identity, sort_keys=True, separators=(",", ":")).encode("utf-8")
        return hashlib.sha256(blob).hexdigest()


@dataclass(frozen=True)
class Settings:
    targets: tuple[Target, ...]
    limits: Limits = field(default_factory=Limits)
    keywords: tuple[str, ...] = ()
    thumbnails: bool = True
    notify_dedupe_hours: float = 12.0

    @property
    def canary(self) -> Target | None:
        return next((target for target in self.targets if target.canary), None)


def parse_settings(document: object) -> Settings:
    found = problems("targets", document)
    if found:
        raise ConfigError("Target list violates schemas/targets.schema.json: " + "; ".join(found[:8]))
    assert isinstance(document, dict)
    limits = Limits(**document.get("limits", {}))
    targets = tuple(Target(**item) for item in document["targets"])
    keys = Counter(target.key for target in targets)
    if any(count > 1 for count in keys.values()):
        raise ConfigError("Target keys must be unique")
    if len(targets) > limits.max_targets:
        raise ConfigError(f"At most {limits.max_targets} targets are allowed")
    if sum(target.canary for target in targets) > 1:
        raise ConfigError("At most one canary target is allowed")
    groups = Counter(target.account_group for target in targets if target.is_ali)
    if any(count > limits.per_group_max for count in groups.values()):
        raise ConfigError(f"Each account_group may hold at most {limits.per_group_max} rooms")
    direct = Counter(t.live_id for t in targets if t.platform == "jd" and t.live_id)
    if any(count > 1 for count in direct.values()):
        raise ConfigError("JD live_id values must be unique")
    output = document.get("output", {})
    return Settings(
        targets=targets,
        limits=limits,
        keywords=tuple(document.get("keywords", ())),
        thumbnails=bool(output.get("thumbnails", True)),
        notify_dedupe_hours=float(output.get("notify_dedupe_hours", 12.0)),
    )


def load_settings(path: Path | None = None, env: Mapping[str, str] | None = None) -> Settings:
    env = os.environ if env is None else env
    raw = env.get("V2_TARGETS_JSON", "").strip()
    if raw:
        source = "V2_TARGETS_JSON"
    elif path is not None:
        raw, source = path.read_text(encoding="utf-8"), str(path)
    else:
        raise ConfigError("Provide V2_TARGETS_JSON or --targets")
    try:
        document = json.loads(raw)
    except ValueError as error:
        raise ConfigError(f"{source} is not valid JSON (line {getattr(error, 'lineno', '?')})") from None
    return parse_settings(document)
