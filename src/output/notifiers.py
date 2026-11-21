"""DingTalk / Feishu / WeCom / Bark webhooks. The URL and secret are never logged or persisted."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
import urllib.request
from typing import Callable, Mapping
from urllib.parse import quote_plus, urlsplit

Transport = Callable[[str, bytes, dict], tuple[int, bytes]]
KINDS = ("dingtalk", "feishu", "wecom", "bark")
LIMITS = {"dingtalk": 3500, "feishu": 3500, "wecom": 2000, "bark": 900}


class NotifyError(ValueError):
    pass


def detect_kind(url: str) -> str:
    host = (urlsplit(url).hostname or "").lower()
    if host == "oapi.dingtalk.com":
        return "dingtalk"
    if host in ("open.feishu.cn", "open.larksuite.com"):
        return "feishu"
    if host == "qyapi.weixin.qq.com":
        return "wecom"
    if host == "api.day.app" or host.startswith("bark."):
        return "bark"
    raise NotifyError("Cannot infer WEBHOOK_KIND from the webhook host; set WEBHOOK_KIND")


def build_request(kind: str, url: str, title: str, text: str, secret: str | None = None,
                  now: float | None = None) -> tuple[str, bytes, dict]:
    if urlsplit(url).scheme != "https":
        raise NotifyError("Webhook URL must use https")
    now = time.time() if now is None else now
    text = text[:LIMITS[kind]]
    headers = {"Content-Type": "application/json; charset=utf-8"}
    if kind == "dingtalk":
        if secret:
            stamp = str(int(round(now * 1000)))
            digest = hmac.new(secret.encode(), f"{stamp}\n{secret}".encode(), hashlib.sha256).digest()
            url += ("&" if "?" in url else "?") + f"timestamp={stamp}&sign={quote_plus(base64.b64encode(digest))}"
        body = {"msgtype": "text", "text": {"content": f"{title}\n{text}"}}
    elif kind == "feishu":
        body = {"msg_type": "text", "content": {"text": f"{title}\n{text}"}}
        if secret:
            stamp = str(int(now))
            digest = hmac.new(f"{stamp}\n{secret}".encode(), digestmod=hashlib.sha256).digest()
            body.update(timestamp=stamp, sign=base64.b64encode(digest).decode())
    elif kind == "wecom":
        body = {"msgtype": "text", "text": {"content": f"{title}\n{text}"}}
    elif kind == "bark":
        body = {"title": title, "body": text, "group": "tcl-live-monitor"}
    else:
        raise NotifyError("Unsupported WEBHOOK_KIND")
    return url, json.dumps(body, ensure_ascii=False).encode("utf-8"), headers


def urllib_transport(url: str, data: bytes, headers: dict) -> tuple[int, bytes]:
    request = urllib.request.Request(url, data=data, headers=headers, method="POST")
    with urllib.request.urlopen(request, timeout=10) as response:  # noqa: S310 (https enforced above)
        return response.status, response.read(64 * 1024)


def accepted(kind: str, status: int, raw: bytes) -> bool:
    if not 200 <= status < 300:
        return False
    try:
        data = json.loads(raw.decode("utf-8") or "{}")
    except (ValueError, UnicodeError):
        return kind == "bark"
    if kind in ("dingtalk", "wecom"):
        return data.get("errcode") == 0
    if kind == "feishu":
        return data.get("code", data.get("StatusCode")) == 0
    return data.get("code", 200) == 200


def send(title: str, text: str, env: Mapping[str, str], transport: Transport = urllib_transport) -> dict:
    url = (env.get("WEBHOOK_URL") or "").strip()
    if not url:
        return {"status": "not_configured"}
    try:
        kind = (env.get("WEBHOOK_KIND") or "").strip().lower() or detect_kind(url)
        if kind not in KINDS:
            raise NotifyError("Unsupported WEBHOOK_KIND")
        target, body, headers = build_request(kind, url, title, text, env.get("WEBHOOK_SECRET") or None)
        status, raw = transport(target, body, headers)
        return {"status": "sent" if accepted(kind, status, raw) else "rejected", "kind": kind, "http": status}
    except NotifyError as error:
        return {"status": "config_error", "detail": str(error)}
    except Exception as error:  # network failure must not fail the run
        return {"status": "transport_error", "error_type": type(error).__name__}
