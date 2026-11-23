"""Taobao Live PC search page (``tbzb.taobao.com/search``): request policy, passive parsing, cross-check.

The page is opened once per run in Google Chrome with the dedicated monitoring account's cookies.
Two signals come from that single load and must agree before a whitelisted anchor counts as live:

1. the passively captured ``mtop.mediaplatform.live.search.*`` response, read through the
   whitelist's ``api_live_rule``; and
2. the anchor card's button on the rendered page: ``进入`` (live) or only ``主页`` (not live).

The response's live field has not been calibrated. Until a reviewed capture fills ``api_live_rule``,
every anchor stays ``UNKNOWN`` (``api_live_field_uncalibrated``) and the run records the response
shape and the card buttons for calibration. Anchors whose id still awaits the user's confirmation are
matched by exact name, reported with their id candidates, and never notify.
"""

from __future__ import annotations

import re
from collections import deque
from typing import Iterable, Mapping
from urllib.parse import parse_qsl, quote, urlencode, urlsplit, urlunsplit

from core.errors import Code
from core.network import Decision, NetworkPolicy, RequestInfo
from core.safety import classify_unsafe_name

from .classifier import LIMIT, LOGIN_LIMIT, limit_url_kind, parse_json_or_jsonp
from .policy import FONT, MEDIA, MTOP_HOSTS, ali_host, mtop_api

SEARCH_HOST = "tbzb.taobao.com"
SEARCH_URL = "https://tbzb.taobao.com/search?liveSource=pc_live.anchor&searchQuery={query}&spm=tbpc.anchor.nav.dsearch"
SEARCH_API_PREFIX = "mtop.mediaplatform.live.search"
CANONICAL_ROOM = "https://h5.m.taobao.com/taolive/video.html?userId={account_id}"

ENTER, HOME = "进入", "主页"
BUTTON_STATE = {ENTER: "live", HOME: "not_live"}
BADGES = {"直播中", "LIVE", "live", "回放", "预告", "关注", "已关注", ENTER, HOME}

# Hosts the page itself loads besides Taobao/Tmall/alicdn: risk-control and telemetry beacons.
EXTRA_ROOTS = ("alibaba.com", "aliyun.com", "aliapp.org", "mmstat.com")
BEACON_ROOTS = ("mmstat.com", "aliapp.org", "tdum.alibaba.com", "fourier.alibaba.com",
                "fourier.taobao.com", "umdcv4.taobao.com")
LINK_PARAMS = ("id", "liveId", "feedId", "userId", "accountId", "anchorId")
ID_KEYS = ("accountId", "anchorId", "broadcasterId", "userId")
NAME_KEYS = ("accountName", "anchorName", "broadcasterName", "accountNick", "userNick", "nick", "nickName", "shopName")
LIVE_ID_KEYS = ("liveId", "feedId", "roomId")
STATUS_KEY = re.compile(r"live|status|state|stream|onair|playing|broadcast", re.I)
DIGITS = re.compile(r"^\d{5,20}$")
MAX_CANDIDATES = 80
MAX_CARDS = 60
MAX_KEY_PATHS = 300


def search_url(query: str) -> str:
    return SEARCH_URL.format(query=quote(query, safe=""))


def _under(host: str, roots: Iterable[str]) -> bool:
    return any(host == root or host.endswith("." + root) for root in roots)


def family_host(host: str) -> bool:
    return ali_host(host) or _under(host, EXTRA_ROOTS)


class AliSearchPolicy(NetworkPolicy):
    """Search page as a browser loads it: Alibaba family hosts only, no media or fonts, no writes
    except audited MTOP calls with safe names and the page's own risk-control beacons."""

    name = "ali_search"

    def decide(self, request: RequestInfo) -> Decision:
        try:
            parts = urlsplit(request.url)
            host = (parts.hostname or "").lower()
        except ValueError:
            return Decision(False, "unparseable_url")
        if parts.scheme not in {"http", "https"}:
            return Decision(False, "non_http_scheme")
        if request.resource_type in {"media", "font"} or MEDIA.search(parts.path) or FONT.search(parts.path):
            return Decision(False, "heavy_resource_blocked")
        if not family_host(host):
            return Decision(False, "external_requests_blocked")
        if request.is_navigation and request.is_main_frame:
            kind = limit_url_kind(request.url)
            if kind:
                gate = "login_wall" if kind == "login" else "challenge"
                return Decision(False, "gate_navigation_blocked", gate=gate)
        api = mtop_api(parts.path) if host in MTOP_HOSTS else None
        category = classify_unsafe_name(api) if api else None
        if category:
            return Decision(False, "unsafe_function_blocked", name=api, category=category)
        if request.method in {"GET", "HEAD", "OPTIONS"}:
            return Decision(True, "read_allowed", name=api)
        if request.method == "POST" and api:
            return Decision(True, "readonly_post_audited", name=api, known_read=False)
        if request.method == "POST" and _under(host, BEACON_ROOTS):
            return Decision(True, "beacon_post_allowed")
        return Decision(False, "non_api_write_blocked")


