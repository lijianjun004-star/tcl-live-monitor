"""Invented, deterministic observations. No request is made to the example URLs."""

SKU = "100133134399"
FLAGSHIP = "721631"
LIGHTING = "1000194977"
LIVE_ROOM = "900000000001"
UNCONFIRMED_ROOM = "900000000002"

PAGES = {
    SKU: {
        "final_url": f"https://item.m.jd.com/product/{SKU}.html",
        "http_status": 200,
        "document_observed": True,
        "dom_hrefs": [f"https://lives.jd.com/#/{LIVE_ROOM}"],
        "responses": [
            {
                "url": "https://api.m.jd.com/api?functionId=pc_recommend",
                "http_status": 403,
            },
        ],
    },
    FLAGSHIP: {
        "final_url": f"https://shop.m.jd.com/?shopId={FLAGSHIP}",
        "http_status": 200,
        "document_observed": True,
        "dom_hrefs": [f"https://lives.jd.com/#/{UNCONFIRMED_ROOM}"],
    },
    LIGHTING: {
        "final_url": "https://plogin.m.jd.com/login/login",
        "http_status": 200,
        "document_observed": True,
        "redirect_chain": [f"https://shop.m.jd.com/?shopId={LIGHTING}"],
    },
}

_DETAIL_URL = "https://api.m.jd.com/api?functionId=getImmediatePlayToM"
VERIFICATIONS = {
    LIVE_ROOM: {
        "page_url": f"https://lives.jd.com/#/{LIVE_ROOM}",
        "url": _DETAIL_URL,
        "http_status": 200,
        "payload": {"code": "0", "subCode": 0, "data": {"liveId": LIVE_ROOM, "status": 1}},
        "detect_ms": 42,
    },
    UNCONFIRMED_ROOM: {
        "page_url": f"https://lives.jd.com/#/{UNCONFIRMED_ROOM}",
        "url": _DETAIL_URL,
        "http_status": 503,
        "detect_ms": 63,
    },
}
