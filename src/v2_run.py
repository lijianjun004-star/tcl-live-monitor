#!/usr/bin/env python3
"""V2 entry point: validate targets -> B discovery -> A monitor -> delivery and evidence.

    python src/v2_run.py --targets config/targets.example.json --engine fake     # offline dry run
    V2_TARGETS_JSON='...' python src/v2_run.py --engine live --fail-on-canary   # Actions

This module is the composition root: it is the only place that wires platforms to output.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import shutil
import sys
from contextlib import nullcontext
from pathlib import Path
from typing import Mapping

sys.path.insert(0, str(Path(__file__).resolve().parent))

from core.base import RunContext  # noqa: E402
from core.breaker import GroupCircuitBreaker  # noqa: E402
from core.cache import ResolvedCache  # noqa: E402
from core.canary import control_row, snapshot_canary  # noqa: E402
from core.config import JD_GROUP, ConfigError, Settings, Target, load_settings  # noqa: E402
from core.contracts import ContractError, problems, require  # noqa: E402
from core.errors import Code  # noqa: E402
from core.evidence import run_metadata, write_json, write_sums  # noqa: E402
from core.models import Resolution, resolved_room, snapshot_room, summarize  # noqa: E402
from core.timeutil import iso, utcnow  # noqa: E402
from output import dashboard, diff_push, gdrive_sync, notifiers  # noqa: E402

SCHEMA_VERSION = "2.0"
EXIT_OK, EXIT_CONTRACT, EXIT_CANARY, EXIT_RUNTIME = 0, 2, 3, 4
CACHEABLE = {"resolved_link", "entry_page"}


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--targets", type=Path, help="Target JSON file (V2_TARGETS_JSON takes precedence).")
    parser.add_argument("--engine", choices=("live", "fake"), default="live")
    parser.add_argument("--scenario", type=Path, help="Fake engine scenario JSON.")
    parser.add_argument("--state-dir", type=Path, default=Path("state"))
    parser.add_argument("--out", type=Path, default=Path("v2-evidence"))
    parser.add_argument("--dashboard", type=Path, default=Path("docs/index.html"))
    parser.add_argument("--no-notify", action="store_true")
    parser.add_argument("--no-drive", action="store_true")
    parser.add_argument("--fail-on-canary", action="store_true")
    return parser.parse_args(argv)


def build_engines(settings: Settings, engine: str, scenario: dict | None, env: Mapping[str, str]) -> dict:
    """platform -> (discovery engine, monitor engine). Instances are shared across platforms."""
    if engine == "fake":
        from core.fake_engines import FakeDiscovery, FakeMonitor

        pair = (FakeDiscovery(scenario), FakeMonitor(scenario))
        return {"jd": pair, "tmall": pair, "taobao": pair}
    from platforms.ali_live.cookie_pool import CookiePool
    from platforms.ali_live.discovery import AliDiscovery
    from platforms.ali_live.live_monitor import AliLiveMonitor
    from platforms.ali_live.session import AliSession
    from platforms.jd.discovery import JdDiscovery
    from platforms.jd.live_monitor import JdLiveMonitor

    group_platforms: dict[int, set[str]] = {}
    for target in settings.targets:
        if target.is_ali:
            group_platforms.setdefault(target.account_group, set()).add(target.platform)
    session = AliSession(CookiePool.from_env(env), group_platforms)
    ali = (AliDiscovery(session), AliLiveMonitor(session))
    return {"jd": (JdDiscovery(), JdLiveMonitor()), "tmall": ali, "taobao": ali}


def by_engine(targets, engines: dict, index: int) -> list[tuple[object, list]]:
    grouped: dict[int, tuple[object, list]] = {}
    for target in targets:
        engine = engines[target.platform][index]
        grouped.setdefault(id(engine), (engine, []))[1].append(target)
    return list(grouped.values())


def degrade(target: Target, result: Resolution, cache: ResolvedCache) -> dict:
    """Apply SPEC.md section 8: success refreshes the cache; failure never clears it."""
    if result.code is Code.OK and result.room_url:
        source = "fresh" if result.networked else "static"
        if source == "fresh" and result.verification in CACHEABLE:
            cache.store(target, live_id=result.live_id, room_url=result.room_url, verification=result.verification)
        return resolved_room(target, code=Code.OK, reason=result.reason, source=source, live_id=result.live_id,
                             room_url=result.room_url, resolved_at=iso(), cache_age_seconds=None,
                             verification=result.verification, audit=result.audit)
    code = Code.SCHEMA_MISMATCH if result.code is Code.OK else result.code
    entry = cache.lookup(target)
    if entry:
        audit = {**result.audit, "cache_stale": entry["stale"]}
        return resolved_room(target, code=code, reason=result.reason, source="cache", live_id=entry["live_id"],
                             room_url=entry["room_url"], resolved_at=entry["resolved_at"],
                             cache_age_seconds=entry["age_seconds"],
                             verification=entry.get("verification", "resolved_link"), audit=audit)
    return resolved_room(target, code=code, reason=result.reason, source="none", live_id=None, room_url=None,
                         resolved_at=None, cache_age_seconds=None, verification="none", audit=result.audit)


async def discover(settings: Settings, engines: dict, ctx: RunContext) -> dict[str, Resolution]:
    async def one(engine, targets):
        try:
            return await engine.resolve_all(targets, ctx)
        except Exception:
            return {}

    merged: dict[str, Resolution] = {}
    for part in await asyncio.gather(*(one(engine, targets) for engine, targets in by_engine(settings.targets, engines, 0))):
        merged.update(part)
    for target in settings.targets:
        merged.setdefault(target.key, Resolution.failure(Code.NAV_TIMEOUT, "engine_exception"))
    return merged


async def monitor(settings: Settings, engines: dict, resolved: dict[str, dict], ctx: RunContext) -> dict[str, dict]:
    async def one(engine, targets):
        try:
            return await engine.monitor_all([(t, resolved[t.key]) for t in targets], ctx)
        except Exception:
            return {}

    merged: dict[str, dict] = {}
    for part in await asyncio.gather(*(one(engine, targets) for engine, targets in by_engine(settings.targets, engines, 1))):
        merged.update(part)
    for target in settings.targets:
        if target.key not in merged:
            merged[target.key] = snapshot_room(target, resolved[target.key], code=Code.NAV_TIMEOUT,
                                               reason="engine_exception", keywords=settings.keywords)
    return merged


def load_previous(path: Path) -> dict | None:
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return document if not problems("monitor_snapshot", document) else None


def reset_evidence(out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    shutil.rmtree(out / "thumbs", ignore_errors=True)
    for name in ("resolved_rooms.json", "monitor_snapshot.json", "control_live_result.json", "run_summary.json",
                 "index.html", "SHA256SUMS.txt", "drive_status.json"):
        (out / name).unlink(missing_ok=True)


def step_summary(env: Mapping[str, str], summary: dict, snapshot: dict) -> None:
    path = env.get("GITHUB_STEP_SUMMARY")
    if not path:
        return
    lines = ["## TCL V2 monitor", "", f"verdict: `{summary['verdict']}` · rooms: {summary['targets_total']} · "
             f"max detect: {summary['max_detect_ms']} ms", "", "| key | platform | code | status | detect ms |",
             "|---|---|---|---|---|"]
    lines += [f"| {r['target_key']} | {r['platform']} | {r['code']} | {r['live_status']} | {r['detect_ms']} |"
              for r in snapshot["rooms"]]
    with open(path, "a", encoding="utf-8") as handle:
        handle.write("\n".join(lines) + "\n")


async def run(args, env: Mapping[str, str]) -> int:
    started = iso()
    meta = run_metadata(env)
    run_id = (f"{meta['run_id']}.{meta['run_attempt']}" if meta["run_id"] != "local"
              else "local-" + utcnow().strftime("%Y%m%dT%H%M%SZ"))
    try:
        settings = load_settings(args.targets, env)
    except (ConfigError, OSError) as error:
        print(json.dumps({"status": "config_error", "detail": str(error)}, ensure_ascii=False))
        return EXIT_CONTRACT
    scenario = json.loads(args.scenario.read_text(encoding="utf-8")) if args.scenario else None
    try:
        engines = build_engines(settings, args.engine, scenario, env)
    except ValueError as error:  # e.g. CookieError: names the group, never the value
        print(json.dumps({"status": "config_error", "detail": str(error)}, ensure_ascii=False))
        return EXIT_CONTRACT
    reset_evidence(args.out)
    cache = ResolvedCache(args.state_dir / "resolved_cache.json", settings.limits.cache_stale_hours)
    previous = load_previous(args.state_dir / "monitor_snapshot.json")
    protected = {t.group_key for t in settings.targets if t.is_ali}
    if settings.limits.jd_circuit_breaker:
        protected.add(JD_GROUP)
    ctx = RunContext(settings=settings, breaker=GroupCircuitBreaker(protected), evidence_dir=args.out, run_id=run_id)
    validation = {"resolved_rooms": "not_run", "monitor_snapshot": "not_run"}
    factory_cm = nullcontext(None)
    if args.engine == "live":
        from core.browser import BrowserFactory

        factory_cm = BrowserFactory()
    unique_engines = {id(e): e for pair in engines.values() for e in pair}.values()
    try:
        async with factory_cm as factory:
            ctx.browser = factory
            try:
                resolutions = await discover(settings, engines, ctx)
                rows = [degrade(target, resolutions[target.key], cache) for target in settings.targets]
                resolved_doc = {"schema_version": SCHEMA_VERSION, "generated_at": iso(), "run_id": run_id, "rooms": rows}
                write_json(args.out / "resolved_rooms.json", resolved_doc)
                try:
                    require("resolved_rooms", resolved_doc)
                    validation["resolved_rooms"] = "ok"
                except ContractError as error:
                    validation["resolved_rooms"] = error.problems
                    print(json.dumps({"status": "contract_error", "contract": "resolved_rooms", "problems": error.problems}))
                    return EXIT_CONTRACT
                resolved = {row["target_key"]: row for row in rows}
                rooms_by_key = await monitor(settings, engines, resolved, ctx)
            finally:
                for engine in unique_engines:
                    try:
                        await engine.close()
                    except Exception:
                        pass
    except Exception as error:  # e.g. Chromium cannot start: no browser state can be trusted
        failure = {**meta, "started_utc": started, "completed_utc": iso(), "schema_version": SCHEMA_VERSION,
                   "engine": args.engine, "verdict": "runtime_error", "error_type": type(error).__name__,
                   "contract_validation": validation}
        write_json(args.out / "run_summary.json", failure)
        print(json.dumps({"status": "runtime_error", "error_type": type(error).__name__}))
        return EXIT_RUNTIME
    rooms = [rooms_by_key[target.key] for target in settings.targets]
    for target, room in zip(settings.targets, rooms):
        row = resolved[target.key]
        if row["source"] == "fresh" and row["verification"] == "candidate_unverified" and room["code"] in ("OK", "OFFLINE"):
            cache.store(target, live_id=row["live_id"], room_url=row["room_url"], verification="candidate_unverified")
        if room["code"] == "OK":
            cache.note_live_id(target, room["live_id"])
    canary_target = settings.canary
    canary_room = rooms_by_key.get(canary_target.key) if canary_target else None
    canary_legacy = ctx.legacy_results.get(canary_target.key) if canary_target else None
    snapshot = {
        "schema_version": SCHEMA_VERSION, "generated_at": iso(), "run_id": run_id,
        "canary": snapshot_canary(canary_target.key if canary_target else None, canary_room, canary_legacy),
        "summary": summarize(rooms, ctx.breaker.open_groups()), "rooms": rooms,
    }
    write_json(args.out / "monitor_snapshot.json", snapshot)
    try:
        require("monitor_snapshot", snapshot)
        validation["monitor_snapshot"] = "ok"
    except ContractError as error:
        print(json.dumps({"status": "contract_error", "contract": "monitor_snapshot", "problems": error.problems}))
        return EXIT_CONTRACT
    control = control_row(canary_target.key if canary_target else None, canary_room, canary_legacy, started)
    write_json(args.out / "control_live_result.json", control)
    dashboard.write(snapshot, args.out / "index.html", args.out)
    dashboard.write(snapshot, args.dashboard, args.out)
    notify = {"status": "disabled"}
    ledger = diff_push.NotifyLedger(args.state_dir / "notify_ledger.json", settings.notify_dedupe_hours)
    events = diff_push.compute_events(previous, snapshot)
    fresh = ledger.fresh(events, utcnow())
    if not args.no_notify:
        notify = {"status": "no_changes"}
        if fresh:
            title, text = diff_push.build_message(fresh, snapshot)
            notify = notifiers.send(title, text, env)
            if notify["status"] == "sent":
                ledger.mark(fresh, utcnow())
    notify.update(events=len(events), fresh_events=len(fresh), event_types=sorted({e["type"] for e in fresh}))
    canary_passed = snapshot["canary"]["passed"]
    summary = {
        **meta, "started_utc": started, "completed_utc": iso(), "schema_version": SCHEMA_VERSION,
        "engine": args.engine, "targets_total": len(rooms), "by_platform": snapshot["summary"]["by_platform"],
        "by_code": snapshot["summary"]["by_code"], "positive_live_control": control["positive_live_control"],
        "verdict": "no_canary" if canary_passed is None else "canary_passed" if canary_passed else "canary_failed",
        "contract_validation": validation, "max_detect_ms": snapshot["summary"]["max_detect_ms"],
        "median_detect_ms": snapshot["summary"]["median_detect_ms"],
        "circuit_breaker": ctx.breaker.report(), "cache_problem": cache.load_problem,
        "notification": notify, "state_snapshot_advanced": notify["status"] in {"sent", "no_changes"},
        "stability_across_runs": "not_measured",
    }
    write_json(args.out / "run_summary.json", summary)
    files = [p for p in args.out.rglob("*") if p.is_file() and p.name not in ("SHA256SUMS.txt", "drive_status.json")]
    write_sums(args.out, files)
    # An empty ledger is valid restorable state before the first successful delivery.
    if notify["status"] == "sent" or not ledger.path.exists():
        ledger.save()
    if summary["state_snapshot_advanced"]:
        write_json(args.state_dir / "monitor_snapshot.json", snapshot)
    cache.save()
    drive = {"status": "disabled"} if args.no_drive else gdrive_sync.sync(args.out, run_id, env)
    write_json(args.out / "drive_status.json", drive)
    step_summary(env, summary, snapshot)
    print(json.dumps({"run_id": run_id, "verdict": summary["verdict"], "by_code": summary["by_code"],
                      "notification": notify["status"], "drive": drive["status"]}, ensure_ascii=False))
    return EXIT_CANARY if args.fail_on_canary and canary_passed is False else EXIT_OK


def main(argv=None) -> int:
    return asyncio.run(run(parse_args(argv), os.environ))


if __name__ == "__main__":
    raise SystemExit(main())
