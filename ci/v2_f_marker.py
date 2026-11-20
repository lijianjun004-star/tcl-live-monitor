"""Validate a one-time feature-branch marker before a public F observation."""
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

BRANCH = "feat/v2-modular-architecture"
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


def main():
    if (os.getenv("GITHUB_REF") != "refs/heads/" + BRANCH or os.getenv("GITHUB_EVENT_NAME") != "push"
            or os.getenv("GITHUB_RUN_ATTEMPT") != "1"):
        sys.exit("F requires a first-attempt push on the reviewed feature branch.")
    phase, code = read_marker(os.environ["F_BEFORE"], os.environ["GITHUB_SHA"])
    if not in_window(phase, datetime.now(timezone.utc)):
        sys.exit("F marker was processed outside its observation window.")
    with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as out:
        out.write(f"phase={phase}\ncode_sha={code}\n")


if __name__ == "__main__":
    main()
