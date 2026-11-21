"""Google Drive sync over OAuth 2.0 with the ``drive.file`` scope only (SPEC.md section 9).

* Reports (a zip of the evidence pack and dashboard) are kept forever.
* Thumbnails carry ``appProperties.tcl_live_monitor=thumbnail``; those older than 24 h are
  removed with ``DELETE files/{id}``, which deletes permanently and skips the trash.
* The token response must grant exactly ``drive.file``; anything broader is refused.
"""

from __future__ import annotations

import io
import json
import re
import urllib.error
import urllib.request
import uuid
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable, Mapping
from urllib.parse import quote, urlencode

TOKEN_URL = "https://oauth2.googleapis.com/token"
API = "https://www.googleapis.com/drive/v3/files"
UPLOAD = "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,createdTime"
SCOPE = "https://www.googleapis.com/auth/drive.file"
APP_KEY = "tcl_live_monitor"
FOLDER_MIME = "application/vnd.google-apps.folder"
DEFAULT_FOLDER = "tcl-live-monitor-v2"
THUMBNAIL_TTL = timedelta(hours=24)
FOLDER_ID = re.compile(r"^[A-Za-z0-9_-]{10,100}$")
SAFE_NAME = re.compile(r"^[A-Za-z0-9 _.-]{1,80}$")
REQUIRED = ("GDRIVE_CLIENT_ID", "GDRIVE_CLIENT_SECRET", "GDRIVE_REFRESH_TOKEN")

Transport = Callable[[str, str, dict, bytes | None], tuple[int, bytes]]


class DriveError(RuntimeError):
    pass


class ScopeError(DriveError):
    pass


def urllib_transport(method: str, url: str, headers: dict, body: bytes | None) -> tuple[int, bytes]:
    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:  # noqa: S310 (fixed https hosts)
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read(4096)


def refresh_access_token(env: Mapping[str, str], transport: Transport) -> str:
    body = urlencode({"client_id": env["GDRIVE_CLIENT_ID"], "client_secret": env["GDRIVE_CLIENT_SECRET"],
                      "refresh_token": env["GDRIVE_REFRESH_TOKEN"], "grant_type": "refresh_token"}).encode()
    status, raw = transport("POST", TOKEN_URL, {"Content-Type": "application/x-www-form-urlencoded"}, body)
    if status != 200:
        raise DriveError(f"token refresh failed with HTTP {status}")
    try:
        data = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeError):
        raise DriveError("token response is not JSON") from None
    granted = set(str(data.get("scope") or "").split())
    if granted != {SCOPE}:
        raise ScopeError("refresh token must be limited to exactly the drive.file scope")
    token = data.get("access_token")
    if not isinstance(token, str) or not token:
        raise DriveError("token response has no access_token")
    return token


