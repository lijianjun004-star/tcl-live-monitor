"""Run the three independent short links and two SKU views in one Actions observation."""
import asyncio
import hashlib
import json
import os
import re
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from playwright.async_api import async_playwright

from discovery import discover
from resolve import resolve

INPUTS = {
    "product": "https://3.cn/3cVlGf-1",
    "clip": "https://3.cn/3cVlNz-S",
    "control": "https://3.cn/3-cVlQIh",
}
ROOT = Path(__file__).resolve().parents[2]
OUT = Path("sku-evidence")
PUBLIC_ID = re.compile(r"[1-9][0-9]{4,17}\Z")


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def validated_id(data, key):
    value = data.get(key)
    return value if isinstance(value, str) and PUBLIC_ID.fullmatch(value) and data.get("id_source") else None


async def resolve_one(browser, role, link):
    try:
        return await asyncio.wait_for(resolve(browser, role, link), timeout=75)
    except Exception as exc:
        return {"role": role, "status": "timeout" if isinstance(exc, TimeoutError) else "resolver_error",
                "error_type": type(exc).__name__, "sku_id": None, "live_id": None}


async def run_control(room):
    row = {"observed_from": now(), "status": "not_run_control_id_unresolved", "room_id": room,
           "positive_live_control": False, "live_status": "unknown", "room_id_matched": None,
           "login_or_captcha_blocked": None, "page_loaded": None}
    if not room:
        return row
    with tempfile.TemporaryDirectory(prefix="sku-room-") as tmp:
        env = {**os.environ, "ROOM_URL": f"https://lives.jd.com/#/{room}"}
        child = await asyncio.create_subprocess_exec(
            sys.executable, str(ROOT / "src/single_room_probe.py"), cwd=tmp, env=env,
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
        )
        try:
            result = await asyncio.wait_for(child.wait(), timeout=110)
        except TimeoutError:
            child.kill()
            await child.wait()
            row.update(status="control_timeout", observed_until=now())
            return row
        row.update(exit_code=result, observed_until=now(), status="control_probe_error")
        path = Path(tmp, "output/result.json")
        if not path.exists():
            return row
        source = json.loads(path.read_text())
        if source.get("room_id") != room:
            row["status"] = "control_identity_mismatch"
            return row
        for name in ("generated_at", "room_id_matched", "login_or_captcha_blocked", "page_loaded",
                     "live_status", "page_gate_reason", "route_mode", "reasons"):
            row[name] = source.get(name)
        if result == 0:
            row["status"] = "observed"
            row["positive_live_control"] = (
                row["room_id_matched"] is True and row["page_loaded"] is True
                and row["login_or_captcha_blocked"] is False and row["live_status"] == "live"
            )
    return row


async def observe_sku(browser, sku, room, mobile_device):
    start = now()
    result = {"sku_id": sku, "pages": [], "observed_function_ids": [], "control_id_available": bool(room),
              "control_id_observed": None, "control_id_discovered": None}
    status = "not_run_sku_unresolved"
    if sku:
        try:
            result = await asyncio.wait_for(discover(browser, sku, room, mobile_device=mobile_device), timeout=150)
            status = "observed"
        except Exception as exc:
            status = "discovery_timeout" if isinstance(exc, TimeoutError) else "discovery_error"
            result["error_type"] = type(exc).__name__
    result.update(status=status, observed_from=start, observed_until=now())
    return result


def interpret(sku, room, control, discovery):
    pages = [p for p in discovery["pages"] if p["loaded_product_page"]]
    candidates = {entry["live_id"] for page in pages for entry in page["live_candidates"]}
    truncated = any(p["limits_reached"] for p in pages)
    if not sku:
        return "inconclusive_sku_unresolved"
    if not room:
        return "inconclusive_control_id_unresolved"
    if not control["positive_live_control"]:
        return "inconclusive_no_confirmed_live_control"
    if not pages:
        return "inconclusive_no_product_page_loaded"
    if room in candidates:
        if candidates == {room} and not truncated:
            return "matching_live_id_uniquely_discovered_in_this_run"
        return "matching_live_id_among_candidates_or_partial_results"
    if discovery["control_id_observed"]:
        return "control_id_seen_without_live_context"
    return "no_match_in_inspected_sources"


def persist(filename, data):
    path = OUT / filename
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False, allow_nan=False) + "\n", encoding="utf-8")
    return path


async def main():
    started = now()
    async with async_playwright() as api:
        browser = await api.chromium.launch(headless=True)
        try:
            results = await asyncio.gather(*(resolve_one(browser, role, url) for role, url in INPUTS.items()))
            links = dict(zip(INPUTS, results))
            sku = validated_id(links["product"], "sku_id")
            room = validated_id(links["control"], "live_id")
            control, discovery = await asyncio.gather(run_control(room), observe_sku(browser, sku, room, api.devices["Pixel 7"]))
        finally:
            await browser.close()
    discovery["short_links"] = links
    clip = validated_id(links["clip"], "live_id")
    discovery["clip_matches_control"] = clip == room if clip and room else None
    verdict = interpret(sku, room, control, discovery)
    summary = {
        "repository": os.environ["GITHUB_REPOSITORY"], "head_sha": os.environ["GITHUB_SHA"],
        "branch": os.environ["GITHUB_REF_NAME"], "event": os.environ["GITHUB_EVENT_NAME"],
        "run_id": os.environ["GITHUB_RUN_ID"], "run_attempt": os.environ["GITHUB_RUN_ATTEMPT"],
        "started_utc": started, "completed_utc": now(), "sku_id": sku, "control_live_id": room,
        "positive_live_control": control["positive_live_control"],
        "product_views": {p["variant"]: p["status"] for p in discovery["pages"]},
        "links": {label: link["status"] for label, link in links.items()},
        "verdict": verdict, "stability_across_runs": "not_measured",
    }
    OUT.mkdir(exist_ok=True)
    files = [persist("discovery_result.json", discovery), persist("control_live_result.json", control),
             persist("run_summary.json", summary)]
    (OUT / "SHA256SUMS.txt").write_text("".join(
        f"{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.name}\n" for p in files
    ), encoding="ascii")
    print(json.dumps({"run_id": summary["run_id"], "links": summary["links"], "verdict": verdict}))


if __name__ == "__main__":
    asyncio.run(main())
