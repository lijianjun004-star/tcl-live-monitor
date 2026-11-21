"""Manually inspect the three public storefront documents. Keep session material in memory."""

import argparse
import hashlib
import json
import os
from pathlib import Path

from .evidence import GATE_CODES
from .public_room import verify_room
from .run import ENTRIES
from .scoped_session import CookieConfigError, load_session
from .storefront import observe_entry


MAX_PUBLIC_ROOMS = 6
PAGE_FIELDS = (
    "scope_available", "authenticated_request_sent", "cookie_injected_count",
    "page_observed", "target_identity_matched", "login_state_signal",
    "live_entry_signals", "candidate_live_ids", "observed_function_ids", "http_error_samples",
)
LABELS = {
    "CONFIG_ERROR": "会话配置无效",
    "SKIPPED": "前序观测已终止，未访问",
    "OBSERVATION_ERROR": "读取失败，状态未知",
    "SESSION_OUT_OF_SCOPE": "此入口不在凭据适用范围内",
    "PUBLIC_PAGE_UNVERIFIED": "游客首页未确认可读",
    "AUTHENTICATED_PAGE_UNVERIFIED": "携带凭据的页面未取得可用正文",
    "NO_ENTRY_IN_HTML": "已读 HTML 未见直播间链接",
    "CANDIDATE_ONLY": "发现候选，场次状态未知",
    "ROOM_STATUS_OBSERVED": "已核实候选场次状态",
    "CAPTCHA_X5SEC": "出现人机验证",
    "LOGIN_REQUIRED": "出现登录门禁",
    "ACCESS_RESTRICTED": "访问受限",
}
CONFIG_ERRORS = {"missing_jd_cookie", "invalid_jd_cookie", "no_scoped_jd_cookie"}


def collect(raw, origin, observe=observe_entry, verify=verify_room):
    report = {"mode": "manual_storefront_html", "stop": None, "entries": []}
    try:
        session = load_session(raw, raw_origin=origin)
    except CookieConfigError as exc:
        report["config_error"] = exc.code if exc.code in CONFIG_ERRORS else "invalid_jd_cookie"
        session = None

    checked = {}
    for entry_id, name, url in ENTRIES:
        row = {
            "entry_id": entry_id, "name": name, "url": url, "code": "SKIPPED",
            "cookie_format_detected": session.cookie_format_detected if session else None,
            "cookie_injected_count": 0, "authenticated_request_sent": False,
            "scope_available": None, "page_observed": False, "target_identity_matched": False,
            "login_state_signal": "unobserved", "live_entry_signals": [], "candidate_live_ids": [],
            "observed_function_ids": [], "http_error_samples": [], "verifications": [],
            "unattempted_candidate_ids": [],
        }
        report["entries"].append(row)
        if session is None:
            row["code"] = "CONFIG_ERROR"
            continue
        if report["stop"]:
            continue
        stage = "entry"
        try:
            obs = observe(entry_id, session)
            row.update({key: obs[key] for key in PAGE_FIELDS})
            gate = obs["gate"]
            if gate in GATE_CODES:
                row["code"] = gate
                report["stop"] = {"entry_id": entry_id, "stage": stage, "code": gate}
                continue
            if row["scope_available"] is False:
                row["code"] = "SESSION_OUT_OF_SCOPE"
                continue
            if not row["authenticated_request_sent"]:
                row["code"] = "PUBLIC_PAGE_UNVERIFIED"
                continue
            if not row["page_observed"]:
                row["code"] = "AUTHENTICATED_PAGE_UNVERIFIED"
                continue
            row["code"] = "CANDIDATE_ONLY" if row["candidate_live_ids"] else "NO_ENTRY_IN_HTML"
            stage = "candidate"
            for i, room_id in enumerate(row["candidate_live_ids"]):
                if room_id not in checked:
                    if len(checked) >= MAX_PUBLIC_ROOMS:
                        row["unattempted_candidate_ids"].append(room_id)
                        continue
                    checked[room_id] = verify(room_id)
                result = checked[room_id]
                row["verifications"].append(result)
                row["observed_function_ids"] = sorted(set(row["observed_function_ids"]) | set(result["observed_function_ids"]))
                for error in result["http_error_samples"]:
                    if error not in row["http_error_samples"]:
                        row["http_error_samples"].append(error)
                if result["gate"] in GATE_CODES or result["code"] == "OBSERVATION_ERROR":
                    row["code"] = result["gate"] or result["code"]
                    report["stop"] = {"entry_id": entry_id, "stage": stage, "code": row["code"]}
                    row["unattempted_candidate_ids"].extend(row["candidate_live_ids"][i + 1:])
                    break
                if result["room_id_matched"] and result["live_status"] in {"live", "replay", "offline"}:
                    row["code"] = "ROOM_STATUS_OBSERVED"
        except Exception:
            # Transport/browser exceptions may embed headers, body fragments or a redirect URL.
            if stage == "entry":
                row["authenticated_request_sent"] = row["cookie_injected_count"] = None
            row["code"] = "OBSERVATION_ERROR"
            report["stop"] = {"entry_id": entry_id, "stage": stage, "code": row["code"]}
    return report


