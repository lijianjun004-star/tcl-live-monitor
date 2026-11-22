"""One-shot, anonymous, read-only look for "current live session" clues around JD shop 721631.

Opens three public pages once each (PC shop, mobile shop, one known live room) in a fresh
browser context, records the JSON the pages themselves load, and prints a structural summary:
functionIds, key paths that mention live/shop/vender/author, numeric ids that look like JD live
session ids, and visible links/text that mention live. No login, no cookies kept, no signatures
crafted, no extra requests beyond what each page makes on its own.
"""
from __future__ import annotations

import asyncio
import json
import re
import sys
from urllib.parse import parse_qs, urlsplit

from playwright.async_api import async_playwright

SHOP_ID = "721631"
KNOWN_LIVE_ID = "49620440"  # user-shared session (PR #112), replay on 2026-11-20
PAGES = [
    ("replay_pc", f"https://lives.jd.com/#/{KNOWN_LIVE_ID}", "desktop"),
    ("replay_m", f"https://lives.jd.com/#/{KNOWN_LIVE_ID}", "mobile"),
]
DESKTOP_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36")
MOBILE_UA = ("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 "
             "(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1")
ROOTS = ("jd.com", "3.cn", "jd.hk", "360buyimg.com", "jdcdn.com")
INTEREST = re.compile(r"live|zhibo|living|broadcast|room|anchor|author|vender|shopid|shop_id|直播|"
                      r"lottery|lucky|draw|prize|award|preview|trailer|forecast|notice|appoint|reserve|"
                      r"subscribe|next|start|begin|plan|schedule|抽奖|预告|预约|开播", re.I)
PRIVATE = re.compile(r"token|cookie|pin$|^pin|uuid|phone|mobile|mail|openid|unionid|nick|user|"
                     r"sign|h5st|^eid$|^fp$|^ip$|addr|sharer|^gx", re.I)
LIVE_ID = re.compile(r"(?<![0-9])4[6-9][0-9]{6}(?![0-9])")
MAX_PATHS = 120


def jd_host(host: str | None) -> bool:
    return bool(host) and any(host == r or host.endswith("." + r) for r in ROOTS)


def function_id(url: str, post: str | None) -> str | None:
    q = parse_qs(urlsplit(url).query)
    if "functionId" in q:
        return q["functionId"][0][:80]
    if post:
        try:
            p = parse_qs(post)
            if "functionId" in p:
                return p["functionId"][0][:80]
        except Exception:
            pass
        m = re.search(r'"functionId"\s*:\s*"([A-Za-z0-9_.]{1,80})"', post)
        if m:
            return m.group(1)
    return None


def parse_body(text: str):
    t = text.strip()
    if not t:
        return None
    if t[0] not in "{[":
        m = re.match(r"^[\w$.]+\s*\((.*)\)\s*;?\s*$", t, re.S)  # JSONP
        if not m:
            return None
        t = m.group(1)
    try:
        return json.loads(t)
    except ValueError:
        return None


def walk(node, path, out, depth=0):
    if depth > 9 or len(out) >= MAX_PATHS:
        return
    if isinstance(node, dict):
        for k, v in list(node.items())[:200]:
            walk(v, f"{path}.{k}" if path else str(k), out, depth + 1)
    elif isinstance(node, list):
        for i, v in enumerate(node[:5]):
            walk(v, f"{path}[{i}]", out, depth + 1)
    else:
        leaf = path.rsplit(".", 1)[-1]
        if PRIVATE.search(leaf):
            return
        if INTEREST.search(path) or (isinstance(node, (str, int)) and LIVE_ID.fullmatch(str(node))):
            if isinstance(node, bool) or node is None:
                value = node
            elif isinstance(node, (int, float)):
                value = node
            else:
                s = str(node)
                if "lives.jd.com" in s or "zhibo" in s.lower():
                    p = urlsplit(s) if s.startswith("http") else None
                    value = f"{p.scheme}://{p.netloc}{p.path}#{p.fragment.split('?')[0][:40]}" if p else s[:120]
                else:
                    value = s[:80]
            out.append({"path": path[:160], "value": value})