class DriveClient:
    def __init__(self, token: str, transport: Transport):
        self._token, self._transport = token, transport

    def __repr__(self) -> str:
        return "DriveClient(token=<redacted>)"

    def _call(self, method: str, url: str, body: bytes | None = None, content_type: str | None = None,
              expect: tuple[int, ...] = (200,)) -> dict:
        headers = {"Authorization": f"Bearer {self._token}"}
        if content_type:
            headers["Content-Type"] = content_type
        status, raw = self._transport(method, url, headers, body)
        if status not in expect:
            raise DriveError(f"Drive {method} failed with HTTP {status}")
        if not raw:
            return {}
        try:
            return json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeError):
            raise DriveError("Drive response is not JSON") from None

    def list(self, query: str, fields: str = "nextPageToken,files(id,name,createdTime,appProperties)") -> list[dict]:
        found, token = [], None
        for _ in range(20):
            params = {"q": query, "fields": fields, "spaces": "drive", "pageSize": "200"}
            if token:
                params["pageToken"] = token
            data = self._call("GET", API + "?" + urlencode(params, quote_via=quote))
            found.extend(item for item in data.get("files", []) if isinstance(item, dict))
            token = data.get("nextPageToken")
            if not token:
                break
        return found

    def folder(self, name: str) -> str:
        if not SAFE_NAME.fullmatch(name):
            raise DriveError("GDRIVE_FOLDER_NAME has unsupported characters")
        query = (f"name = '{name}' and mimeType = '{FOLDER_MIME}' and trashed = false and "
                 f"appProperties has {{ key='{APP_KEY}' and value='root' }}")
        existing = self.list(query, "nextPageToken,files(id,name)")
        if existing:
            return existing[0]["id"]
        meta = json.dumps({"name": name, "mimeType": FOLDER_MIME, "appProperties": {APP_KEY: "root"}}).encode()
        return self._call("POST", API + "?fields=id", meta, "application/json; charset=UTF-8")["id"]

    def upload(self, folder: str, name: str, data: bytes, mime: str, kind: str, run_id: str) -> str:
        boundary = "tcl" + uuid.uuid4().hex
        meta = {"name": name, "parents": [folder], "appProperties": {APP_KEY: kind, "run_id": run_id[:60]}}
        body = (f"--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{json.dumps(meta)}\r\n"
                f"--{boundary}\r\nContent-Type: {mime}\r\n\r\n").encode() + data + f"\r\n--{boundary}--\r\n".encode()
        return self._call("POST", UPLOAD, body, f"multipart/related; boundary={boundary}")["id"]

    def expired_thumbnails(self, folder: str, cutoff: datetime) -> list[dict]:
        stamp = cutoff.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")
        query = (f"'{folder}' in parents and trashed = false and "
                 f"appProperties has {{ key='{APP_KEY}' and value='thumbnail' }} and createdTime < '{stamp}'")
        return self.list(query)

    def delete_permanently(self, file_id: str) -> None:
        if not FOLDER_ID.fullmatch(file_id):
            raise DriveError("unexpected Drive file id")
        self._call("DELETE", f"{API}/{file_id}", expect=(200, 204))


def _created(item: dict) -> datetime | None:
    try:
        return datetime.fromisoformat(str(item.get("createdTime", "")).replace("Z", "+00:00"))
    except ValueError:
        return None


def report_zip(evidence_dir: Path) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(evidence_dir.rglob("*")):
            relative = path.relative_to(evidence_dir).as_posix()
            if path.is_file() and not relative.startswith("thumbs/"):
                archive.write(path, relative)
    return buffer.getvalue()


def sync(evidence_dir: Path, run_id: str, env: Mapping[str, str], transport: Transport = urllib_transport,
         now: datetime | None = None) -> dict:
    if not all(env.get(name) for name in REQUIRED):
        return {"status": "not_configured"}
    now = now or datetime.now(timezone.utc)
    try:
        client = DriveClient(refresh_access_token(env, transport), transport)
        folder = (env.get("GDRIVE_FOLDER_ID") or "").strip()
        if folder and not FOLDER_ID.fullmatch(folder):
            raise DriveError("GDRIVE_FOLDER_ID has an unexpected format")
        folder = folder or client.folder((env.get("GDRIVE_FOLDER_NAME") or DEFAULT_FOLDER).strip())
        stamp = now.strftime("%Y%m%dT%H%M%SZ")
        safe_run = re.sub(r"[^A-Za-z0-9_.-]", "_", run_id)[:40]
        report = client.upload(folder, f"tcl-v2-report-{safe_run}-{stamp}.zip", report_zip(evidence_dir),
                               "application/zip", "report", run_id)
        uploaded = 0
        for thumb in sorted((evidence_dir / "thumbs").glob("*.jpg")):
            client.upload(folder, f"thumb-{safe_run}-{thumb.name}", thumb.read_bytes(), "image/jpeg", "thumbnail", run_id)
            uploaded += 1
        cutoff, deleted = now - THUMBNAIL_TTL, 0
        for item in client.expired_thumbnails(folder, cutoff):
            created = _created(item)
            # Re-check locally: only app-tagged thumbnails strictly older than 24 h are deleted.
            if (item.get("appProperties") or {}).get(APP_KEY) == "thumbnail" and created and created < cutoff:
                client.delete_permanently(item["id"])
                deleted += 1
        return {"status": "synced", "report_file_id": report, "thumbnails_uploaded": uploaded,
                "thumbnails_deleted": deleted}
    except ScopeError:
        return {"status": "refused_scope"}
    except DriveError as error:
        return {"status": "error", "detail": str(error)}
    except Exception as error:
        return {"status": "error", "error_type": type(error).__name__}