def is_search_api(url: str) -> str | None:
    """The MTOP api name when ``url`` is one of the search page's search calls."""
    try:
        parts = urlsplit(url)
    except ValueError:
        return None
    if (parts.hostname or "").lower() not in MTOP_HOSTS:
        return None
    api = mtop_api(parts.path)
    return api if api and api.lower().startswith(SEARCH_API_PREFIX) else None


def classify_ret(payload) -> tuple[Code, str]:
    """Map an MTOP ``ret`` list to the frozen V2 codes (SPEC §3.2)."""
    ret = payload.get("ret") if isinstance(payload, Mapping) else None
    if not isinstance(ret, list) or not ret:
        return Code.SCHEMA_MISMATCH, "missing_ret"
    first = str(ret[0])
    if first.upper().startswith("SUCCESS"):
        return Code.OK, "success"
    joined = " ".join(str(x) for x in ret)
    if LOGIN_LIMIT.search(joined):
        return Code.LOGIN_REQUIRED, "api_login_required"
    if LIMIT.search(joined):
        token = LIMIT.search(joined).group(0).lower()
        return Code.CAPTCHA_X5SEC, f"api_{token}"
    return Code.SCHEMA_MISMATCH, "api_error"


def read_search_response(text: str) -> tuple[Code, str, object | None]:
    try:
        payload = parse_json_or_jsonp(text)
    except ValueError:
        return Code.SCHEMA_MISMATCH, "unparseable_response", None
    code, reason = classify_ret(payload)
    return code, reason, payload


def _scalar(value):
    if isinstance(value, bool) or value is None:
        return value
    if isinstance(value, (int, float)):
        return value
    if isinstance(value, str) and len(value) <= 32:
        return value
    return None


def _first(node: Mapping, keys: Iterable[str], digits: bool):
    for key in keys:
        value = node.get(key)
        if isinstance(value, bool) or value is None:
            continue
        text = str(value).strip()
        if digits and DIGITS.fullmatch(text):
            return key, text
        if not digits and isinstance(value, str) and 0 < len(text) <= 60:
            return key, text
    return None, None


def walk(payload, max_depth: int = 14, max_nodes: int = 40000):
    """Yield ``(shape_path, dict)`` breadth-first in document order; list indexes collapse to ``[]``."""
    stack = deque([("", payload, 0)])
    seen = 0
    while stack and seen < max_nodes:
        path, node, depth = stack.popleft()
        seen += 1
        if depth > max_depth:
            continue
        if isinstance(node, Mapping):
            yield path, node
            for key, value in node.items():
                if isinstance(value, (Mapping, list)):
                    stack.append((f"{path}.{key}" if path else str(key), value, depth + 1))
        elif isinstance(node, list):
            for value in node:
                if isinstance(value, (Mapping, list)):
                    stack.append((f"{path}[]", value, depth + 1))


def key_paths(payload, limit: int = MAX_KEY_PATHS) -> tuple[list[str], bool]:
    """Value-free shape of a response: ``data.result[].accountId`` style paths."""
    paths: set[str] = set()
    truncated = False
    for path, node in walk(payload):
        for key in node:
            full = f"{path}.{key}" if path else str(key)
            if full not in paths:
                if len(paths) >= limit:
                    truncated = True
                    break
                paths.add(full)
    return sorted(paths), truncated


