"""Offline compatibility fixtures for the signed F–H acceptance tests.

The retired observation policies are preserved for historical regression checks.
Callers supply recorded outcomes; there is no monitor, credential access or live entry point.
"""
import json
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path

from core.config import parse_settings

MARKERS = {f"ci/acceptance/f-20261121-{phase}.json": phase for phase in ("night", "day")}
WINDOWS = {
    "night": ("2026-11-20T18:00:00+00:00", "2026-11-20T21:30:00+00:00"),
    "day": ("2026-11-21T01:00:00+00:00", "2026-11-21T04:30:00+00:00"),
}


def in_window(phase, now):
    start, stop = WINDOWS[phase]
    return datetime.fromisoformat(start) <= now < datetime.fromisoformat(stop)


def git(*args):
    return subprocess.check_output(["git", *args], text=True).splitlines()


def read_marker(before, head):
    if not all(re.fullmatch(r"[a-f0-9]{40}", v or "") for v in (before, head)):
        raise ValueError("missing push ancestry")
    if git("rev-parse", "HEAD") != [head] or git("rev-parse", "HEAD^") != [before]:
        raise ValueError("expected one new feature commit")
    changes = git("diff", "--name-status", "--no-renames", before, head)
    if len(changes) != 1 or not changes[0].startswith("A\t"):
        raise ValueError("expected one newly added marker")
    path = changes[0][2:]
    if path not in MARKERS or Path(path).is_symlink() or Path(path).stat().st_size > 512:
        raise ValueError("invalid F marker")
    marker = json.loads(Path(path).read_text("utf-8"))
    phase = MARKERS[path]
    if (not isinstance(marker, dict) or set(marker) != {"phase", "code_sha"}
            or marker["phase"] != phase or not re.fullmatch(r"[a-f0-9]{40}", str(marker["code_sha"]))):
        raise ValueError("invalid marker phase or SHA")
    code = marker["code_sha"]
    git("merge-base", "--is-ancestor", code, before)
    between = git("rev-list", "--first-parent", f"{code}..{head}")
    # Both marker orders are allowed. The implementation and every other path stay pinned.
    if not 1 <= len(between) <= 2:
        raise ValueError("unreviewed feature history")
    seen = set()
    for commit in between:
        parents = git("rev-list", "--parents", "-n1", commit)[0].split()
        if len(parents) != 2:
            raise ValueError("expected a linear marker update")
        delta = git("diff", "--name-status", "--no-renames", parents[1], commit)
        if len(delta) != 1 or delta[0] not in {"A\t" + p for p in MARKERS} or delta[0] in seen:
            raise ValueError("only distinct added F markers may follow the reviewed SHA")
        seen.add(delta[0])
    return phase, code


NIGHT = ("tmall-group", "tmall-ac")
DAY = ("jd-canary", "jd-ac-sku")


def now():
    return datetime.now(timezone.utc)


def collect(result, document, *, observe, positive):
    phase = result["phase"]
    if not in_window(phase, now()):
        result["status"] = "window_expired_before_observation"
        return 0
    if phase == "night":
        result["observation_exit"] = observe(document, NIGHT, "observation")
        result["status"] = "observation_completed" if result["observation_exit"] == 0 else "runtime_error"
        return result["observation_exit"]
    canary = next(t["live_id"] for t in document["targets"] if t["key"] == "jd-canary")
    result["preflight_exit"] = observe(document, ("jd-canary",), "preflight", strict=True)
    result["preflight_positive"] = positive("preflight", canary)
    if result["preflight_exit"] not in (0, 3):
        result["status"] = "runtime_error"
        return result["preflight_exit"]
    if result["preflight_exit"] or not result["preflight_positive"]:
        result["status"] = "preflight_not_positive"
        return 0
    if not in_window("day", now()):
        result["status"] = "window_expired_after_preflight"
        return 0
    result["observation_exit"] = observe(document, DAY, "observation", strict=True)
    result["post_control_positive"] = positive("observation", canary)
    if result["observation_exit"] not in (0, 3):
        result["status"] = "runtime_error"
        return result["observation_exit"]
    result["status"] = "observation_completed" if result["post_control_positive"] else "post_control_not_positive"
    return 0


JD = {"jd-ac-sku": ("jd", "sku_discover", "100133134399", None)}
ALI = {"tmall-group": ("tmall", "anchor_entry", "2050532947", 1),
       "tmall-ac": ("tmall", "anchor_entry", "2098070993", 1)}


def diagnostic_targets(raw, include_tmall=False, *, tmall_only=False):
    document = json.loads(raw)
    expected = {**JD, **ALI} if include_tmall else JD
    if tmall_only:
        expected = ALI
    document["targets"] = [row for row in document["targets"] if row["key"] in expected]
    settings = parse_settings(document)
    actual = {t.key: (t.platform, t.mode, t.sku_id or t.account_id, t.account_group)
              for t in settings.targets}
    if actual != expected or settings.canary:
        raise ValueError("Unexpected diagnostic target configuration")
    return json.dumps(document, ensure_ascii=False)
