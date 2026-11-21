"""Group circuit breaker: one gate in a group stops every later request of that group."""

from __future__ import annotations

from .errors import TRIPPING_CODES, Code
from .timeutil import iso


class GroupCircuitBreaker:
    def __init__(self, enabled_groups: set[str] | None = None):
        # None means every group is protected; otherwise only the listed group keys.
        self._enabled = enabled_groups
        self._open: dict[str, dict] = {}

    def protects(self, group: str) -> bool:
        return self._enabled is None or group in self._enabled

    def is_open(self, group: str) -> bool:
        return group in self._open

    def record(self, group: str, code: Code | str, *, target_key: str, layer: str) -> bool:
        """Record a room outcome. Returns True when this outcome opened the group."""
        code = Code(code)
        if code not in TRIPPING_CODES or not self.protects(group) or group in self._open:
            return False
        self._open[group] = {"tripped_by": target_key, "code": code.value, "layer": layer, "at": iso()}
        return True

    def open_groups(self) -> list[str]:
        return sorted(self._open)

    def report(self) -> dict:
        return {group: dict(info) for group, info in sorted(self._open.items())}
