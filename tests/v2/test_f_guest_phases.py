"""Fixed-window marker provenance and F guest phase admission without network."""
from datetime import datetime, timezone
import json
from pathlib import Path
import subprocess

import pytest

import archived_guest_policies as policy


@pytest.mark.parametrize(("phase", "hours", "expected"), [
    ("night", (20, 18, 0), True), ("night", (20, 21, 30), False),
    ("day", (21, 1, 0), True), ("day", (21, 4, 30), False),
])
def test_windows(phase, hours, expected):
    day, hour, minute = hours
    assert policy.in_window(phase, datetime(2026, 11, day, hour, minute, tzinfo=timezone.utc)) is expected


def test_only_unique_marker_additions_are_admitted(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)

    def git(*args):
        return subprocess.check_output(["git", *args], text=True).strip()

    git("init", "-q")
    git("config", "user.email", "test@example.invalid")
    git("config", "user.name", "Offline test")
    git("commit", "--allow-empty", "-qm", "reviewed code")
    code = git("rev-parse", "HEAD")

    def add(phase, other=None):
        before = git("rev-parse", "HEAD")
        p = Path(f"ci/acceptance/f-20261121-{phase}.json")
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps({"phase": phase, "code_sha": code}), encoding="utf-8")
        if other:
            Path(other).write_text("unexpected", encoding="utf-8")
        git("add", ".")
        git("commit", "-qm", phase)
        return before, git("rev-parse", "HEAD")

    before, night = add("night")
    assert policy.read_marker(before, night) == ("night", code)
    before, day = add("day")
    assert policy.read_marker(before, day) == ("day", code)
    git("reset", "--hard", "-q", code)
    before, day = add("day")
    assert policy.read_marker(before, day) == ("day", code)
    before, night = add("night", other="unreviewed-code")
    with pytest.raises(ValueError):
        policy.read_marker(before, night)


@pytest.mark.parametrize(("phase", "first", "second", "calls", "expected"), [
    ("night", True, True, [policy.NIGHT], "observation_completed"),
    ("day", False, True, [("jd-canary",)], "preflight_not_positive"),
    ("day", True, False, [("jd-canary",), policy.DAY], "post_control_not_positive"),
    ("day", True, True, [("jd-canary",), policy.DAY], "observation_completed"),
])
def test_observation_order_and_controls(monkeypatch, phase, first, second, calls, expected):
    result = {"phase": phase}
    observed = []
    monkeypatch.setattr(policy, "in_window", lambda phase, ts: True)

    def observe(document, keys, directory, *, strict=False):
        observed.append(keys)
        assert strict is (phase == "day")
        return 0

    def positive(directory, room):
        return first if directory == "preflight" else second

    assert policy.collect(result, {"targets": [{"key": "jd-canary", "live_id": "12345"}]},
                          observe=observe, positive=positive) == 0
    assert observed == calls and result["status"] == expected


def test_closed_window_makes_no_request(monkeypatch):
    monkeypatch.setattr(policy, "in_window", lambda phase, ts: False)
    def unexpected(*args, **kwargs):
        pytest.fail("unexpected observation outside the window")

    result = {"phase": "day"}
    assert policy.collect(result, {}, observe=unexpected, positive=unexpected) == 0
    assert result["status"] == "window_expired_before_observation"