def collect_api_anchors(payload, exclude=None) -> list[dict]:
    """Dicts that carry both an anchor id and a name. ``exclude(id)`` drops the viewer's own id."""
    found: dict[str, dict] = {}
    for path, node in walk(payload):
        id_key, account_id = _first(node, ID_KEYS, digits=True)
        name_key, name = _first(node, NAME_KEYS, digits=False)
        if not account_id or not name or (exclude and exclude(account_id)):
            continue
        live_key, live_id = _first(node, LIVE_ID_KEYS, digits=True)
        if account_id in found:
            found[account_id]["occurrences"] += 1
            if live_id and not found[account_id]["live_id"]:
                found[account_id].update(live_id=live_id, live_id_key=live_key)
            continue
        status = {}
        for key, value in node.items():
            if STATUS_KEY.search(str(key)) and key not in LIVE_ID_KEYS:
                scalar = _scalar(value)
                if scalar is not None or value is None:
                    status[str(key)] = scalar
            if len(status) >= 12:
                break
        found[account_id] = {
            "account_id": account_id, "id_key": id_key, "name": name, "name_key": name_key,
            "live_id": live_id, "live_id_key": live_key, "status_fields": status,
            "keys": sorted(str(k) for k in node)[:60], "path": path, "occurrences": 1,
        }
        if len(found) >= MAX_CANDIDATES:
            break
    return list(found.values())


def api_live_state(candidate: Mapping | None, rule: Mapping | None) -> str | None:
    """``live`` / ``not_live`` from a calibrated rule, else None (uncalibrated or value not listed)."""
    if not candidate or not rule or not rule.get("field"):
        return None
    fields = candidate.get("status_fields") or {}
    if rule["field"] not in fields:
        return None
    value = str(fields[rule["field"]]).lower()
    if value in {str(v).lower() for v in rule.get("live_values", [])}:
        return "live"
    if value in {str(v).lower() for v in rule.get("not_live_values", [])}:
        return "not_live"
    return None


def canonical_link(url: str | None) -> str | None:
    """Alibaba-family link with only id-bearing query parameters kept."""
    if not url:
        return None
    try:
        parts = urlsplit(url)
        host = (parts.hostname or "").lower()
    except ValueError:
        return None
    if parts.scheme not in {"http", "https"} or not family_host(host):
        return None
    query = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=False) if k in LINK_PARAMS and DIGITS.fullmatch(v)]
    return urlunsplit(("https", host, parts.path, urlencode(query), ""))


def link_ids(url: str | None) -> dict:
    if not url:
        return {}
    try:
        return {k: v for k, v in parse_qsl(urlsplit(url).query) if k in LINK_PARAMS and DIGITS.fullmatch(v)}
    except ValueError:
        return {}


def _norm(text) -> str:
    return re.sub(r"\s+", " ", str(text or "")).strip()


def normalize_cards(raw_cards: Iterable[Mapping]) -> list[dict]:
    """Clean what the page script extracted: one entry per card holding a 进入 or 主页 button."""
    cards = []
    for raw in list(raw_cards or [])[:MAX_CARDS]:
        button = _norm(raw.get("button"))
        if button not in BUTTON_STATE:
            continue
        lines = [_norm(line)[:60] for line in (raw.get("lines") or [])[:8] if _norm(line)]
        name = next((line for line in lines if line not in BADGES), None)
        links = []
        for link in [raw.get("button_link"), *(raw.get("links") or [])]:
            clean = canonical_link(link)
            if clean and clean not in links:
                links.append(clean)
        ids: dict[str, str] = {}
        for link in links:
            for key, value in link_ids(link).items():
                ids.setdefault(key, value)
        cards.append({
            "name": name, "button": button, "dom_state": BUTTON_STATE[button], "lines": lines,
            "button_link": canonical_link(raw.get("button_link")), "links": links[:6], "link_ids": ids,
        })
    return cards


def _card_account(card: Mapping) -> str | None:
    ids = card.get("link_ids") or {}
    return ids.get("userId") or ids.get("accountId") or ids.get("anchorId")


