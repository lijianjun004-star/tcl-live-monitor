"""Run one guest acceptance profile with a filtered, in-memory copy of the targets."""
import hashlib
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from core.config import ConfigError, parse_settings

FEATURE_REF = "refs/heads/feat/v2-modular-architecture"
JD_MODES = {"jd-canary": "direct", "jd-ac-sku": "sku_discover", "jd-shop": "shop_discover"}
ANCHORS = ("tmall-group", "tmall-ac")
EXCLUDED = "tmall-short"
SELECTED = {*JD_MODES, *ANCHORS}
# Pins the approved canary, SKU and two public anchor IDs without copying the target list into Git.
IDENTITY_DIGEST = "9ca65af78a8632addd8763bdebd2719f34eb789a97d68f684c260d366365d38c"


def select_targets(raw):
    document = json.loads(raw)
    settings = parse_settings(document)
    by_key = {t.key: t for t in settings.targets}
    if by_key.keys() != SELECTED | {EXCLUDED}:
        raise ValueError("unexpected source roster")
    for key, mode in JD_MODES.items():
        if (by_key[key].platform, by_key[key].mode) != ("jd", mode):
            raise ValueError("unexpected JD target")
    for key in ANCHORS:
        t = by_key[key]
        if (t.platform, t.mode, t.account_group) != ("tmall", "anchor_entry", 1):
            raise ValueError("unexpected anchor target")
    if (by_key[EXCLUDED].platform, by_key[EXCLUDED].mode) != ("tmall", "short_link"):
        raise ValueError("unexpected excluded target")
    if not by_key["jd-canary"].canary:
        raise ValueError("canary is required")
    identities = [by_key["jd-canary"].live_id, by_key["jd-ac-sku"].sku_id,
                  *(by_key[key].account_id for key in ANCHORS)]
    if not all(identities) or hashlib.sha256("|".join(identities).encode()).hexdigest() != IDENTITY_DIGEST:
        raise ValueError("target identities changed")
    document["targets"] = [row for row in document["targets"] if row["key"] != EXCLUDED]
    return json.dumps(document, ensure_ascii=False)


def main():
    if (os.getenv("GITHUB_REF") != FEATURE_REF or os.getenv("GITHUB_EVENT_NAME") != "workflow_dispatch"
            or os.getenv("RESTORE_STATE_RUN_ID") or os.getenv("FAIL_ON_CANARY") != "true"):
        sys.exit("E requires a fresh, strict-canary dispatch on the reviewed feature branch.")
    try:
        selected = select_targets(os.environ["V2_TARGETS_JSON"])
    except (KeyError, ConfigError, ValueError, TypeError):
        sys.exit("E target configuration did not match the reviewed roster.")
    env = {name: value for name, value in os.environ.items()
           if not name.startswith(("ALI_COOKIE_GROUP_", "WEBHOOK_", "GDRIVE_"))}
    env["V2_TARGETS_JSON"] = selected
    print("E guest profile: five targets, two group-1 anchors, fresh state, no cookies.", flush=True)
    os.execve(sys.executable, [sys.executable, str(ROOT / "src" / "v2_run.py"),
              "--engine", "live", "--fail-on-canary", "--no-notify", "--no-drive",
              "--state-dir", "state", "--out", "v2-evidence", "--dashboard", "docs/index.html"], env)


if __name__ == "__main__":
    main()
