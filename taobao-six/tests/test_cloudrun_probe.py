"""CloudBase risk-control probe: classification, HTTP endpoint rules and a local-page browser run.
Offline: the browser test answers every request locally and is skipped without a launchable browser."""
import json
import os
import sys
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "cloudrun"))
import probe_core as core
import probe_server as server

TOKEN = "test-token-0123456789"
# Shapes observed 2026-11-23 from outside mainland China (values trimmed).
ILLEGAL = 'mtopjsonp3({"api":"mtop.roomstudio.live.detail.get","v":"1.0","ret":["FAIL_SYS_ILLEGAL_ACCESS::非法请求"],"data":{}})'
TOKEN_EMPTY = 'mtopjsonp1({"api":"mtop.roomstudio.live.detail.get","ret":["FAIL_SYS_TOKEN_EMPTY::令牌为空"],"data":{}})'
SUCCESS = ('mtopjsonp2({"api":"mtop.roomstudio.live.detail.get","ret":["SUCCESS::调用成功"],'
           '"data":{"roomStatus":"1","status":"0","streamStatus":"1","liveId":"1395749701542483"}})')


class Classification(unittest.TestCase):
    def test_inputs(self):
        self.assertTrue(core.valid_live_id("1395749701542483"))
        for bad in ["0123456", "12", "1395749701542483&x=1", "../shot", None, 1395749701542483]:
            self.assertFalse(core.valid_live_id(bad), bad)
        self.assertTrue(core.token_ok(TOKEN, TOKEN))
        self.assertFalse(core.token_ok("wrong-token-0123456789", TOKEN))
        self.assertFalse(core.token_ok("short", "short"))           # a short server token authorizes nothing
        self.assertFalse(core.token_ok(None, TOKEN))

    def test_request_recognition(self):
        self.assertTrue(core.is_detail("https://h5api.m.taobao.com/h5/mtop.roomstudio.live.detail.get/1.0/?jsv=2"))
        self.assertFalse(core.is_detail("https://h5api.m.taobao.com/h5/mtop.contentlivekit.detail.componentlist/2.0/"))
        self.assertTrue(core.is_stream("livecb.alicdn.com", "/mediaplatform/abc.flv"))
        self.assertTrue(core.is_stream("live-spare.alicdn.com", "/x"))
        self.assertFalse(core.is_stream("g.alicdn.com", "/app.js"))

    def test_detail_bodies(self):
        self.assertEqual(core.read_detail(ILLEGAL), ("FAIL_SYS_ILLEGAL_ACCESS::非法请求", {}))
        self.assertEqual(core.read_detail(SUCCESS), ("SUCCESS::调用成功", {"roomStatus": "1", "streamStatus": "1"}))
        self.assertEqual(core.read_detail("<html>"), (None, {}))

    def test_verdicts(self):
        playing = {"present": True, "advanced": True, "width": 720, "height": 1280}
        still = {"present": False, "advanced": False}
        token_then_illegal = ["FAIL_SYS_TOKEN_EMPTY::令牌为空", "FAIL_SYS_ILLEGAL_ACCESS::非法请求"]
        self.assertEqual(core.classify(token_then_illegal, [], [], still, ["加载失败"])[0], "refused")
        self.assertEqual(core.classify(["SUCCESS::ok"], [], [{"status": 400, "host": "tbzb.taobao.com"}], still, []),
                         ("refused", "HTTP 400"))
        self.assertEqual(core.classify(["SUCCESS::ok"], [{"status": 403, "host": "livecb.alicdn.com"}], [], still, []),
                         ("refused", "HTTP 403"))
        self.assertEqual(core.classify(["FAIL_SYS_TOKEN_EMPTY::x", "SUCCESS::ok"], [{"status": 200}], [], playing, [])[0], "playing")
        self.assertEqual(core.classify(["SUCCESS::ok"], [], [], still, [])[0], "data_ok")
        self.assertEqual(core.classify(["FAIL_SYS_TOKEN_EMPTY::x"], [], [], still, [])[0], "inconclusive")
        # A 404 on some image is not a refusal.
        self.assertEqual(core.classify(["SUCCESS::ok"], [], [{"status": 404, "host": "img.alicdn.com"}], still, [])[0], "data_ok")

    def test_video_progress(self):
        self.assertEqual(core.video_progress([None, None])["present"], False)
        moving = [{"t": 0.0, "w": 720, "h": 1280}, {"t": 0.9, "w": 720, "h": 1280}, {"t": 2.1, "w": 720, "h": 1280}]
        self.assertTrue(core.video_progress(moving)["advanced"])
        frozen = [{"t": 3.0, "w": 720, "h": 1280}] * 4
        self.assertFalse(core.video_progress(frozen)["advanced"])
        no_frame = [{"t": 0.0, "w": 0}, {"t": 5.0, "w": 0}]
        self.assertFalse(core.video_progress(no_frame)["advanced"])


