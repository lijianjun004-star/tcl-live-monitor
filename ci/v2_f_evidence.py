"""Verify the signed E baseline and both original F Actions ZIPs. No network or credentials.

python ci/v2_f_evidence.py --e E-Gemini.zip --night NIGHT.zip SHA256 --day DAY.zip SHA256 --out F-Gemini.zip
Supply each artifact's digest from GitHub Actions; do not recompute the expected value from the local download.
Pass the previously verified E handoff ZIP as the baseline.
"""
import argparse
import base64
import hashlib
import io
import json
import re
import stat
import sys
import tempfile
import zipfile
from datetime import datetime
from pathlib import Path, PurePosixPath
from zoneinfo import ZoneInfo
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from platforms.ali_live.calibration import compare_anchor_observations

E_OUTER = "e25373808f6039bc57e327076d7255a22a220780ead0067bf4898042c6d86c53"
E_RAW = "bcd734c63d6c5088b6ad829a4c8218af81b1e8c6648f4bf405e73c5a602de557"
ANCHORS = ("tmall-group", "tmall-ac")
REPO = "lijianjun004-star/tcl-live-monitor"
BRANCH = "feat/v2-modular-architecture"
JSON_FILES = {"control_live_result.json", "monitor_snapshot.json", "resolved_rooms.json", "run_summary.json"}
FUNCTION = re.compile(r"[A-Za-z][A-Za-z0-9_.-]{0,95}")
SAMPLE_KEYS = {"http_status", "mtop_success", "room_status", "stream_status", "live_id_kind", "live_id",
               "broadcaster_account_matches", "broadcaster_name_matches", "room_number_matches", "data_account_matches"}
PRIVATE_VALUE = re.compile(rb"(?:-----BEGIN (?:RSA |EC )?PRIVATE KEY-----|Bearer [A-Za-z0-9_.=-]{15,}|"
                          rb"\bgh[pousr]_[A-Za-z0-9]{20,}|(?:[?&; ]|^)(?:_m_h5_tk|pt_key|x5sec|access_token|refresh_token)=[^&;\s\"]{5,})",re.I)
MAX_BYTES = 128 * 1024 * 1024

def check(ok, message):
    if not ok:
        raise ValueError(message)

def digest(data):
    return hashlib.sha256(data).hexdigest()

