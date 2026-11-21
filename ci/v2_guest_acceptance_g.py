"""Observe the selected fixed guest targets once, using fresh anonymous state."""
import argparse
import json
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
from core.config import parse_settings

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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--sku-diagnostic", action="store_true")
    mode.add_argument("--tmall-only", action="store_true")
    parser.add_argument("--include-tmall", action="store_true")
    args = parser.parse_args()
    selected = diagnostic_targets(os.environ["V2_TARGETS_JSON"], args.include_tmall, tmall_only=args.tmall_only)
    env = {k: v for k, v in os.environ.items() if not k.startswith(("ALI_COOKIE_GROUP_", "WEBHOOK_", "GDRIVE_"))}
    env["V2_TARGETS_JSON"] = selected
    if args.sku_diagnostic:
        env["V2_JD_ALL_HTTP_ERROR_SAMPLES"] = "1"
    out = Path("g-evidence/observation")
    out.mkdir(parents=True, exist_ok=False)
    if Path("g-state").exists():
        raise SystemExit("A fresh state directory is required")
    os.execve(sys.executable, [sys.executable, str(ROOT / "src/v2_run.py"), "--engine", "live",
                               "--out", str(out), "--dashboard", str(out / "index.html"),
                               "--state-dir", "g-state", "--no-notify", "--no-drive"], env)


if __name__ == "__main__":
    main()
