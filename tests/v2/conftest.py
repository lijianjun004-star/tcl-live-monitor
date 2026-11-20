"""Shared offline fixtures. No test in this suite opens a browser or the network."""

from __future__ import annotations

import json
import socket
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
EXAMPLE = ROOT / "config" / "targets.example.json"


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    """Fail loudly if any test tries to open a socket."""
    def guard(*args, **kwargs):
        raise AssertionError("offline test suite attempted a network connection")
    monkeypatch.setattr(socket.socket, "connect", guard)
    monkeypatch.setattr(socket, "create_connection", guard)


@pytest.fixture
def example_doc() -> dict:
    return json.loads(EXAMPLE.read_text(encoding="utf-8"))


@pytest.fixture
def make_settings(example_doc):
    from core.config import parse_settings

    def build(targets=None, **limits):
        doc = json.loads(json.dumps(example_doc))
        if targets is not None:
            doc["targets"] = targets
        doc.setdefault("limits", {}).update(limits)
        return parse_settings(doc)
    return build


@pytest.fixture
def ctx_factory(tmp_path):
    from core.base import RunContext
    from core.breaker import GroupCircuitBreaker

    def build(settings, protected=None):
        groups = protected if protected is not None else {t.group_key for t in settings.targets}
        return RunContext(settings=settings, breaker=GroupCircuitBreaker(set(groups)), evidence_dir=tmp_path / "ev")
    return build


def ali_target(key, group, platform="tmall", account="1234567", name="SYNTH"):
    return {"key": key, "platform": platform, "mode": "anchor_entry", "display_name": name,
            "account_id": account, "account_group": group}


def jd_target(key, live_id, canary=False):
    target = {"key": key, "platform": "jd", "mode": "direct", "display_name": key, "live_id": live_id}
    if canary:
        target["canary"] = True
    return target