def canonical_json(value):
    return (json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode()

def members(data, expected):
    expected = expected.lower().removeprefix("sha256:")
    check(re.fullmatch(r"[a-f0-9]{64}", expected) and digest(data) == expected, "ZIP digest mismatch")
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        infos = z.infolist()
        check(len(infos) <= 400 and sum(i.file_size for i in infos) <= MAX_BYTES, "ZIP size exceeds limit")
        files, names = {}, set()
        for info in infos:
            name = info.orig_filename.removesuffix("/")
            check(name and "\\" not in name and not any(ord(x) < 32 for x in name)
                  and all(p not in ("", ".", "..") and ":" not in p for p in name.split("/"))
                  and name.casefold() not in names, "invalid or duplicate ZIP path")
            typ = stat.S_IFMT(info.external_attr >> 16)
            check(not info.flag_bits & 1 and typ in (0, stat.S_IFDIR, stat.S_IFREG), "unexpected ZIP entry type")
            names.add(name.casefold())
            if not info.is_dir():
                files[name] = z.read(info)
        check(not any(str(p) in files for n in files for p in PurePosixPath(n).parents), "conflicting ZIP paths")
        return files

def manifest(files, exclusions=()):
    rows = files["SHA256SUMS.txt"].decode().splitlines()
    expected = sorted(f"{digest(value)}  {name}" for name, value in files.items()
                      if name != "SHA256SUMS.txt" and name not in exclusions)
    check(sorted(rows) == expected, "inner SHA256SUMS coverage, duplicate or digest mismatch")
    return len(rows)

def observation(files, run_id=None):
    required = JSON_FILES | {"index.html", "SHA256SUMS.txt"}
    check(required <= files.keys(), "incomplete observation archive")
    check(all(n in required | {"drive_status.json"} or re.fullmatch(r"thumbs/[A-Za-z0-9_.-]+\.jpg", n)
              for n in files), "unexpected file in observation")
    checked = manifest(files, {"drive_status.json"})
    for name, raw in files.items():
        if name.endswith((".json", ".html")):
            check(not PRIVATE_VALUE.search(raw), "credential-shaped material in evidence")
    docs = {key[:-5]: json.loads(files[key]) for key in JSON_FILES}
    summ, snap, res = docs["run_summary"], docs["monitor_snapshot"], docs["resolved_rooms"]
    rid = str(summ["run_id"])
    check(summ["repository"] == REPO and summ["engine"] == "live"
          and (not run_id or rid == str(run_id)), "unexpected repository, engine or run ID")
    check(snap["run_id"] == res["run_id"] == rid + "." + str(summ["run_attempt"]), "mismatched observation IDs")
    data_match = re.search(rb'<script type="application/json" id="data">(.*?)</script>', files["index.html"], re.S)
    check(data_match, "missing embedded dashboard data")
    embedded = json.loads(data_match[1])
    check(embedded["snapshot"] == snap, "dashboard snapshot mismatch")
    prefix = "data:image/jpeg;base64,"
    names = {n for n in files if n.startswith("thumbs/")}
    check(names == {r["thumbnail"] for r in snap["rooms"] if r.get("thumbnail")}, "thumbnail list mismatch")
    check(set(embedded["thumbs"]) == {n for n in names if len(files[n])<=300*1024}, "embedded JPEG list mismatch")
    for name, value in embedded["thumbs"].items():
        check(value.startswith(prefix) and base64.b64decode(value[len(prefix):], validate=True) == files[name],
              "embedded JPEG differs from original")
    docs["checksums_verified"] = checked
    return docs

def e_baseline(path):
    outer = members(path.read_bytes(), E_OUTER)
    manifest(outer)
    raw = outer["TCL_V2_Evidence_44765794268_a1.zip"]
    return observation(members(raw, E_RAW), "44765794268")

def scoped(files, group):
    prefix = group + "/"
    return {k[len(prefix):]: v for k,v in files.items() if k.startswith(prefix)}

def load_phase(kind, args):
    path, expected = args
    raw = Path(path).read_bytes()
    files = members(raw, expected)
    check("phase_result.json" in files, "missing phase result")
    phase = json.loads(files["phase_result.json"])
    check(phase["phase"] == kind and re.fullmatch(r"[0-9a-f]{40}", phase["code_sha"])
          and re.fullmatch(r"[0-9a-f]{40}", phase["marker_sha"]), "unexpected phase/commit")
    check(phase.get("status") in {"observation_completed", "preflight_not_positive", "post_control_not_positive",
          "window_expired_before_observation", "window_expired_after_preflight", "runtime_error"}, "unexpected phase status")
    # Raw F artifacts contain public evidence only; credentials, state and target files do not belong in a handoff.
    check(all(n == "phase_result.json" or n.startswith(("observation/","preflight/")) for n in files), "unexpected F member")
    docs, partial = {}, {}
    run_id, attempt = str(phase.get("run_id","")), str(phase.get("run_attempt",""))
    for group in ("preflight","observation"):
        subtree = scoped(files, group)
        if subtree:
            if phase["status"] == "runtime_error" and "SHA256SUMS.txt" not in subtree:
                check(all(n in JSON_FILES | {"index.html","drive_status.json"} or re.fullmatch(r"thumbs/[A-Za-z0-9_.-]+\.jpg",n)
                          for n in subtree), "unrecognized partial evidence")
                check(not any(PRIVATE_VALUE.search(b) for n,b in subtree.items() if n.endswith((".json",".html"))),
                      "credential-shaped partial evidence")
                partial[group] = {"status":"no_inner_manifest","outer_digest_verified":True,"file_count":len(subtree)}
                continue
            obs = observation(subtree, run_id)
            summ = obs["run_summary"]
            check(summ["branch"]==BRANCH and summ["event"]=="push" and summ["head_sha"]==phase["marker_sha"],
                  "observation did not originate from the marker push")
            expected_keys = set(ANCHORS) if kind == "night" else ({"jd-canary"} if group=="preflight" else {"jd-canary","jd-ac-sku"})
            check(set(keyed(obs["monitor_snapshot"])) == expected_keys == set(keyed(obs["resolved_rooms"])), "wrong phase targets")
            sid, num = str(obs["run_summary"]["run_id"]), str(obs["run_summary"]["run_attempt"])
            check((not run_id or sid == run_id) and (not attempt or num == attempt), "phase/observation identity mismatch")
            run_id, attempt = sid, num
            docs[group] = obs
    check(re.fullmatch(r"[0-9]+", run_id) and re.fullmatch(r"[0-9]+", attempt), "unknown phase run or attempt")
    status=phase["status"]
    if status=="observation_completed" or status=="post_control_not_positive":
        check("observation" in docs and (kind=="night" or "preflight" in docs), "missing expected phase observation")
    if status in {"preflight_not_positive","window_expired_after_preflight"}:
        check(kind=="day" and set(docs)=={"preflight"}, "unexpected samples after skipped day probe")
    if status=="window_expired_before_observation":
        check(not docs, "unexpected samples outside window")
    name = f"TCL_V2_F_{kind}_{run_id}_a{attempt}.zip"
    return {"meta":phase,"docs":docs,"partial":partial,"run_id":run_id,"name":name,"sha256":digest(raw)}, raw

def keyed(doc):
    rows = {x["target_key"]: x for x in doc["rooms"]}
    check(len(rows) == len(doc["rooms"]), "duplicate target")
    return rows

def night_results(earlier, night):
    previous = keyed(earlier["monitor_snapshot"])
    doc = night["docs"].get("observation")
    later = keyed(doc["monitor_snapshot"]) if doc else {}
    out = {}
    for key in ANCHORS:
        old, current = previous[key], later.get(key)
        url = old["room_url"]
        account_id = parse_qs(urlsplit(url).query)["userId"][0]
        check(old["code"] == "OK" and old["live_status"] == "live", "E anchor mismatch")
        if current is None:
            out[key] = {"baseline_live_id":old["live_id"], "verdict":"sample_unavailable"}
            continue
        diag = current["diagnostics"]
        check(current.get("room_url") in (None,url) and current["platform"]=="tmall", "F anchor identity mismatch")
        samples=diag.get("livedetail_status_samples",[])
        check(isinstance(samples,list) and len(samples)<=12, "invalid status sample count")
        for item in samples:
            check(isinstance(item,dict) and set(item)==SAMPLE_KEYS, "unexpected status sample fields")
            for k in ("mtop_success","broadcaster_account_matches","broadcaster_name_matches","room_number_matches","data_account_matches"):
                check(item[k] is None or type(item[k]) is bool, "invalid comparison flag")
            for k in ("room_status","stream_status"):
                wire=item[k]
                check(wire is None or type(wire) in (float,int,str) and re.fullmatch(r"-?[0-9]{1,3}(?:\.0)?",str(wire))
                      and -99<=float(wire)<=255, "invalid sanitized status")
            check(type(item["http_status"]) is int and 100<=item["http_status"]<=599
                  and item["live_id_kind"] in {"missing","null","empty","zero","numeric","invalid"}
                  and (item["live_id"] is None or isinstance(item["live_id"],str) and re.fullmatch(r"[1-9][0-9]{4,23}",item["live_id"])),
                  "invalid status HTTP/session ID")
        comparison = compare_anchor_observations(old, current)
        out[key] = {"account_id":account_id, "baseline_live_id":old["live_id"], "baseline_observed":old["observed_at"],
                    "observed_at":current["observed_at"], "current_live_id":current["live_id"],
                    "current_status":current["live_status"], "code":current["code"], "reason":current["reason"],
                    "samples":diag.get("livedetail_status_samples"), "passive_observation":diag.get("passive_observation"),
                    "transition":comparison}
    return out

def live_control(observation_doc, expected_id):
    if not observation_doc:
        return None
    control = observation_doc["control_live_result"]
    positive = (control.get("room_id") == expected_id and control.get("room_id_matched") is True
                and control.get("page_loaded") is True and control.get("login_or_captcha_blocked") is False
                and control.get("live_status") == "live" and control.get("positive_live_control") is True)
    return {"positive":positive, "live_status":control["live_status"], "id":control.get("room_id"),
            "generated_at":control.get("generated_at"), "run_envelope_from":control.get("observed_from"),
            "run_envelope_until":control.get("observed_until")}

def instant(value):
    dt = datetime.fromisoformat(value.replace("Z","+00:00"))
    check(dt.utcoffset() is not None, "timestamp missing timezone")
    return dt

def daytime(day, baseline):
    expected_id = baseline["control_live_result"]["room_id"]
    expected_sku = keyed(baseline["resolved_rooms"])["jd-ac-sku"]["audit"]["sku_id"]
    pre = live_control(day["docs"].get("preflight"), expected_id)
    obs = day["docs"].get("observation")
    post = live_control(obs, expected_id)
    result = {"preflight":pre, "postflight":post, "verdict":"sku_not_sampled"}
    if not obs:
        return result
    sku = keyed(obs["resolved_rooms"]).get("jd-ac-sku")
    if not sku:
        return result
    audit = sku["audit"]; check(str(audit["sku_id"]) == str(expected_sku), "unexpected JD SKU")
    h5 = audit.get("h5") or {}; diag = h5.get("response_diagnostics") or {}
    count = diag.get("public_api_http_errors",0); errors = diag.get("public_api_http_error_samples",[])
    check(type(count) is int and count>=0 and isinstance(errors,list) and len(errors)==min(count,10),
          "invalid or missing HTTP error count/samples")
    for s in errors:
        check(isinstance(s,dict) and set(s)=={"function_id","http_status","host"} and s["host"]=="api.m.jd.com"
              and s["http_status"] in range(400,600) and (s["function_id"] is None or
              isinstance(s["function_id"],str) and FUNCTION.fullmatch(s["function_id"])), "invalid public HTTP error sample")
    start, end = h5.get("observed_from"), h5.get("observed_until")
    bracketed = bool(pre and post and pre["positive"] and post["positive"] and start and end and
                     instant(pre["generated_at"]) <= instant(start) <= instant(end) <= instant(post["generated_at"]))
    ids, prior = audit.get("candidate_ids") or [], audit.get("prior_candidate_ids") or []
    if not bracketed:
        verdict = "positive_controls_do_not_bracket_sku"
    elif sku["code"]=="OK" and sku.get("live_id")==expected_id and expected_id in ids:
        verdict = "sku_returned_confirmed_control_id"
    elif sku["code"]=="OK" and sku.get("live_id")==expected_id and expected_id in prior:
        verdict = "control_id_in_sku_response_before_redirect"
    elif h5.get("status")!="loaded" or count or h5.get("limits_reached") or sku["reason"]=="discovery_observation_incomplete":
        verdict = "incomplete_sku_observation"
    elif sku["reason"]=="no_live_entry_in_guest_h5" and not ids and not h5.get("live_entry_signals"):
        verdict = "no_entry_in_this_guest_observation"
    else:
        verdict = "control_not_unique_or_unmatched"
    return {**result,"verdict":verdict,"recorded_positive_before_and_after":bracketed, "sku":expected_sku,"observed_from":start,"observed_until":end,
            "postflight":post,"code":sku["code"],"reason":sku["reason"],"h5_status":h5.get("status"),"candidate_ids":ids,
            "prior_candidate_ids":prior,"live_entry_signals":h5.get("live_entry_signals"),"http_error_count":count,
            "http_error_samples":errors}

def local(value):
    return instant(value).astimezone(ZoneInfo("Asia/Shanghai")).strftime("%Y-%m-%d %H:%M:%S") if value else "未记录"

def note(summary):
    text = ["# F 轮实盘复核","",f"夜间运行 {summary['night']['run_id']}，日间运行 {summary['day']['run_id']}。",
            f"代码提交 `{summary['code_sha']}`。","","## 天猫下播规则校准","",
            "| 主播入口 | E 在播场次 | F 状态 | 本次样本规则验证 | 场次关系 |","|---|---|---|---|---|"]
    for key,row in summary["anchors"].items():
        c = row.get("transition",{})
        validated = "本入口的采样支持" if c.get("offline_rule_validated") is True else "未确认"
        text.append(f"| {key} | {row['baseline_live_id']} | {row.get('current_status','未采到')} | {validated} | {c.get('session_relation','未知')} |")
    text.extend(["",f"窗口结果为夜间 {summary['night']['phase_status']}，白天 {summary['day']['phase_status']}。", "", "逐样本的脱敏房间状态、流状态及身份匹配结果见 audit.json。两次采样之间的具体停播时刻无法从这两点确定。","","## 京东白天 SKU 对照",""])
    jd = summary["sku"]
    labels = {"sku_not_sampled":"本轮未采样 SKU。",
              "positive_controls_do_not_bracket_sku":"前后两端缺少可核对的阳性结果，无法确认本次 SKU 的在播对照条件。",
              "sku_returned_confirmed_control_id":"本轮游客商品页返回了前后两次对照都确认的场次号。",
              "control_id_in_sku_response_before_redirect":"在商品页跳转前的公开响应中发现已确认的场次号。",
              "incomplete_sku_observation":"本次商品页观测不完整，结论仍为未知。",
              "no_entry_in_this_guest_observation":"本次游客商品页未出现直播入口。该结果仅覆盖本次采样。",
              "control_not_unique_or_unmatched":"本次未得到唯一且与对照吻合的 SKU 场次。"}
    text.append(labels[jd["verdict"]])
    text.append(f"北京时间，前置对照结果记录于 {local((jd['preflight'] or {}).get('generated_at'))}。SKU 采样 {local(jd.get('observed_from'))} 至 {local(jd.get('observed_until'))}。后置对照结果记录于 {local((jd['postflight'] or {}).get('generated_at'))}。")
    text.append("对照时间使用接口判定结果的生成时刻。两次结果之间是否持续在播，现有离散采样无法判定。")
    if "http_error_count" in jd:
        text.extend(["",f"公开 API HTTP 错误共 {jd['http_error_count']} 次，留存前 {len(jd['http_error_samples'])} 条。"])
        for s in jd["http_error_samples"]:
            text.append(f"- `{s['function_id'] or '未识别'}`，{s['host']}，HTTP {s['http_status']}。")
    text.extend(["","## 可复核的原始文件",""])
    for phase in ("night","day"):
        r=summary[phase];text.append(f"- `{r['name']}`，SHA-256 `{r['sha256']}`。")
    text.extend(["","原始 ZIP 按字节保留。E 轮对照取自此前已签核的原始文件，SHA-256 见 audit.json。"])
    return "\n".join(text)+"\n"

def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--e",type=Path,required=True); p.add_argument("--night",nargs=2,metavar=("ZIP","DIGEST"),required=True)
    p.add_argument("--day",nargs=2,metavar=("ZIP","DIGEST"),required=True); p.add_argument("--out",type=Path,required=True)
    args=p.parse_args(); old=e_baseline(args.e)
    night, nraw=load_phase("night",args.night); day,draw=load_phase("day",args.day)
    check(night["run_id"] != day["run_id"] and night["meta"]["code_sha"]==day["meta"]["code_sha"],"phase pair mismatch")
    summary={"code_sha":night["meta"]["code_sha"],"E":{"sha256":E_OUTER,"raw_sha256":E_RAW},
             "anchors":night_results(old,night),"sku":daytime(day,old)}
    for tag,phase in (("night",night),("day",day)):
        summary[tag]={k:phase[k] for k in ("name","run_id","sha256")}
        summary[tag]["phase_status"]=phase["meta"].get("status")
        summary[tag]["started_utc"]=phase["meta"]["started_utc"]
        summary[tag]["completed_utc"]=phase["meta"]["completed_utc"]
        summary[tag]["partial_evidence"]=phase["partial"]
        summary[tag]["inner_checksums"]={k:d["checksums_verified"] for k,d in phase["docs"].items()}
    files={night["name"]:nraw,day["name"]:draw,"audit.json":canonical_json(summary),"复核说明.md":note(summary).encode()}
    files["SHA256SUMS.txt"]="".join(f"{digest(b)}  {n}\n" for n,b in sorted(files.items())).encode()
    # Build and verify before publishing. No half-written handoff if compression or a check fails.
    with tempfile.TemporaryDirectory(dir=args.out.parent) as directory:
        tmp=Path(directory)/"output.zip"
        with zipfile.ZipFile(tmp,"w",compression=zipfile.ZIP_DEFLATED) as z:
            for n,b in files.items(): z.writestr(n,b)
        with zipfile.ZipFile(tmp) as z:
            check(z.testzip() is None and all(z.read(n)==b for n,b in files.items()),"final package check failed")
        args.out.hardlink_to(tmp)
    print(args.out.name, digest(args.out.read_bytes()))

if __name__=="__main__":
    main()
