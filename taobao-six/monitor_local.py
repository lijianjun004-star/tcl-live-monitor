"""TCL 淘宝主播搜索页采集器。所有截图与 Chrome 配置仅保存在运行机器上。"""
import argparse
import http.client
import json
import os
import ssl
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import Error as BrowserError, sync_playwright

from search_page import SEARCH_URL, ScanError, check_access, on_search, scan
from verified_scan import read_verified, read_verified_links
from wall import VideoWall

ROOT = Path(__file__).resolve().parent
PROFILE = ROOT / "chrome_profile"
STATE = ROOT / "runtime" / "latest.json"
INTERVAL = 120
ENABLE_VIDEO_WALL = False


def utc_now():
    return datetime.now(timezone.utc)


def iso(dt):
    return dt.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def parse_time(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def make_snapshot(rows, expected, previous, now, interrupted=False):
    names = [row["name"] for row in rows]
    if not names or len(names) != len(set(names)):
        raise ScanError("卡片为空或存在重复店名")
    missing = expected.difference(names)
    if missing:
        raise ScanError("缺少基准名单中的店铺：" + "、".join(sorted(missing)))
    old_rows = {}
    if previous:
        gap = now - parse_time(previous["updatedAt"])
        if gap <= timedelta(0):
            raise ScanError("采集机时间未晚于上次观测，请检查系统时钟")
        if not interrupted and gap <= timedelta(minutes=5):
            old_rows = {s["name"]: s for s in previous["shops"]}
    shops = []
    for row in rows:
        old = old_rows.get(row["name"])
        start = None
        if row["isLive"]:
            continued = old and old["isLive"] and old["liveUrl"] == row["liveUrl"]
            start = old["startTime"] if continued else iso(now)
        shops.append({**row, "startTime": start})
    return {"updatedAt": iso(now), "liveCount": sum(s["isLive"] for s in shops),
            "totalCount": len(shops), "shops": shops}


def read_state(path):
    if not path.exists():
        return {"snapshot": None, "pending": False}
    return json.loads(path.read_text(encoding="utf-8"))


def write_state(state, path):
    path.parent.mkdir(exist_ok=True, mode=0o700)
    tmp = path.with_suffix(".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False)
        f.flush()
        os.fsync(f.fileno())
    tmp.replace(path)


class PushError(Exception):
    pass


def push_snapshot(url, token, snapshot):
    # A raw HTTPS connection never forwards the write token to a redirect target.
    body = json.dumps(snapshot, ensure_ascii=False).encode("utf-8")
    conn = http.client.HTTPSConnection(url.hostname, url.port, timeout=15,
                                       context=ssl.create_default_context())
    try:
        conn.request("POST", url.path or "/", body=body, headers={
            "Content-Type": "application/json; charset=utf-8", "x-api-token": token})
        res = conn.getresponse()
        if not 200 <= res.status < 300:
            raise PushError(f"云端写入返回 HTTP {res.status}")
        # A login page or gateway HTML must not clear a pending snapshot.
        if not res.getheader("Content-Type", "").lower().startswith("application/json"):
            raise PushError("写入接口未返回 JSON")
        reply = json.loads(res.read(8192))
        if not isinstance(reply, dict) or reply.get("ok") is not True:
            raise PushError("云端未确认写入")
    finally:
        conn.close()


def sync_pending(state, url, token, path):
    if not state["pending"] or url is None:
        return True
    try:
        push_snapshot(url, token, state["snapshot"])
    except (OSError, http.client.HTTPException, ValueError, PushError) as exc:
        reason = str(exc) if isinstance(exc, PushError) else type(exc).__name__
        print(f"推送未确认，保留最近一次有效快照：{reason}", file=sys.stderr, flush=True)
        return False
    state["pending"] = False
    write_state(state, path)
    return True


def debug_screen(page, label):
    if page.is_closed():
        return
    dest = ROOT / "live_debug"
    dest.mkdir(exist_ok=True, mode=0o700)
    path = dest / f"{utc_now():%Y%m%dT%H%M%S%fZ}-{label}.png"
    try:
        page.screenshot(path=str(path), timeout=5000, mask=[page.locator(
            'iframe,input,textarea,canvas,img,svg,video,[contenteditable=true]')])
        for item in sorted(dest.glob("*.png"), reverse=True)[24:]:
            item.unlink(missing_ok=True)
        print(f"本地截图：{path.relative_to(ROOT)}", file=sys.stderr)
    except (BrowserError, OSError) as exc:
        print(f"截图保存失败：{type(exc).__name__}", file=sys.stderr)


def args_and_config():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--login", action="store_true", help="在 Chrome 窗口中手动登录后按回车退出")
    p.add_argument("--same-tab", action="store_true",
                   help="手动确认卡片后，在同一有头标签页读取已核对的店铺，仅输出本地结果")
    p.add_argument("--once", action="store_true", help="读取一次后退出")
    p.add_argument("--local-only", action="store_true", help="仅验证本地采集，停用云端推送")
    p.add_argument("--video-wall", action=argparse.BooleanOptionalAction, default=ENABLE_VIDEO_WALL)
    p.add_argument("--width", type=int, default=1920)
    p.add_argument("--height", type=int, default=1080)
    p.add_argument("--x", type=int, default=0)
    p.add_argument("--y", type=int, default=0)
    p.add_argument("--expected-shops", type=Path, help="全页模式的基准名单")
    args = p.parse_args()
    if args.same_tab:
        if args.login or args.video_wall or args.expected_shops is not None:
            p.error("--same-tab 使用内置核对名单，单独完成登录与本地计数，请移除 --login、--video-wall 和 --expected-shops")
        args.local_only = True
    if min(args.width, args.height) <= 0:
        p.error("屏幕宽高必须为正整数")
    url = None
    token = ""
    if not args.login and not args.local_only:
        url = urlsplit(os.environ.get("CLOUDBASE_UPDATE_URL", "").strip())
        token = os.environ.get("CLOUDBASE_API_TOKEN", "").strip()
        if url.scheme != "https" or not url.hostname or url.username or url.password or url.query or url.fragment:
            p.error("请设置 CLOUDBASE_UPDATE_URL 为完整的 HTTPS 写入接口地址")
        if not token or not token.isascii() or not token.isprintable():
            p.error("请设置 CLOUDBASE_API_TOKEN 为云函数对应的 ASCII 令牌")
    expected = set()
    if not args.login:
        path = ROOT / "verified_shops.json" if args.same_tab else (args.expected_shops or ROOT / "expected_shops.json")
        loaded = json.loads(path.read_text(encoding="utf-8-sig"))
        if not isinstance(loaded, list) or any(not isinstance(n, str) or not n.strip() for n in loaded):
            p.error("基准名单应为店名字符串数组")
        if args.same_tab and (not loaded or len(set(loaded)) != len(loaded)):
            p.error("已核对店铺名单必须非空且店名唯一")
        expected = loaded if args.same_tab else set(loaded)
    return args, expected, url, token


def print_verified_rows(targets, records, unavailable="本轮未取得卡片证据"):
    labels = {"live": "开播", "offline": "未开播", "unknown": "未知"}
    complete = True
    for name in targets:
        row = records.get(name, {})
        status = row.get("status", "unknown")
        if status == "live" and row.get("liveId") and row.get("liveUrl"):
            detail = f"liveId={row['liveId']}  {row['liveUrl']}"
        elif status == "offline":
            detail = "liveId=不适用"
        else:
            complete = False
            detail = "liveId=未核实  " + (row.get("reason") or unavailable)
        print(f"{name}  {labels[status]}  {detail}", flush=True)
    return complete


def poll_verified(context, targets, once):
    pages = [p for p in context.pages if not p.is_closed()]
    page = next((p for p in pages if on_search(p)), None)
    if page is None:
        page = pages[0] if pages and pages[0].url == "about:blank" else context.new_page()
        page.goto(SEARCH_URL, wait_until="commit", timeout=60000)
    page.bring_to_front()
    try:
        input("请在这个 Chrome 窗口打开 TCL 主播卡片。如需登录，请手动完成。看到卡片后回到此终端按回车计数：")
    except EOFError:
        print("等待手动确认时终端输入已关闭，本轮未计数。", file=sys.stderr)
        return 2

    # Manual sign-in can complete in a new tab. Follow the page the user saw.
    candidates = [p for p in context.pages if not p.is_closed() and on_search(p)]
    if len(candidates) > 1:
        candidates = [p for p in candidates if p.evaluate("() => document.visibilityState === 'visible'")]
        if len(candidates) != 1:
            print("多个 TCL 搜索页中无法确定刚才查看的标签页，本轮未知。", file=sys.stderr)
            if once:
                print_verified_rows(targets, {}, "无法确定已确认的搜索标签页")
            return 2
    if candidates:
        page = candidates[0]
    refresh = False
    while not page.is_closed():
        started = time.monotonic()
        records = {}
        reason = "本轮未取得卡片证据"
        try:
            # Check before scanning and before any later refresh. Leave a login
            # or verification prompt in place for manual handling.
            check_access(page)
            if refresh:
                response = page.reload(wait_until="domcontentloaded", timeout=45000)
                if response is None or not response.ok:
                    raise ScanError("搜索页刷新失败")
            if once:
                records = read_verified_links(page, targets)
                states = {name: row["status"] for name, row in records.items()}
            else:
                states = read_verified(page, targets)
        except (ScanError, BrowserError) as exc:
            reason = str(exc) if isinstance(exc, ScanError) else type(exc).__name__
            print(f"同页读取未完成：{reason}", file=sys.stderr, flush=True)
            states = {}
        live = [name for name in targets if states.get(name) == "live"]
        offline = [name for name in targets if states.get(name) == "offline"]
        unknown = [name for name in targets if states.get(name) not in ("live", "offline")]
        if len(unknown) == len(targets):
            tally = "开播总数未知"
        elif unknown:
            tally = f"已确认开播 {len(live)} 家，开播总数待核"
        else:
            tally = f"开播总数 {len(live)} 家"
        observed = utc_now().astimezone(timezone(timedelta(hours=8)))
        print(f"{observed:%Y-%m-%d %H:%M:%S} 北京时间  {tally}，"
              f"未开播 {len(offline)} 家，未知 {len(unknown)} 家", flush=True)
        if live:
            print("开播店铺：" + "、".join(live), flush=True)
        if unknown:
            print("状态未知：" + "、".join(unknown), flush=True)
        complete = print_verified_rows(targets, records, reason) if once else True
        if (unknown or not live or not complete) and on_search(page):
            debug_screen(page, "unknown" if unknown or not complete else "zero")
        if once:
            return 0 if complete else 2
        refresh = True
        time.sleep(max(1, INTERVAL - (time.monotonic() - started)))
    print("计数标签页已关闭，本地监控结束。", file=sys.stderr)
    if once:
        print_verified_rows(targets, {}, "计数标签页已关闭")
    return 2


def poll(context, args, expected, url, token):
    if args.same_tab:
        return poll_verified(context, expected, args.once)
    page = context.pages[0] if context.pages else context.new_page()
    if args.login:
        page.goto(SEARCH_URL, wait_until="commit", timeout=60000)
        input("请在 Chrome 手动登录。看到 TCL 主播卡片后，回到此终端按回车保存并退出：")
        return 0
    path = STATE.with_name("local-only.json") if args.local_only else STATE
    state = read_state(path)
    wall = VideoWall(context, args.width, args.height, args.x, args.y) if args.video_wall else None
    try:
        while True:
            started = time.monotonic()
            good = False
            if page.is_closed():
                page = context.new_page()
            try:
                snapshot = make_snapshot(scan(page), expected, state["snapshot"], utc_now(),
                                         interrupted=state.get("interrupted", False))
            except (ScanError, BrowserError) as exc:
                reason = str(exc) if isinstance(exc, ScanError) else type(exc).__name__
                print(f"{iso(utc_now())} 采集未知：{reason}", file=sys.stderr, flush=True)
                if not state.get("interrupted"):
                    state["interrupted"] = True
                    write_state(state, path)
                debug_screen(page, "unknown")
            else:
                state = {"snapshot": snapshot, "pending": url is not None}
                write_state(state, path)
                live = [s["name"] for s in snapshot["shops"] if s["isLive"]]
                print(f"{snapshot['updatedAt']}  开播 {len(live)} / {snapshot['totalCount']}  "
                      + ("、".join(live) or "无"), flush=True)
                if not live:
                    debug_screen(page, "zero")
                if wall:
                    try:
                        wall.sync(snapshot["shops"])
                    except (BrowserError, RuntimeError) as exc:
                        print(f"监控墙更新失败：{type(exc).__name__}", file=sys.stderr)
                good = True
            delivered = sync_pending(state, url, token, path)
            if args.once:
                return 0 if good and delivered else 2
            elapsed = time.monotonic() - started
            time.sleep(INTERVAL - elapsed if elapsed < INTERVAL else INTERVAL)
    finally:
        if wall:
            wall.close()


def main():
    args, expected, url, token = args_and_config()
    PROFILE.mkdir(exist_ok=True, mode=0o700)
    browser_env = {k: v for k, v in os.environ.items() if k != "CLOUDBASE_API_TOKEN"}
    with sync_playwright() as pw:
        while True:
            try:
                with pw.chromium.launch_persistent_context(
                    str(PROFILE), channel="chrome", headless=not (args.login or args.video_wall or args.same_tab),
                    no_viewport=bool(args.video_wall or args.same_tab), locale="zh-CN", env=browser_env,
                    args=["--mute-audio"], accept_downloads=False,
                ) as context:
                    return poll(context, args, expected, url, token)
            except BrowserError as exc:
                print(f"Chrome 会话不可用（{type(exc).__name__}）。请检查 Chrome 安装、桌面及配置目录占用。",
                      file=sys.stderr, flush=True)
                if args.once or args.login or args.same_tab:
                    return 2
                time.sleep(INTERVAL)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(0)
