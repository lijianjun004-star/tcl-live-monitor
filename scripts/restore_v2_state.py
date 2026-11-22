"""Recover a scheduled run's last successful live state from GitHub Actions."""

import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from datetime import timedelta
from tempfile import TemporaryDirectory
from zipfile import BadZipFile, ZipFile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from core.cache import MAX_BYTES as CACHE_LIMIT, ResolvedCache
from core.contracts import problems
from core.timeutil import parse_iso, utcnow

WORKFLOW = ".github/workflows/v2-monitor.yml"
CACHE, LEDGER, SNAPSHOT = "resolved_cache.json", "notify_ledger.json", "monitor_snapshot.json"
STATE_LIMIT = 4 * 1024 * 1024  # 20 rooms and up to 2,000 ledger entries


class StateError(ValueError):
    """A diagnostic safe to include in an Actions log."""


def github_get(endpoint):
    return json.loads(subprocess.check_output(["gh", "api", endpoint]))


def github_pages(endpoint, key):
    separator = "&" if "?" in endpoint else "?"
    page = 1
    while True:
        rows = github_get(f"{endpoint}{separator}per_page=100&page={page}")[key]
        if not isinstance(rows, list):
            raise StateError("invalid GitHub listing")
        yield from rows
        if len(rows) < 100:
            return
        page += 1


def main_monitor_run(run, repository):
    return (run["path"] == WORKFLOW and run["head_branch"] == "main"
            and (run.get("head_repository") or {}).get("full_name") == repository
            and run["event"] in ("schedule", "workflow_dispatch"))


def successful(run):
    return run["status"] == "completed" and run["conclusion"] == "success"


def select_state(repository, current_run_id, pages=github_pages, *, current_attempt=1, get=github_get):
    actions = f"repos/{repository}/actions"
    # Unfiltered workflow history avoids the REST search cap of 1,000 runs. The
    # API lists newest creations first, but an older run may have a newer rerun.
    # Reruns may start within 30 days; our state artifacts survive seven days.
    oldest_creation = utcnow() - timedelta(days=39)
    eligible = []
    reruns = {current_run_id: current_attempt} if current_attempt > 1 else {}
    for run in pages(f"{actions}/workflows/v2-monitor.yml/runs", "workflow_runs"):
        if parse_iso(run["created_at"]) < oldest_creation:
            break
        if run["id"] == current_run_id or not main_monitor_run(run, repository):
            continue
        if successful(run):
            eligible.append((parse_iso(run["updated_at"]), run["id"], run["run_attempt"]))
        elif run["run_attempt"] > 1:
            reruns[run["id"]] = run["run_attempt"]

    # An in-progress rerun hides its prior successful attempt from the runs
    # collection. Its published baseline can be newer than any other run's.
    for run_id, active_attempt in reruns.items():
        for attempt in range(active_attempt - 1, 0, -1):
            prior = get(f"{actions}/runs/{run_id}/attempts/{attempt}")
            if (prior["id"] != run_id or prior["run_attempt"] != attempt
                    or not main_monitor_run(prior, repository)):
                raise StateError("attempt does not match main monitor run")
            if successful(prior):
                eligible.append((parse_iso(prior["updated_at"]), run_id, attempt))
                break

    for _, run_id, attempt in sorted(eligible, reverse=True):
        prefix = f"{actions}/runs/{run_id}"
        jobs = [job for job in pages(f"{prefix}/attempts/{attempt}/jobs", "jobs") if job["name"] == "live"]
        if jobs and all(job["conclusion"] == "skipped" for job in jobs):
            continue  # manual fake run
        if len(jobs) != 1 or jobs[0]["conclusion"] != "success":
            raise StateError(f"cannot establish live job outcome for {run_id}.{attempt}")
        artifacts = [item for item in pages(f"{prefix}/artifacts?name=v2-state", "artifacts")
                     if item["name"] == "v2-state"]
        if len(artifacts) != 1 or artifacts[0]["expired"] is not False:
            raise StateError(f"state missing, expired or ambiguous for {run_id}.{attempt}")
        artifact = artifacts[0]
        # The run-level artifact listing can contain uploads from previous
        # attempts. GitHub job timestamps are rounded down to whole seconds.
        job = jobs[0]
        created = parse_iso(artifact["created_at"])
        start, end = parse_iso(job["started_at"]), parse_iso(job["completed_at"])
        if not start or not end or not created or not start <= created < end + timedelta(seconds=1):
            raise StateError(f"state does not belong to the successful live attempt {run_id}.{attempt}")
        return run_id, attempt, artifact
    raise StateError("no successful main live baseline found; explicitly seed a manual live run")


def install_state(archive, artifact, destination):
    expected = "sha256:" + hashlib.sha256(archive).hexdigest()
    if len(archive) != artifact["size_in_bytes"] or expected != artifact["digest"]:
        raise StateError("state artifact size or SHA-256 mismatch")

    with ZipFile(io.BytesIO(archive)) as package:
        names = package.namelist()
        required = {CACHE, LEDGER}
        if (set(names) not in (required, required | {SNAPSHOT}) or len(names) != len(set(names))
                or sum(entry.file_size for entry in package.infolist()) > STATE_LIMIT
                or package.getinfo(CACHE).file_size > CACHE_LIMIT):
            raise StateError("invalid state artifact manifest or size")
        # Read only named files, checking ZIP CRCs on read. Never extract paths.
        data = {name: package.read(name) for name in names}

    cache = json.loads(data[CACHE]).get("entries")
    if not isinstance(cache, dict) or not all(ResolvedCache._valid(entry) for entry in cache.values()):
        raise StateError("invalid restored cache")
    sent = json.loads(data[LEDGER]).get("sent")
    if not isinstance(sent, dict) or not all(re.fullmatch(r"[0-9a-f]{32}", key) and parse_iso(at)
                                           for key, at in sent.items()):
        raise StateError("invalid restored notification ledger")
    if SNAPSHOT in data:
        if problems("monitor_snapshot", json.loads(data[SNAPSHOT])):
            raise StateError("invalid restored notification snapshot")
    elif sent:
        raise StateError("missing notification snapshot for nonempty ledger")
    # A first run with pending alerts legitimately has an empty ledger and no
    # snapshot. Preserve it exactly so the following run retries those alerts.
    with TemporaryDirectory(dir=destination.parent) as temporary:
        prepared = Path(temporary) / "state"
        prepared.mkdir()
        for name, content in data.items():
            (prepared / name).write_bytes(content)
        prepared.rename(destination)


def main():
    repository = os.environ["GITHUB_REPOSITORY"]
    run_id, attempt, artifact = select_state(repository, int(os.environ["GITHUB_RUN_ID"]),
                                             current_attempt=int(os.environ["GITHUB_RUN_ATTEMPT"]))
    if not 0 < artifact["size_in_bytes"] <= STATE_LIMIT:
        raise StateError("invalid state archive size")
    artifact_id = int(artifact["id"])
    archive = subprocess.check_output(["gh", "api", f"repos/{repository}/actions/artifacts/{artifact_id}/zip"])
    install_state(archive, artifact, Path("state"))
    print(f"Restored v2-state from main run {run_id}, attempt {attempt}, artifact {artifact_id}.")


if __name__ == "__main__":
    try:
        main()
    except (AttributeError, KeyError, TypeError, ValueError, OSError, RuntimeError, BadZipFile,
            subprocess.CalledProcessError) as error:
        # Schema/JSON/ZIP errors can mention raw input. Only log our fixed messages.
        message = str(error) if isinstance(error, StateError) else type(error).__name__
        sys.exit(f"Scheduled state restore failed: {message}")