async def observe(browser, name, url, kind):
    ctx = await browser.new_context(
        user_agent=MOBILE_UA if kind == "mobile" else DESKTOP_UA,
        viewport={"width": 390, "height": 844} if kind == "mobile" else {"width": 1366, "height": 900},
        is_mobile=kind == "mobile", has_touch=kind == "mobile", locale="zh-CN",
    )
    page = await ctx.new_page()
    rec = {"page": name, "start": url, "navigations": [], "responses": [], "function_ids": [],
           "live_id_hits": [], "dom": None, "error": None}
    seen_fids: set[str] = set()
    tasks = []

    def on_frame(frame):
        if frame == page.main_frame:
            p = urlsplit(frame.url)
            rec["navigations"].append(f"{p.netloc}{p.path}"[:120])

    async def handle(resp):
        try:
            req = resp.request
            p = urlsplit(resp.url)
            if not jd_host(p.hostname) or req.resource_type not in ("xhr", "fetch", "script", "document"):
                return
            post = req.post_data if req.method == "POST" else None
            fid = function_id(resp.url, post)
            if fid and fid not in seen_fids:
                seen_fids.add(fid)
                rec["function_ids"].append(fid)
            ctype = (resp.headers.get("content-type") or "").lower()
            if req.resource_type == "script" and not fid:
                return
            if not any(x in ctype for x in ("json", "javascript", "text/plain", "text/html")):
                return
            raw = await resp.body()
            text = raw.decode("utf-8", errors="replace")
            if fid:
                rec.setdefault("bodies", []).append({
                    "source": fid, "status": resp.status, "ctype": ctype[:40], "bytes": len(raw),
                    "looks_text": text[:1].strip() in ("{", "[") or text.lstrip()[:1] in ("{", "["),
                    "replacement_chars": text.count("\ufffd")})
            for m in list(dict.fromkeys(LIVE_ID.findall(text)))[:10]:
                i = text.find(m)
                ctx_txt = re.sub(r"\s+", " ", text[max(0, i - 60):i + 20])
                ctx_txt = re.sub(r'"(?:[^"]*(?:pin|token|uuid|nick|user)[^"]*)"\s*:\s*"[^"]*"', '"<redacted>"', ctx_txt, flags=re.I)
                rec["live_id_hits"].append({"id": m, "source": fid or f"{p.netloc}{p.path}"[:80],
                                            "context": ctx_txt[:90]})
            data = parse_body(text) if req.resource_type != "document" else None
            if data is None:
                return
            paths: list = []
            walk(data, "", paths)
            keys = []
            def key_walk(n, pre="", d=0):
                if d > 4 or len(keys) > 150:
                    return
                if isinstance(n, dict):
                    for k, v in list(n.items())[:80]:
                        if not PRIVATE.search(str(k)):
                            keys.append(f"{pre}.{k}" if pre else str(k))
                            key_walk(v, f"{pre}.{k}" if pre else str(k), d + 1)
                elif isinstance(n, list) and n:
                    key_walk(n[0], pre + "[]", d + 1)
            key_walk(data)
            rec["responses"].append({"source": fid or f"{p.netloc}{p.path}"[:100], "status": resp.status,
                                     "matched_paths": paths[:80], "key_paths": keys[:150] if fid else []})
        except Exception as exc:  # noqa: BLE001 - evidence only
            rec.setdefault("handler_errors", []).append(type(exc).__name__)

    page.on("framenavigated", on_frame)
    page.on("response", lambda r: tasks.append(asyncio.ensure_future(handle(r))))
    try:
        await page.goto(url, wait_until="domcontentloaded", timeout=30000)
        for _ in range(6):
            await page.wait_for_timeout(2500)
            try:
                await page.mouse.wheel(0, 1400)
            except Exception:
                pass
        await page.wait_for_timeout(3000)
        rec["final"] = (lambda p: f"{p.netloc}{p.path}#{p.fragment.split('?')[0][:30]}")(urlsplit(page.url))
        rec["title"] = (await page.title())[:80]
        rec["dom"] = await page.evaluate("""() => {
          const out = {live_links: [], live_text: [], iframes: []};
          for (const a of Array.from(document.querySelectorAll('a[href]')).slice(0, 3000)) {
            const h = a.href || '';
            const t = (a.innerText || '').replace(/\\s+/g, ' ').trim();
            if (/lives\\.jd\\.com|zhibo|\\/live/i.test(h) || /直播/.test(t))
              out.live_links.push({text: t.slice(0, 30), href: h.split('?')[0].slice(0, 120) + (h.includes('#') ? '#' + h.split('#')[1].split('?')[0].slice(0, 30) : '')});
          }
          const body = (document.body && document.body.innerText) || '';
          const re = /.{0,20}(直播|预告|抽奖|预约|开播|下一场|福袋|红包).{0,30}/g; let m; let n = 0;
          while ((m = re.exec(body)) && n < 25) { out.live_text.push(m[0].replace(/\\s+/g, ' ')); n++; }
          for (const f of Array.from(document.querySelectorAll('iframe')).slice(0, 20)) out.iframes.push((f.src || '').split('?')[0].slice(0, 120));
          out.live_links = out.live_links.slice(0, 20);
          out.body_len = body.length;
          return out;
        }""")
    except Exception as exc:  # noqa: BLE001
        rec["error"] = f"{type(exc).__name__}: {str(exc)[:160]}"
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)
    rec["responses"] = [r for r in rec["responses"] if r["matched_paths"] or r["key_paths"]][:40]
    await ctx.close()
    return rec


async def main():
    async with async_playwright() as pw:
        browser = await pw.chromium.launch()
        results = []
        for name, url, kind in PAGES:
            results.append(await observe(browser, name, url, kind))
        await browser.close()
    text = json.dumps({"shop_id": SHOP_ID, "known_live_id": KNOWN_LIVE_ID, "pages": results},
                      ensure_ascii=False)
    print("CLUES_BEGIN")
    print(text[:90000])
    print("CLUES_END")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
