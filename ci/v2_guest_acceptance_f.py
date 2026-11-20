"""Collect one bounded F guest observation and retain both admitted and inconclusive evidence."""
import json
import os
from pathlib import Path
import subprocess
import sys
from datetime import datetime, timezone

from v2_f_marker import BRANCH, in_window
from v2_guest_acceptance_e import select_targets

ROOT = Path(__file__).resolve().parents[1]
OUT = Path("f-evidence")
NIGHT = ("tmall-group", "tmall-ac")
DAY = ("jd-canary", "jd-ac-sku")


def now():
    return datetime.now(timezone.utc)


def iso():
    return now().isoformat(timespec="seconds")


def observe(document, keys, directory, *, strict=False):
    selected = {**document, "targets": [r for r in document["targets"] if r["key"] in keys]}
    if {row["key"] for row in selected["targets"]} != set(keys):
        raise ValueError("F target set changed")
    env = {k: v for k, v in os.environ.items() if not k.startswith(("ALI_COOKIE_GROUP_", "WEBHOOK_", "GDRIVE_"))}
    env["V2_TARGETS_JSON"] = json.dumps(selected, ensure_ascii=False)
    # Distinct state paths prevent preflight state from changing the SKU observation.
    dest = OUT / directory
    args = [sys.executable, str(ROOT / "src/v2_run.py"), "--engine", "live", "--no-notify", "--no-drive",
            "--out", str(dest), "--state-dir", str(Path("f-state") / directory), "--dashboard", str(dest / "index.html")]
    if strict:
        args.append("--fail-on-canary")
    status = subprocess.run(args, env=env, check=False).returncode
    return status


def positive(directory, expected_room):
    path = OUT / directory / "control_live_result.json"
    if not path.is_file():
        return False
    record = json.loads(path.read_text("utf-8"))
    return (record.get("room_id") == expected_room and record.get("positive_live_control") is True
            and record.get("room_id_matched") is True and record.get("page_loaded") is True
            and record.get("login_or_captcha_blocked") is False and record.get("live_status") == "live")


def collect(result, document):
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


def main():
    phase = os.environ.get("F_PHASE")
    if (phase not in ("day", "night") or os.getenv("GITHUB_REF") != "refs/heads/" + BRANCH
            or os.getenv("GITHUB_EVENT_NAME") != "push" or os.getenv("GITHUB_RUN_ATTEMPT") != "1"):
        sys.exit("F requires its single validated push event.")
    code = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    if code != os.environ.get("F_CODE_SHA"):
        sys.exit("F requires a checkout of the reviewed implementation.")
    OUT.mkdir(exist_ok=False)
    result = {"phase": phase, "code_sha": code, "marker_sha": os.environ["GITHUB_SHA"], "run_id": os.environ["GITHUB_RUN_ID"],
              "run_attempt": os.environ["GITHUB_RUN_ATTEMPT"], "started_utc": iso(), "preflight_positive": None, "post_control_positive": None,
              "preflight_exit": None, "observation_exit": None, "status": "runtime_error"}
    try:
        document = json.loads(select_targets(os.environ["V2_TARGETS_JSON"]))
        return collect(result, document)
    except (OSError, ValueError, KeyError, TypeError) as exc:
        print("F could not validate its settings or read an observation:", type(exc).__name__)
        return 2
    finally:
        result["completed_utc"] = iso()
        (OUT / "phase_result.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
        print("F outcome:", result["status"])


if __name__ == "__main__":
    sys.exit(main())
