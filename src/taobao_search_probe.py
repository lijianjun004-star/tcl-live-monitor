"""One authorized read of the Taobao Live PC search page in Google Chrome (feasibility probe).

Loads ``tbzb.taobao.com/search`` once with the dedicated monitoring account's cookies
(``TAOBAO_SEARCH_COOKIE``), passively reads the search response, extracts the anchor cards' 进入/主页
buttons and cross-checks the whitelist. No schedule, no retry, no clicks: a login or verification
response stops the run at once.

Writes ``receipt.json`` (no cookie values, no raw response bodies) and ``search.png``.
Exit codes: 0 search response succeeded; 2 configuration error; 3 stopped by a login or verification
gate; 4 runtime failure (for example Google Chrome missing); 5 finished without a usable response.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

from core.errors import Code
from core.network import GateLatch, NetworkAudit, install_policy
from platforms.ali_live.cookie_pool import TAOBAO_DOMAIN, CookieError, parse_cookie_header
from platforms.ali_live.search_page import (
    EXTRACT_CARDS_JS, AliSearchPolicy, collect_api_anchors, cross_check, is_search_api, key_paths,
    normalize_cards, read_search_response, search_url, summarize,
)

COOKIE_ENV = "TAOBAO_SEARCH_COOKIE"
TRIPPING = {Code.LOGIN_REQUIRED, Code.CAPTCHA_X5SEC}


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def load_whitelist(path: Path) -> dict:
    data = json.loads(path.read_text(encoding="utf-8"))
    anchors = data.get("anchors")
    if not isinstance(anchors, list) or not 1 <= len(anchors) <= 20:
        raise ValueError("whitelist needs 1..20 anchors")
    keys = [a.get("key") for a in anchors]
    if len(set(keys)) != len(keys) or not all(isinstance(k, str) and k for k in keys):
        raise ValueError("whitelist keys must be unique non-empty strings")
    for anchor in anchors:
        if anchor.get("id_status") not in {"verified", "pending_user_confirmation"}:
            raise ValueError(f"{anchor.get('key')}: id_status must be verified or pending_user_confirmation")
        if anchor["id_status"] == "verified" and not str(anchor.get("account_id") or "").isdigit():
            raise ValueError(f"{anchor.get('key')}: verified anchors need a numeric account_id")
    if not isinstance(data.get("query"), str) or not data["query"].strip():
        raise ValueError("whitelist needs a non-empty query")
    return data


def run_meta() -> dict:
    env = os.environ
    return {k: env.get(f"GITHUB_{k.upper()}") or "local" for k in ("repository", "sha", "ref", "run_id", "run_attempt", "event_name")}


def write_receipt(out: Path, receipt: dict) -> None:
    out.mkdir(parents=True, exist_ok=True)
    (out / "receipt.json").write_text(json.dumps(receipt, indent=2, ensure_ascii=False, allow_nan=False) + "\n", encoding="utf-8")


def step_summary(receipt: dict) -> None:
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    api = receipt.get("search_api") or {}
    lines = [
        "## Taobao Live search probe",
        f"- Outcome: `{receipt.get('outcome')}` / search response `{api.get('code')}` (`{api.get('reason')}`)",
        f"- Landing: `{(receipt.get('landing') or {}).get('host')}{(receipt.get('landing') or {}).get('path')}`",
        f"- Cards: {(receipt.get('summary') or {}).get('cards_total', 0)} "
        f"(进入 {(receipt.get('summary') or {}).get('cards_enter', 0)}, 主页 {(receipt.get('summary') or {}).get('cards_home', 0)})",
        "", "| Anchor | ID status | Card | API | Code | Reason |", "|---|---|---|---|---|---|",
    ]
    for row in receipt.get("whitelist_results") or []:
        lines.append(f"| {row['display_name']} | {row['id_status']} | {row['dom_state']} | {row['api_state']} | {row['code']} | {row['reason']} |")
    text = "\n".join(lines) + "\n"
    print(text)
    if path:
        with open(path, "a", encoding="utf-8") as handle:
            handle.write(text)


async def probe(args, whitelist: dict, cookie_group) -> tuple[int, dict]:
    from playwright.async_api import async_playwright

    receipt: dict = {"schema": "taobao-search-probe/1", "started_utc": utc_now(), "run": run_meta(),
                     "query": whitelist["query"], "browser": {"channel": "chrome", "headless": args.headless}}
    api_calls: list[dict] = []
    first_ok: dict = {}
    gate_event = asyncio.Event()
    api_event = asyncio.Event()
    unb_check = (lambda value: cookie_group.holds("unb", value))

    async def on_response(response):
        api = is_search_api(response.url)
        if not api:
            return
        try:
            text = await response.text()
        except Exception:
            api_calls.append({"api": api, "http_status": response.status, "code": Code.NAV_TIMEOUT.value, "reason": "body_unreadable"})
            api_event.set()
            return
        code, reason, payload = read_search_response(text)
        api_calls.append({"api": api, "http_status": response.status, "code": code.value, "reason": reason})
        if code == Code.OK and not first_ok:
            first_ok.update({"api": api, "payload": payload})
        if code in TRIPPING:
            gate_event.set()
        api_event.set()

    async with async_playwright() as pw:
        try:
            browser = await pw.chromium.launch(channel="chrome", headless=args.headless)
        except Exception as exc:
            receipt.update(outcome="runtime_error", error=f"chrome_launch_failed: {type(exc).__name__}")
            return 4, receipt
        receipt["browser"]["version"] = browser.version
        context = await browser.new_context(viewport={"width": 1366, "height": 900}, locale="zh-CN",
                                            timezone_id="Asia/Shanghai", service_workers="block")
        await context.add_cookies(cookie_group.playwright_cookies((TAOBAO_DOMAIN,)))
        policy = GateLatch(AliSearchPolicy())
        audit = NetworkAudit(policy.name)
        await install_policy(context, policy, audit,
                             on_blocked=lambda info, decision: gate_event.set() if decision.gate else None)
        page = await context.new_page()
        page.on("response", lambda r: asyncio.ensure_future(on_response(r)))
        started = time.monotonic()
        try:
            await page.goto(search_url(whitelist["query"]), wait_until="domcontentloaded", timeout=30000)
        except Exception as exc:
            receipt["navigation_error"] = type(exc).__name__
        deadline = started + args.budget
        while time.monotonic() < deadline and not gate_event.is_set():
            if first_ok or (api_event.is_set() and any(c["code"] != Code.OK.value for c in api_calls)):
                break
            await asyncio.sleep(0.5)

        cards: list[dict] = []
        if first_ok and not gate_event.is_set():
            stable, last = 0, -1
            while time.monotonic() < deadline + 15 and stable < 2:
                await asyncio.sleep(1)
                count = len(await page.evaluate(EXTRACT_CARDS_JS))
                stable = stable + 1 if count == last and count > 0 else 0
                last = count
            for _ in range(2):
                await page.mouse.wheel(0, 900)
                await asyncio.sleep(1.5)
            cards = normalize_cards(await page.evaluate(EXTRACT_CARDS_JS))
            await page.evaluate("window.scrollTo(0, 0)")
            await asyncio.sleep(1)
        try:
            await page.screenshot(path=str(args.out / "search.png"))
            receipt["screenshot"] = "search.png"
        except Exception:
            receipt["screenshot"] = None
        landing = urlsplit(page.url)
        receipt["landing"] = {"host": landing.hostname, "path": landing.path}
        receipt["elapsed_ms"] = int((time.monotonic() - started) * 1000)
        receipt["network"] = audit.report()
        await context.close()
        await browser.close()

    gate = policy.gate or audit.gate
    codes = [Code(c["code"]) for c in api_calls]
    if any(code in TRIPPING for code in codes) or gate:
        tripped = next((c for c in api_calls if Code(c["code"]) in TRIPPING), None)
        code = Code(tripped["code"]) if tripped else (Code.LOGIN_REQUIRED if gate == "login_wall" else Code.CAPTCHA_X5SEC)
        reason = tripped["reason"] if tripped else f"gate_{gate}"
    elif first_ok:
        code, reason = Code.OK, "success"
    elif api_calls:
        code, reason = Code(api_calls[0]["code"]), api_calls[0]["reason"]
    else:
        code, reason = Code.NAV_TIMEOUT, "search_response_not_observed_within_budget"
    receipt["search_api"] = {"code": code.value, "reason": reason, "calls": api_calls[:10]}

    if code == Code.OK:
        payload = first_ok["payload"]
        paths, truncated = key_paths(payload)
        candidates = collect_api_anchors(payload, exclude=unb_check)
        receipt["response_shape"] = {"api": first_ok["api"], "key_paths": paths, "key_paths_truncated": truncated,
                                     "candidate_count": len(candidates)}
        receipt["api_candidates"] = candidates
        receipt["cards"] = cards
        results = cross_check(whitelist, candidates, cards)
        receipt["whitelist_results"] = results
        receipt["summary"] = summarize(results, cards, whitelist)
        receipt["outcome"] = "search_response_ok"
        exit_code = 0
    elif code in TRIPPING:
        receipt["outcome"] = "stopped_by_gate"
        exit_code = 3
    else:
        receipt["outcome"] = "no_usable_response"
        exit_code = 5
    receipt["completed_utc"] = utc_now()
    return exit_code, receipt


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--whitelist", type=Path, default=Path("config/taobao-search-whitelist.json"))
    parser.add_argument("--out", type=Path, default=Path("out/taobao-search"))
    parser.add_argument("--budget", type=float, default=30.0, help="seconds to wait for the search response")
    parser.add_argument("--headless", action="store_true", help="headless Chrome instead of a (virtual) display")
    args = parser.parse_args(argv)
    args.out.mkdir(parents=True, exist_ok=True)
    try:
        whitelist = load_whitelist(args.whitelist)
    except (OSError, ValueError) as exc:
        write_receipt(args.out, {"schema": "taobao-search-probe/1", "outcome": "config_error", "error": str(exc)})
        print(f"config error: {exc}", file=sys.stderr)
        return 2
    raw = (os.environ.get(COOKIE_ENV) or "").strip()
    try:
        if not raw:
            raise CookieError(f"{COOKIE_ENV} is not set")
        cookie_group = parse_cookie_header(raw, 0, label=COOKIE_ENV)
    except CookieError as exc:
        write_receipt(args.out, {"schema": "taobao-search-probe/1", "outcome": "config_error", "error": str(exc)})
        print(f"config error: {exc}", file=sys.stderr)
        return 2
    try:
        exit_code, receipt = asyncio.run(probe(args, whitelist, cookie_group))
    except Exception as exc:  # never let a stack trace carry page data into the log
        exit_code, receipt = 4, {"schema": "taobao-search-probe/1", "outcome": "runtime_error", "error": type(exc).__name__}
    write_receipt(args.out, receipt)
    step_summary(receipt)
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