def cross_check(whitelist: Mapping, api_candidates: list[dict], cards: list[dict]) -> list[dict]:
    """One result per whitelisted anchor. Only agreement of both signals determines a state."""
    rule = whitelist.get("api_live_rule")
    by_id = {c["account_id"]: c for c in api_candidates}
    results = []
    for anchor in whitelist.get("anchors", []):
        verified = anchor.get("id_status") == "verified" and bool(anchor.get("account_id"))
        name = _norm(anchor.get("display_name"))
        account_id = anchor.get("account_id") if verified else None
        if account_id:
            candidate = by_id.get(account_id)
            id_candidates = []
        else:
            named = [c for c in api_candidates if _norm(c["name"]) == name]
            candidate = named[0] if len(named) == 1 else None
            id_candidates = [{"account_id": c["account_id"], "name": c["name"], "id_key": c["id_key"]} for c in named]
        card_name = _norm(candidate["name"]) if candidate else name
        matched_cards = [c for c in cards if account_id and _card_account(c) == account_id]
        if not matched_cards:
            matched_cards = [c for c in cards if _norm(c.get("name")) in {name, card_name}]
        dom_state = matched_cards[0]["dom_state"] if len(matched_cards) == 1 else None
        api_state = api_live_state(candidate, rule)

        if len(matched_cards) > 1:
            code, reason = Code.SCHEMA_MISMATCH, "ambiguous_cards"
        elif not account_id and len(id_candidates) > 1:
            code, reason = Code.SCHEMA_MISMATCH, "ambiguous_name_candidates"
        elif candidate is None and not matched_cards:
            code, reason = Code.NAV_TIMEOUT, "not_in_search_results"
        elif dom_state is None:
            code, reason = Code.NAV_TIMEOUT, "card_not_rendered"
        elif not rule:
            code, reason = Code.SCHEMA_MISMATCH, "api_live_field_uncalibrated"
        elif candidate is None:
            code, reason = Code.SCHEMA_MISMATCH, "anchor_missing_from_response"
        elif api_state is None:
            code, reason = Code.SCHEMA_MISMATCH, "api_live_value_unrecognized"
        elif api_state != dom_state:
            code, reason = Code.SCHEMA_MISMATCH, "api_dom_disagree"
        elif api_state == "live":
            code, reason = Code.OK, "api_and_card_live"
        else:
            code, reason = Code.OFFLINE, "api_and_card_not_live"

        live_status = "live" if code == Code.OK else "offline" if code == Code.OFFLINE else "unknown"
        resolved_id = account_id or (candidate["account_id"] if candidate else None)
        card = matched_cards[0] if len(matched_cards) == 1 else None
        room_link = card["button_link"] if card and card["dom_state"] == "live" else None
        results.append({
            "key": anchor.get("key"), "display_name": anchor.get("display_name"),
            "account_id": account_id, "id_status": anchor.get("id_status"),
            "notify_eligible": verified, "code": code.value, "reason": reason, "live_status": live_status,
            "dom_state": dom_state, "api_state": api_state,
            "api_live_id": candidate.get("live_id") if candidate else None,
            "room_link": room_link,
            "room_url": CANONICAL_ROOM.format(account_id=resolved_id) if resolved_id and verified else None,
            "id_candidates": id_candidates,
        })
    return results


def summarize(results: list[dict], cards: list[dict], whitelist: Mapping) -> dict:
    names = {_norm(a.get("display_name")) for a in whitelist.get("anchors", [])}
    by_code: dict[str, int] = {}
    for row in results:
        by_code[row["code"]] = by_code.get(row["code"], 0) + 1
    return {
        "whitelist_total": len(results),
        "by_code": dict(sorted(by_code.items())),
        "cards_total": len(cards),
        "cards_enter": sum(1 for c in cards if c["dom_state"] == "live"),
        "cards_home": sum(1 for c in cards if c["dom_state"] == "not_live"),
        "other_enter_cards": sum(1 for c in cards if c["dom_state"] == "live" and _norm(c.get("name")) not in names),
        "api_calibrated": bool(whitelist.get("api_live_rule")),
    }


# Runs in the page. Finds each 进入/主页 button and climbs to the largest ancestor that still holds
# exactly one such button: that ancestor is the anchor card.
EXTRACT_CARDS_JS = r"""
() => {
  const LABELS = new Set(['进入', '主页']);
  const norm = s => (s || '').replace(/\s+/g, ' ').trim();
  const all = [...document.querySelectorAll('a,button,div,span')];
  const buttons = all.filter(el => LABELS.has(norm(el.innerText))
    && ![...el.children].some(c => LABELS.has(norm(c.innerText))));
  const out = [];
  const seen = new Set();
  for (const btn of buttons) {
    let card = btn;
    while (card.parentElement && card.parentElement !== document.body) {
      const parent = card.parentElement;
      if (buttons.filter(b => parent.contains(b)).length > 1) break;
      card = parent;
    }
    if (seen.has(card)) continue;
    seen.add(card);
    const lines = [];
    const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node && lines.length < 8; node = walker.nextNode()) {
      const text = norm(node.textContent);
      const host = node.parentElement;
      if (text && host && host.getClientRects().length) lines.push(text.slice(0, 60));
    }
    const links = [...card.querySelectorAll('a[href]')].map(a => a.href);
    const outer = card.closest('a[href]');
    if (outer) links.push(outer.href);
    const own = btn.closest('a[href]');
    out.push({ button: norm(btn.innerText), lines, links: links.slice(0, 8), button_link: own ? own.href : null });
    if (out.length >= 60) break;
  }
  return out;
}
"""
