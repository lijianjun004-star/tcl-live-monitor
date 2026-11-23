"""Read the six named shops and their public entry links on the operator's existing tab."""
from dataclasses import dataclass, field

from playwright.sync_api import Error

from search_page import CARDS, SCROLL, ScanError, check_access, frames, room_url, scroll


@dataclass
class Evidence:
    status: str
    urls: set = field(default_factory=set)
    invalid_href: bool = False
    reason: str = ""

    def result(self):
        url = None
        reason = self.reason
        if self.status == "live":
            if self.invalid_href or len(self.urls) > 1:
                reason = "进入按钮的地址无法唯一核对"
            elif self.urls:
                url = next(iter(self.urls))
                reason = "进入按钮及同一控件的直播间链接"
            else:
                reason = "可见进入按钮，控件未提供可核对的公开链接"
        elif self.status == "offline":
            reason = "仅见主页按钮"
        return {"status": self.status, "liveId": url.split("liveId=")[1] if url else None,
                "liveUrl": url, "reason": reason}


def _sample_details(page, targets):
    rows = {}
    for frame in frames(page):
        for card in frame.evaluate(CARDS, targets):
            name = card["name"]
            if name in rows:
                rows[name] = Evidence("unknown", reason="同名卡片重复")
                continue
            if card.get("pending"):
                rows[name] = None
                continue
            urls = {room_url(raw) for raw in card.get("hrefs", [])}
            invalid = None in urls or bool(card.get("unverifiedHref"))
            rows[name] = Evidence(card["status"], urls - {None}, invalid, "卡片控件无法核对")
    return {name: evidence for name, evidence in rows.items() if evidence is not None}


def _sample(page, targets):
    return {name: card.status for name, card in _sample_details(page, targets).items()}


def read_verified_links(page, targets):
    """Return one in-page scan in roster order, without navigation or clicks."""
    targets = list(dict.fromkeys(targets))
    seen = {}
    try:
        previous = None
        quiet = 0
        for turn in range(30):
            check_access(page)
            sample = _sample_details(page, targets)
            for name, card in sample.items():
                prior = seen.get(name)
                if prior is None:
                    seen[name] = Evidence(card.status, set(card.urls), card.invalid_href, card.reason)
                elif prior.status != card.status:
                    seen[name] = Evidence("unknown", reason="同轮读取的卡片状态不一致")
                elif prior.status == "live":
                    prior.urls.update(card.urls)
                    prior.invalid_href |= card.invalid_href
            if turn == 0:
                moved = False
                for frame in frames(page):
                    moved |= bool(frame.evaluate(SCROLL, True))
            else:
                moved = scroll(page)
            quiet = quiet + 1 if not moved and sample == previous else 0
            if quiet >= (5 if seen else 12):
                break
            previous = sample
            page.wait_for_timeout(350)
        check_access(page)
    except (Error, ScanError) as exc:
        reason = str(exc) if isinstance(exc, ScanError) else "浏览器读取失败"
        return {name: Evidence("unknown", reason=reason).result() for name in targets}
    return {name: seen.get(name, Evidence("unknown", reason="未找到可归属的店铺卡片")).result()
            for name in targets}


def read_verified(page, targets):
    return {name: row["status"] for name, row in read_verified_links(page, targets).items()}
