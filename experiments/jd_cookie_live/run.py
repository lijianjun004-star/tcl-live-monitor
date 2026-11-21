"""Replay the three fixed entries using synthetic observations only."""

import argparse
import json
from pathlib import Path

from .evidence import classify_candidate, inspect_page
from .fixture_session import FixtureCookieError, JSON_COOKIE_FIXTURE, load_fixture_session
from .fixtures import FLAGSHIP, LIGHTING, PAGES, SKU, VERIFICATIONS


ENTRIES = (
    (SKU, "自营空调商品", f"https://item.m.jd.com/product/{SKU}.html"),
    (FLAGSHIP, "TCL 官方旗舰店", f"https://shop.m.jd.com/?shopId={FLAGSHIP}"),
    (LIGHTING, "TCL 灯饰照明京东自营旗舰店", f"https://shop.m.jd.com/?shopId={LIGHTING}"),
)

LABELS = {
    "CONFIG_ERROR": "模拟会话配置错误",
    "OBSERVATION_ERROR": "读取观测时发生错误",
    "NO_PAGE_EVIDENCE": "缺少对应入口的页面证据",
    "NO_ENTRY_OBSERVED": "已观察此页，未发现可确认场次的入口",
    "CANDIDATE_ONLY": "发现候选场次，状态待定",
    "ROOM_STATUS_OBSERVED": "已判定候选场次状态",
    "LOGIN_REQUIRED": "遇到登录门禁",
    "CAPTCHA_X5SEC": "遇到人机验证",
    "ACCESS_RESTRICTED": "访问受限",
    "SKIPPED_AFTER_GATE": "因前序门禁跳过",
    "SKIPPED_AFTER_ERROR": "因前序读取错误跳过",
}


def replay(page_for, verification_for, cookie_fixture):
    """The two lookups read observations on demand so a gate can stop the sequence."""
    report = {"mode": "offline_fixture", "stop": None, "entries": []}
    try:
        session = load_fixture_session(cookie_fixture)
    except FixtureCookieError as exc:
        report["config_error"] = str(exc)
        session = None

    cache = {}
    for entry_id, name, url in ENTRIES:
        row = {
            "entry_id": entry_id, "name": name, "url": url, "code": None,
            "cookie_format_detected": session.cookie_format_detected if session else None,
            "cookie_injected_count": session.cookie_injected_count if session else 0,
            "login_state_signal": "unobserved", "target_identity_matched": False,
            "page_observed": False, "observed_function_ids": [], "http_error_samples": [],
            "live_entry_signals": [], "candidate_live_ids": [], "verifications": [],
            "unattempted_candidate_ids": [],
        }
        report["entries"].append(row)
        if session is None:
            row["code"] = "CONFIG_ERROR"
            continue
        if report["stop"]:
            row["code"] = ("SKIPPED_AFTER_ERROR" if report["stop"]["code"] == "OBSERVATION_ERROR"
                           else "SKIPPED_AFTER_GATE")
            continue

        # An adapter exception may contain request details. Only the stage and code are public.
        try:
            sample = page_for(entry_id)
        except Exception:
            row["code"] = "OBSERVATION_ERROR"
            report["stop"] = {"entry_id": entry_id, "stage": "entry", "code": row["code"]}
            continue
        observation = inspect_page(sample or {}, entry_id)
        gate = observation.pop("gate")
        row.update(observation)
        if gate:
            row["code"] = gate
            report["stop"] = {"entry_id": entry_id, "stage": "entry", "code": gate}
            continue
        if not row["page_observed"]:
            row["code"] = "NO_PAGE_EVIDENCE"
            continue

        row["code"] = "CANDIDATE_ONLY" if row["candidate_live_ids"] else "NO_ENTRY_OBSERVED"
        for index, candidate in enumerate(row["candidate_live_ids"]):
            if candidate not in cache:
                try:
                    sample = verification_for(candidate)
                except Exception:
                    check = classify_candidate(candidate, None)
                    check["code"] = "OBSERVATION_ERROR"
                else:
                    check = classify_candidate(candidate, sample)
                cache[candidate] = (entry_id, check)
                row["observed_function_ids"] = sorted(set(row["observed_function_ids"]) | set(check["observed_function_ids"]))
                row["http_error_samples"].extend(check["http_error_samples"])
            source_id, check = cache[candidate]
            row["verifications"].append({**check, "observed_for_entry_id": source_id})
            if check["gate"] or check["code"] == "OBSERVATION_ERROR":
                row["code"] = check["code"]
                row["unattempted_candidate_ids"] = row["candidate_live_ids"][index + 1:]
                report["stop"] = {"entry_id": entry_id, "stage": "candidate", "code": row["code"]}
                break
            if check["live_status"] in {"live", "replay", "offline"} and check["room_id_matched"]:
                row["code"] = "ROOM_STATUS_OBSERVED"
    return report


def summary(report):
    lines = [
        "# 京东三入口离线回放", "",
        "全部观测、场次和耗时均为模拟数据。下表记录规则如何处理这些样本。", "",
        "| 入口 | 固定 ID | 模拟结果 |",
        "| --- | --- | --- |",
    ]
    for row in report["entries"]:
        lines.append(f'| {row["name"]} | {row["entry_id"]} | {LABELS[row["code"]]} |')
    if "config_error" in report:
        lines.extend(["", f'模拟会话错误 `{report["config_error"]}`。'])
    for row in report["entries"]:
        lines.extend(["", f'## {row["name"]}', "",
                      f'- 页面信号 `{row["login_state_signal"]}`。',
                      f'- 模拟 Cookie 格式 `{row["cookie_format_detected"] or "无"}`，'
                      f'上下文共载入 {row["cookie_injected_count"]} 项。',
                      f'- 直播入口信号：{", ".join(row["live_entry_signals"]) or "无"}。',
                      f'- 候选场次：{", ".join(row["candidate_live_ids"]) or "无"}。'])
        for check in row["verifications"]:
            elapsed = check["elapsed_ms"]
            timing = f"{elapsed} ms" if elapsed is not None else "未记录耗时"
            matched = "匹配" if check["room_id_matched"] else "未确认"
            lines.append(f'- 场次 {check["live_id"]}：{check["live_status"]}（{check["code"]}），'
                         f'{timing}，场次身份{matched}。')
        if row["unattempted_candidate_ids"]:
            lines.append("- 跳过的候选：" + ", ".join(row["unattempted_candidate_ids"]) + "。")
        lines.append(f'- 已观察的公开接口：{", ".join(row["observed_function_ids"]) or "无"}。')
        if row["http_error_samples"]:
            for error in row["http_error_samples"]:
                lines.append(f'- HTTP {error["http_status"]} · {error["host"]} · '
                             f'{error["function_id"] or "接口名未确认"}。')
        else:
            lines.append("- HTTP 错误样本 0 条。")
    if report["stop"]:
        stop = report["stop"]
        lines.extend(["", f'回放在入口 {stop["entry_id"]} 停止，触发条件为 `{stop["code"]}`。'])
    return "\n".join(lines) + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    report = replay(PAGES.get, VERIFICATIONS.get, JSON_COOKIE_FIXTURE)
    args.out.mkdir(exist_ok=True, parents=True)
    (args.out / "jd_cookie_experiment_result.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (args.out / "summary.md").write_text(summary(report), encoding="utf-8")
    return int("config_error" in report or (report["stop"] or {}).get("code") == "OBSERVATION_ERROR")


if __name__ == "__main__":
    raise SystemExit(main())
