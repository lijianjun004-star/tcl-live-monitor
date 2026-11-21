"""Evidence pack writer, keeping the verified experiment's file conventions."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Iterable, Mapping


def write_json(path: Path, data: object) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(data, indent=2, ensure_ascii=False, allow_nan=False) + "\n", encoding="utf-8")
    os.replace(temporary, path)
    return path


def write_sums(root: Path, files: Iterable[Path]) -> Path:
    """``<sha256>  <relative path>`` lines, ASCII, verifiable with ``sha256sum --strict --check``."""
    lines = []
    for path in sorted(set(files), key=lambda p: p.relative_to(root).as_posix()):
        relative = path.relative_to(root).as_posix()
        if not relative.isascii() or "\n" in relative:
            raise ValueError("Evidence paths must be plain ASCII")
        lines.append(f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {relative}\n")
    target = root / "SHA256SUMS.txt"
    target.write_text("".join(lines), encoding="ascii")
    return target


def run_metadata(env: Mapping[str, str] | None = None) -> dict:
    env = os.environ if env is None else env
    names = {"repository": "GITHUB_REPOSITORY", "head_sha": "GITHUB_SHA", "branch": "GITHUB_REF_NAME",
             "event": "GITHUB_EVENT_NAME", "run_id": "GITHUB_RUN_ID", "run_attempt": "GITHUB_RUN_ATTEMPT"}
    return {field: env.get(variable) or "local" for field, variable in names.items()}
