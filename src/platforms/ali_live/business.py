"""Project bounded business evidence from the two public MTOP responses used by the room page."""

import json
import re
from urllib.parse import parse_qs, urlsplit

from .classifier import DETAIL_HOST, DETAIL_PATH

ITEM_PATH = "/h5/mtop.mediaplatform.video.livedetail.itemlist/1.0"
FIELD_SOURCE = {"online_count": "livedetail", "item_title": "itemlist", "item_price": "itemlist"}
TOP_KEYS = {"api", "data", "ret", "v"}
COUNT_KEYS = ("onlineCount", "onlineUserCount", "onlineNum")
LIST_KEYS = ("itemList", "items", "goodsList")
DATA_KEYS = {*COUNT_KEYS, *LIST_KEYS, "accountId", "broadCaster", "liveId", "roomNum", "roomStatus",
             "streamStatus", "startTime", "totalCount", "itemCount", "hasNext", "hasMore", "result",
             "liveInfo", "itemInfo", "viewCount", "watchCount", "viewCountFmt", "totalViewCount"}
ITEM_KEYS = {"title", "itemTitle", "itemName", "price", "itemPrice", "itemId", "itemInfo", "itemPic"}
PRICE = re.compile(r"(?:0|[1-9][0-9]{0,7})(?:\.[0-9]{1,2})?")
COUNT = re.compile(r"(?:0|[1-9][0-9]{0,11})")
TITLE = re.compile(r"[\u3400-\u9fffA-Za-z0-9\s\-+（）()【】\[\]，,。·/&×%℃.]{1,100}")
PRIVATE = re.compile(r"https?[:/]|www\.|(?:^|\D)1[3-9]\d{9}(?!\d)|token|cookie|password|私信|微信", re.I)


def endpoint(url):
    parts = urlsplit(url)
    if parts.scheme != "https" or parts.hostname != DETAIL_HOST:
        return None
    return {DETAIL_PATH: "livedetail", ITEM_PATH: "itemlist"}.get(parts.path.rstrip("/"))


def request_live_id(url, post_data):
    """Use an explicit public session ID only. Do not emit or retain request data."""
    sources = [urlsplit(url).query]
    if isinstance(post_data, str) and len(post_data) <= 65536:
        sources.append(post_data)
    ids = set()
    for source in sources:
        if len(source) > 65536:
            continue
        try:
            query = parse_qs(source, max_num_fields=128)
        except ValueError:
            continue
        ids.update(str(v) for v in query.get("liveId", []))
        for encoded in query.get("data", [])[:2]:
            try:
                data = json.loads(encoded)
            except (ValueError, RecursionError):
                continue
            if isinstance(data, dict) and "liveId" in data:
                ids.add(str(data["liveId"]))
    return ids.pop() if len(ids) == 1 else None


def business_sample(source, status, payload, live_id=None):
    obj = payload if isinstance(payload, dict) else {}
    data = obj.get("data")
    data = data if isinstance(data, dict) else {}
    shape = {"http_status": status, "top_keys": sorted(TOP_KEYS.intersection(obj)),
             "other_top_key_count": len(obj.keys() - TOP_KEYS), "data_keys": sorted(DATA_KEYS.intersection(data)),
             "other_data_key_count": len(data.keys() - DATA_KEYS)}
    ret = obj.get("ret")
    success = (status == 200 and isinstance(ret, list) and bool(ret)
               and all(isinstance(x, str) and x.split("::", 1)[0] == "SUCCESS" for x in ret))
    shape["status"] = ("http_error" if status != 200 else "non_object_or_unreadable" if not obj
                       else "ok" if success else "mtop_unsuccessful")
    result = {}
    if source == "livedetail":
        for key in COUNT_KEYS:
            value = data.get(key)
            if type(value) in (str, int) and COUNT.fullmatch(str(value)):
                result["online_count"] = int(value)
                break
    else:
        rows = next((data[k] for k in LIST_KEYS if isinstance(data.get(k), list) and data[k]), [])
        row = rows[0] if rows and isinstance(rows[0], dict) else {}
        shape["first_item_keys"] = sorted(ITEM_KEYS.intersection(row))
        for key in ("itemTitle", "title", "itemName"):
            title = row.get(key)
            if isinstance(title, str) and TITLE.fullmatch(title) and not PRIVATE.search(title) and title.strip():
                result["item_title"] = " ".join(title.split())
                break
        for key in ("itemPrice", "price"):
            price = row.get(key)
            if type(price) in (float, int, str) and PRICE.fullmatch(str(price)):
                result["item_price"] = float(price)
                break
        if "liveId" in data:
            response_id = str(data["liveId"])
            live_id = response_id if live_id in (None, response_id) else None
    return (shape, str(live_id) if live_id is not None else None, result if success else {})


def business_report(samples, verified_live_id, stop_reason=None, item_limit=None):
    values, reasons = {}, {}
    for field, source in FIELD_SOURCE.items():
        if source == "itemlist" and item_limit:
            values[field], reasons[field] = None, item_limit
            continue
        entries = samples.get(source, [])
        ok = [(room, fields) for shape, room, fields in entries if shape["status"] == "ok"]
        matched = [fields for room, fields in ok if verified_live_id and room == verified_live_id]
        result = next((fields[field] for fields in matched if field in fields), None)
        values[field] = result
        if result is not None:
            reasons[field] = "extracted"
        elif stop_reason:
            reasons[field] = stop_reason
        elif not entries:
            reasons[field] = "no_response_observed"
        elif not ok:
            reasons[field] = entries[-1][0]["status"]
        elif not matched:
            reasons[field] = "session_not_verified"
        else:
            reasons[field] = "field_missing_or_unsupported"
    return values, {"fields": reasons, "responses": {src: [row[0] for row in samples.get(src, [])]
                                                     for src in ("livedetail", "itemlist")}}
