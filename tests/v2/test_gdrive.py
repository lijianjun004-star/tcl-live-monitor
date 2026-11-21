"""Drive sync: drive.file only, reports kept, thumbnails older than 24 h permanently deleted."""

import json
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs, urlsplit

from output import gdrive_sync

NOW = datetime(2026, 11, 20, 12, 0, tzinfo=timezone.utc)
ENV = {"GDRIVE_CLIENT_ID": "cid", "GDRIVE_CLIENT_SECRET": "csecret", "GDRIVE_REFRESH_TOKEN": "rtoken"}


class FakeDrive:
    def __init__(self, scope=gdrive_sync.SCOPE, listing=None):
        self.scope, self.listing, self.calls = scope, listing or [], []

    def __call__(self, method, url, headers, body):
        self.calls.append((method, url, headers, body))
        if url == gdrive_sync.TOKEN_URL:
            return 200, json.dumps({"access_token": "AT", "scope": self.scope, "expires_in": 3599}).encode()
        assert headers.get("Authorization") == "Bearer AT"
        if method == "GET":
            query = parse_qs(urlsplit(url).query)["q"][0]
            if "vnd.google-apps.folder" in query:
                return 200, b'{"files": []}'
            return 200, json.dumps({"files": self.listing}).encode()
        if method == "POST" and "upload" in url:
            return 200, json.dumps({"id": f"file{len(self.calls):04d}abcdef"}).encode()
        if method == "POST":
            return 200, b'{"id": "folder0000abcdef"}'
        if method == "DELETE":
            return 204, b""
        raise AssertionError(method)


def evidence(tmp_path):
    root = tmp_path / "ev"
    (root / "thumbs").mkdir(parents=True)
    (root / "run_summary.json").write_text("{}")
    (root / "index.html").write_text("<html></html>")
    (root / "thumbs" / "jd-a.jpg").write_bytes(b"\xff\xd8jpeg")
    return root


def item(file_id, kind, age_hours):
    created = (NOW - timedelta(hours=age_hours)).isoformat().replace("+00:00", "Z")
    return {"id": file_id, "createdTime": created, "appProperties": {gdrive_sync.APP_KEY: kind}}


def test_not_configured_without_all_three_secrets(tmp_path):
    assert gdrive_sync.sync(tmp_path, "r", {"GDRIVE_CLIENT_ID": "x"}, FakeDrive()) == {"status": "not_configured"}


def test_broader_scope_is_refused_before_any_drive_call(tmp_path):
    for index, scope in enumerate(("https://www.googleapis.com/auth/drive", gdrive_sync.SCOPE + " openid", "")):
        drive = FakeDrive(scope=scope)
        assert gdrive_sync.sync(evidence(tmp_path / str(index)), "r", ENV, drive, NOW) == {"status": "refused_scope"}
        assert len(drive.calls) == 1


def test_sync_uploads_report_and_thumbs_and_deletes_only_old_thumbnails(tmp_path):
    listing = [item("oldthumb00001", "thumbnail", 30), item("newthumb00001", "thumbnail", 2),
               item("oldreport0001", "report", 300)]
    drive = FakeDrive(listing=listing)
    result = gdrive_sync.sync(evidence(tmp_path), "4472.1", ENV, drive, NOW)
    assert result["status"] == "synced" and result["thumbnails_uploaded"] == 1 and result["thumbnails_deleted"] == 1
    deletes = [url for method, url, *_ in drive.calls if method == "DELETE"]
    assert deletes == [f"{gdrive_sync.API}/oldthumb00001"]          # DELETE = permanent, never PATCH trashed
    assert not any(method == "PATCH" for method, *_ in drive.calls)
    uploads = [body for method, url, _, body in drive.calls if method == "POST" and "upload" in url]
    assert b'"tcl_live_monitor": "report"' in uploads[0] and b"application/zip" in uploads[0]
    assert b'"tcl_live_monitor": "thumbnail"' in uploads[1]
    listing_query = [parse_qs(urlsplit(url).query)["q"][0] for method, url, *_ in drive.calls
                     if method == "GET" and "thumbnail" in url]
    assert "createdTime < '2026-11-19T12:00:00'" in listing_query[0]


def test_token_and_secrets_never_reach_the_result(tmp_path):
    result = gdrive_sync.sync(evidence(tmp_path), "r", ENV, FakeDrive(), NOW)
    text = json.dumps(result)
    assert "AT" not in text.replace("AT_", "") and "rtoken" not in text and "csecret" not in text
    assert repr(gdrive_sync.DriveClient("AT", FakeDrive())) == "DriveClient(token=<redacted>)"
