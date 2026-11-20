"""JSON Schema validation for every layer handoff (SPEC.md rule R5)."""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

from jsonschema import Draft202012Validator

SCHEMA_DIR = Path(__file__).resolve().parents[2] / "schemas"
NAMES = ("targets", "resolved_rooms", "monitor_snapshot")


class ContractError(ValueError):
    """A handoff document does not match its frozen schema."""

    def __init__(self, name: str, problems: list[str]):
        self.name, self.problems = name, problems
        super().__init__(f"{name} violates its schema: " + "; ".join(problems[:5]))


@lru_cache(maxsize=None)
def validator(name: str) -> Draft202012Validator:
    if name not in NAMES:
        raise KeyError(name)
    schema = json.loads((SCHEMA_DIR / f"{name}.schema.json").read_text(encoding="utf-8"))
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema)


def problems(name: str, document: object, limit: int = 20) -> list[str]:
    """Return located violations without echoing instance values (targets are secret)."""
    found = []
    for error in sorted(validator(name).iter_errors(document), key=lambda e: list(e.absolute_path)):
        location = "/" + "/".join(str(part) for part in error.absolute_path)
        found.append(f"{location}: {error.validator}")
        if len(found) >= limit:
            break
    return found


def require(name: str, document: object) -> None:
    found = problems(name, document)
    if found:
        raise ContractError(name, found)