class Endpoints(unittest.TestCase):
    def setUp(self):
        self.calls = []

        def fake_probe(live_id, headless=False):
            self.calls.append((live_id, headless))
            return {"liveId": live_id, "verdict": "refused", "reason": "FAIL_SYS_ILLEGAL_ACCESS::非法请求", "shot": None}

        handler = type("H", (server.Handler,), {"probe": staticmethod(fake_probe), "log_message": lambda *a: None})
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.addCleanup(self.httpd.server_close)
        self.addCleanup(self.httpd.shutdown)
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        state = patch.dict(server.STATE, {"last_finished": 0.0, "results": []})
        state.start()
        self.addCleanup(state.stop)
        env = patch.dict(os.environ, {"PROBE_TOKEN": TOKEN})
        env.start()
        self.addCleanup(env.stop)

    def call(self, method, path, body=None, token=TOKEN):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method)
        if token:
            req.add_header("x-probe-token", token)
        try:
            with urllib.request.urlopen(req, timeout=10) as res:
                raw = res.read()
                return res.status, raw, res.headers
        except urllib.error.HTTPError as err:
            return err.code, err.read(), err.headers

    def test_health_and_control_page_need_no_token(self):
        self.assertEqual(self.call("GET", "/healthz", token=None)[:2], (200, b"ok"))
        status, page, headers = self.call("GET", "/", token=None)
        self.assertEqual(status, 200)
        self.assertIn("1395749701542483\n3275552239423375", page.decode())
        self.assertNotIn("__DEFAULT_IDS__", page.decode())
        self.assertEqual(headers["Cache-Control"], "no-store")

    def test_probe_rules(self):
        self.assertEqual(self.call("POST", "/probe", {"liveId": "1395749701542483"}, token="wrong-token-000000")[0], 401)
        self.assertEqual(self.call("POST", "/probe", {"liveId": "javascript:1"})[0], 400)
        status, raw, _ = self.call("POST", "/probe", {"liveId": "1395749701542483", "headless": True})
        self.assertEqual((status, json.loads(raw)["verdict"]), (200, "refused"))
        self.assertEqual(self.calls, [("1395749701542483", True)])
        status, raw, _ = self.call("POST", "/probe", {"liveId": "3275552239423375"})
        self.assertEqual((status, json.loads(raw)["error"]), (429, "too_soon"))   # minimum gap enforced
        self.assertEqual(len(self.calls), 1)
        server.LOCK.acquire()
        try:
            server.STATE["last_finished"] = 0.0
            self.assertEqual(self.call("POST", "/probe", {"liveId": "3275552239423375"})[0], 409)  # one at a time
        finally:
            server.LOCK.release()
        status, raw, _ = self.call("GET", "/results")
        self.assertEqual((status, json.loads(raw)["summary"]), (200, {"total": 1, "by_verdict": {"refused": 1}}))
        self.assertEqual(self.call("GET", "/results", token=None)[0], 401)

    def test_unconfigured_token_refuses_probes(self):
        with patch.dict(os.environ, {"PROBE_TOKEN": "short"}):
            self.assertEqual(self.call("POST", "/probe", {"liveId": "1395749701542483"}, token="short")[0], 503)
        self.assertEqual(self.calls, [])

    def test_screenshots_need_a_token_and_a_plain_name(self):
        self.assertEqual(self.call("GET", "/shot/" + "a" * 32 + ".jpg", token=None)[0], 401)
        self.assertEqual(self.call("GET", "/shot/..%2F..%2Fetc%2Fpasswd")[0], 404)
        self.assertEqual(self.call("GET", "/shot/" + "a" * 32 + ".jpg")[0], 404)


FAKE_ROOM = """<html><head><title>{title}</title></head><body><div id=player>加载中</div>
<script>function cb(r){{ document.getElementById('player').textContent = r.ret[0].startsWith('SUCCESS') ? '主播在线' : '加载失败'; }}</script>
<script src="https://h5api.m.taobao.com/h5/mtop.roomstudio.live.detail.get/1.0/?callback=cb"></script></body></html>"""


class LocalPageRun(unittest.TestCase):
    """run_probe end to end in a real browser; every request is answered locally."""

    def run_against(self, detail_body):
        try:
            from playwright.sync_api import Error  # noqa: F401
        except ImportError:  # pragma: no cover
            self.skipTest("Playwright unavailable")
        exe = os.environ.get("DASHBOARD_CHROMIUM")

        def launcher(pw):
            return pw.chromium.launch(**({"executable_path": exe} if exe else {"channel": "chrome"}))

        def prepare(context):
            def answer(route):
                url = route.request.url
                if url.startswith("https://tbzb.taobao.com/live?liveId="):
                    route.fulfill(status=200, content_type="text/html; charset=utf-8",
                                  body=FAKE_ROOM.format(title="TCL电视官方旗舰店 - 淘宝直播"))
                elif "mtop.roomstudio.live.detail.get" in url:
                    route.fulfill(status=200, content_type="application/javascript; charset=utf-8",
                                  body=detail_body.replace("mtopjsonp3(", "cb(").replace("mtopjsonp2(", "cb("))
                else:
                    route.abort()
            context.route("**/*", answer)

        with patch.object(server, "WATCH_SECONDS", 3):
            try:
                return server.run_probe("1395749701542483", headless=True, launcher=launcher, prepare=prepare)
            except Exception as exc:  # pragma: no cover - environment dependent
                if "Executable doesn't exist" in str(exc) or "channel" in str(exc).lower():
                    self.skipTest(f"no launchable browser: {type(exc).__name__}")
                raise

    def test_refused_room_data_is_reported_with_its_marker(self):
        result = self.run_against(ILLEGAL)
        self.assertEqual((result["verdict"], result["doc_status"]), ("refused", 200))
        self.assertEqual(result["detail_rets"], ["FAIL_SYS_ILLEGAL_ACCESS::非法请求"])
        self.assertIn("加载失败", result["markers"])
        self.assertTrue(result["shot"])

    def test_accepted_room_data_without_video_is_data_ok(self):
        result = self.run_against(SUCCESS)
        self.assertEqual((result["verdict"], result["room_status"], result["stream_status"]), ("data_ok", "1", "1"))
        self.assertEqual(result["title"], "TCL电视官方旗舰店 - 淘宝直播")


if __name__ == "__main__":
    unittest.main()
