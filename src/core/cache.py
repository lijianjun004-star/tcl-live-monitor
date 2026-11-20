"""Last-known-good discovery cache. A failed discovery never clears an entry (SPEC.md section 8)."""

from __future__ import annotations

import json
import os
import re
from datetime import datetime
from pathlib import Path

from .config import Target
from .timeutil import iso, parse_iso, utcnow

SCHEMA_VERSION = "2.0"
ROOM_URL = re.compile(r"^https://(lives\.jd\.com/#/[1-9][0-9]{4,17}|h5\.m\.taobao\.com/taolive/video\.html\?userId=[0-9]{5,16})$")
PUBLIC_ID = re.compile(r"^[1-9][0-9]{4,23}$")
MAX_BYTES = 512 * 1024
VERIFICATIONS = {"config", "resolved_link", "candidate_unverified", "entry_page"}


class ResolvedCache:
    def __init__(self, path: Path, stale_hours: float = 72.0):
        self.path = path
        self.stale_hours = stale_hours
        self.entries: dict[str, dict] = {}
        self.load_problem: str | None = None
        self._load()

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            raw = self.path.read_bytes()
            if len(raw) > MAX_BYTES:
                raise ValueError("cache too large")
            document = json.loads(raw.decode("utf-8"))
            entries = document.get("entries") if isinstance(document, dict) else None
            if not isinstance(entries, dict):
                raise ValueError("cache has no entries")
        except (OSError, ValueError, UnicodeError, RecursionError):
            # Keep the unreadable file for inspection instead of overwriting it.
            self.load_problem = "cache_unreadable"
            backup = self.path.with_name(self.path.name + ".corrupt")
            try:
                os.replace(self.path, backup)
            except OSError:
                pass
            return
        for key, entry in entries.items():
            if self._valid(entry):
                self.entries[key] = entry

    @staticmethod
    def _valid(entry: object) -> bool:
        return (
            isinstance(entry, dict)
            and isinstance(entry.get("fingerprint"), str)
            and isinstance(entry.get("room_url"), str) and bool(ROOM_URL.fullmatch(entry["room_url"]))
            and (entry.get("live_id") is None or (isinstance(entry["live_id"], str) and bool(PUBLIC_ID.fullmatch(entry["live_id"]))))
            and parse_iso(entry.get("resolved_at")) is not None
        )

    def lookup(self, target: Target, now: datetime | None = None) -> dict | None:
        entry = self.entries.get(target.key)
        if not entry or entry["fingerprint"] != target.fingerprint():
            return None
        resolved = parse_iso(entry["resolved_at"])
        age = max(0, int(((now or utcnow()) - resolved).total_seconds()))
        return {**entry, "age_seconds": age, "stale": age > self.stale_hours * 3600}

    def store(self, target: Target, *, live_id: str | None, room_url: str, verification: str,
              at: str | None = None) -> None:
        if not ROOM_URL.fullmatch(room_url) or (live_id is not None and not PUBLIC_ID.fullmatch(live_id)):
            return
        previous = self.entries.get(target.key, {})
        self.entries[target.key] = {
            "fingerprint": target.fingerprint(),
            "platform": target.platform,
            "discovery_mode": target.mode,
            "live_id": live_id,
            "room_url": room_url,
            "resolved_at": at or iso(),
            "verification": verification if verification in VERIFICATIONS else "resolved_link",
            "last_live_id": previous.get("last_live_id") if previous.get("fingerprint") == target.fingerprint() else None,
        }

    def note_live_id(self, target: Target, live_id: str | None) -> None:
        entry = self.entries.get(target.key)
        if entry and entry["fingerprint"] == target.fingerprint() and live_id and PUBLIC_ID.fullmatch(live_id):
            entry["last_live_id"] = live_id

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_name(self.path.name + ".tmp")
        document = {"schema_version": SCHEMA_VERSION, "entries": dict(sorted(self.entries.items()))}
        temporary.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.replace(temporary, self.path)