def markdown(report):
    lines = ["# 京东三入口手动观测", "",
             "入口仅观察服务器返回的 HTML。携带凭据不代表京东已确认登录。候选公开房间使用独立游客会话核验；场次状态不证明店铺归属。", "",
             "| 入口 | 结果 | 候选房间 |", "| --- | --- | --- |"]
    for row in report["entries"]:
        lines.append(f'| {row["name"]}（{row["entry_id"]}） | {LABELS[row["code"]]} | {", ".join(row["candidate_live_ids"]) or "无"} |')
    for row in report["entries"]:
        lines.extend(["", f'## {row["name"]}', "",
                      f'- 会话格式 {row["cookie_format_detected"] or "未知"}，发送条目数 {row["cookie_injected_count"] if row["cookie_injected_count"] is not None else "未知"}。',
                      f'- 页面信号 {row["login_state_signal"]}；直播入口信号 {", ".join(row["live_entry_signals"]) or "无"}。',
                      f'- 已观察公开接口 {", ".join(row["observed_function_ids"]) or "无"}。'])
        for result in row["verifications"]:
            ms = result["detect_ms"]
            lines.append(f'- 候选 {result["live_id"]} · {result["code"]} · {result["live_status"]} · '
                         + (f'{ms} ms' if ms is not None else '未取得判定耗时') + '。')
        for error in row["http_error_samples"]:
            lines.append(f'- HTTP {error["http_status"]} · {error["host"]} · {error["function_id"] or "页面请求"}。')
        if row["unattempted_candidate_ids"]:
            lines.append("- 未核验场次 " + ", ".join(row["unattempted_candidate_ids"]) + "。")
    if report.get("config_error"):
        lines.extend(["", f'配置错误 {report["config_error"]}。'])
    if report["stop"]:
        stop = report["stop"]
        lines.extend(["", f'在 {stop["entry_id"]} 的 {stop["stage"]} 阶段终止，状态为 {stop["code"]}。'])
    return "\n".join(lines) + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    # Remove the step secret from the environment before a public-room browser can start.
    raw = os.environ.pop("JD_COOKIES_JSON", None)
    report = collect(raw, os.environ.get("JD_RAW_ORIGIN", "item.m.jd.com"))
    args.out.mkdir(parents=True, exist_ok=False)
    documents = {
        "jd_cookie_experiment_result.json": json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        "summary.md": markdown(report),
    }
    checksums = []
    for name, content in documents.items():
        data = content.encode("utf-8")
        (args.out / name).write_bytes(data)
        checksums.append(f"{hashlib.sha256(data).hexdigest()}  {name}")
    (args.out / "SHA256SUMS.txt").write_text("\n".join(checksums) + "\n", encoding="ascii")
    return int("config_error" in report or any(row["code"] == "OBSERVATION_ERROR" for row in report["entries"]))


if __name__ == "__main__":
    try:
        exit_code = main()
    except Exception:
        # Even unexpected adapter or filesystem failures must not leak input on stderr.
        exit_code = 2
    raise SystemExit(exit_code)
