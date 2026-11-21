"""Tmall/Taobao network policies: one for short-link discovery, one for live monitoring."""

from __future__ import annotations

import re
from urllib.parse import urlsplit

from core.network import Decision, NetworkPolicy, RequestInfo
from core.safety import classify_unsafe_name

from .business import ITEM_PATH

ALI_ROOTS = ("taobao.com", "tmall.com", "tb.cn", "alicdn.com", "tbcdn.cn", "taobaocdn.com")
MTOP_HOSTS = {"h5api.m.taobao.com", "h5api.m.tmall.com"}
MTOP_API = re.compile(r"^/h5/(mtop\.[a-z0-9._-]{1,160})/\d+\.\d+/?$", re.I)
MEDIA = re.compile(r"\.(?:mp[34]|m3u8|flv|aac|ts|m4s|mpd|webm)(?:$|/)", re.I)
FONT = re.compile(r"\.(?:woff2?|ttf|otf|eot)(?:$|/)", re.I)


def ali_host(host: str) -> bool:
    return any(host == root or host.endswith("." + root) for root in ALI_ROOTS)


def mtop_api(path: str) -> str | None:
    match = MTOP_API.fullmatch(path)
    return match.group(1) if match else None


class AliDiscoveryPolicy(NetworkPolicy):
    """Short-link landing only: Alibaba hosts, reads, and MTOP calls whose api name is safe."""

    name = "ali_discovery"

    def decide(self, request: RequestInfo) -> Decision:
        try:
            parts = urlsplit(request.url)
            host = (parts.hostname or "").lower()
        except ValueError:
            return Decision(False, "unparseable_url")
        if parts.scheme not in {"http", "https"}:
            return Decision(False, "non_http_scheme")
        if request.resource_type in {"media", "font", "image"} or MEDIA.search(parts.path) or FONT.search(parts.path):
            return Decision(False, "heavy_resource_blocked")
        if not ali_host(host):
            return Decision(False, "external_requests_blocked")
        api = mtop_api(parts.path) if host in MTOP_HOSTS else None
        category = classify_unsafe_name(api) if api else None
        if category:
            return Decision(False, "unsafe_function_blocked", name=api, category=category)
        if request.method in {"GET", "HEAD", "OPTIONS"}:
            return Decision(True, "read_allowed", name=api)
        if request.method == "POST" and api:
            return Decision(True, "readonly_post_audited", name=api, known_read=False)
        return Decision(False, "non_api_write_blocked")


class AliMonitorPolicy(NetworkPolicy):
    """The guest live page as probes/r329 loaded it, minus stream media and fonts."""

    name = "ali_monitor"

    def __init__(self, block_images: bool = False):
        self.block_images = block_images
        self.block_itemlist = False

    def decide(self, request: RequestInfo) -> Decision:
        try:
            parts = urlsplit(request.url)
            path = parts.path
            if self.block_itemlist and parts.hostname in MTOP_HOSTS and path.rstrip("/") == ITEM_PATH:
                return Decision(False, "itemlist_access_limited")
        except ValueError:
            return Decision(False, "unparseable_url")
        if request.resource_type == "media" or MEDIA.search(path):
            return Decision(False, "media_blocked")
        if request.resource_type == "font" or FONT.search(path):
            return Decision(False, "font_blocked")
        if self.block_images and request.resource_type == "image":
            return Decision(False, "image_blocked")
        return Decision(True, "allowed")
