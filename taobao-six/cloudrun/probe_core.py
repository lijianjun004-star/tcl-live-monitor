"""Pure logic for the CloudBase risk-control probe: input checks, response classification, summary.

The probe answers one question: from this host's network, does the Taobao Live PC room page get
its room data and video, or is it refused (FAIL_SYS_ILLEGAL_ACCESS / RGV587 / HTTP 4xx)?
No login, no clicks, no hand-built API calls: the real page makes every request itself.
"""
import hmac
import json
import re

LIVE_ID = re.compile(r"[1-9][0-9]{4,19}")
ROOM_URL = "https://tbzb.taobao.com/live?liveId={}"
DETAIL_API = re.compile(r"/h5/mtop\.roomstudio\.live\.detail\.get/", re.I)
STREAM_HOST = re.compile(r"(^|\.)(livecb|live-spare|liveng|livecdn)\.alicdn\.com$", re.I)
STREAM_PATH = re.compile(r"\.(flv|m3u8|m4s)(\?|$)", re.I)
RET = re.compile(r'"ret"\s*:\s*\[\s*"([^"]*)"')
FIELD = re.compile(r'"(roomStatus|streamStatus)"\s*:\s*"?(-?\d+)"?')
REFUSED = re.compile(r"ILLEGAL_ACCESS|RGV587|USER_VALIDATE|FLOW_LIMIT|TRAFFIC_LIMIT|DENY", re.I)
PLAYER_MARKERS = ("加载失败", "访问被拒", "访问受限", "非法请求", "直播已结束", "主播暂时离开", "拖动滑块", "请完成验证")
DEFAULT_LIVE_IDS = ["1395749701542483", "3275552239423375", "4498727350153741",
                    "1879940921420635", "1127180169987657", "4374599017660154"]  # 2026-11-23 12:41:44 evidence


def valid_live_id(value):
    return isinstance(value, str) and LIVE_ID.fullmatch(value) is not None


def token_ok(given, expected):
    """Constant-time comparison; an unset or short server token never authorizes anything."""
    if not isinstance(expected, str) or len(expected) < 16 or not isinstance(given, str):
        return False
    return hmac.compare_digest(given.encode(), expected.encode())


def is_detail(url):
    return "h5api." in url and DETAIL_API.search(url) is not None


def is_stream(host, path):
    return bool(STREAM_HOST.search(host or "")) or bool(STREAM_PATH.search(path or ""))


def read_detail(body):
    """``(ret, {roomStatus, streamStatus})`` from a room-detail JSON/JSONP body, values only."""
    text = body if isinstance(body, str) else ""
    ret = RET.search(text)
    fields = {}
    for key, value in FIELD.findall(text):
        fields.setdefault(key, value)
    return (ret.group(1)[:80] if ret else None), fields


def classify(detail_rets, stream_statuses, http_errors, video, markers):
    """Verdict for one page load.

    ``refused``       room data refused by risk control, or any HTTP 400/403 on page, data or stream
    ``playing``       room data accepted and the video clock advanced
    ``data_ok``       room data accepted, video did not advance (offline room, codec, slow stream)
    ``inconclusive``  no room-data answer within the budget
    """
    refused_ret = next((r for r in detail_rets if r and REFUSED.search(r)), None)
    blocking_http = [e for e in http_errors if e.get("status") in (400, 403)]
    blocked_stream = [s for s in stream_statuses if s.get("status", 0) >= 400]
    if refused_ret or blocking_http or blocked_stream:
        reason = refused_ret or (f"HTTP {(blocking_http or blocked_stream)[0]['status']}")
        return "refused", reason
    success = any(r and r.upper().startswith("SUCCESS") for r in detail_rets)
    if success and video and video.get("advanced"):
        return "playing", "视频时间在走"
    if success:
        return "data_ok", "数据成功，视频未播放" + (f"（{'、'.join(markers)}）" if markers else "")
    return "inconclusive", "预算内未取得直播间数据" + (f"（{'、'.join(markers)}）" if markers else "")


def video_progress(samples):
    """Summarize ``<video>`` samples: did currentTime advance with a decoded frame size?"""
    clean = [s for s in samples if isinstance(s, dict)]
    if not clean:
        return {"present": False, "advanced": False, "width": 0, "height": 0, "error": None}
    advanced = max(s.get("t", 0) for s in clean) - clean[0].get("t", 0) > 1.0 and any(s.get("w") for s in clean)
    last = clean[-1]
    return {"present": True, "advanced": bool(advanced), "width": last.get("w", 0), "height": last.get("h", 0),
            "error": next((s.get("err") for s in clean if s.get("err")), None)}


def summarize(results):
    counts = {}
    for row in results:
        counts[row.get("verdict", "error")] = counts.get(row.get("verdict", "error"), 0) + 1
    return {"total": len(results), "by_verdict": dict(sorted(counts.items()))}


def dumps(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False)
