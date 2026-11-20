"""Static dark portrait dashboard (docs/index.html). Reads monitor_snapshot.json only.

Data is embedded as escaped JSON and rendered with textContent, so room names or titles can
never inject markup. Thumbnails are inlined as data URIs so the single file works anywhere
(Drive preview, artifact download, phone browser).
"""

from __future__ import annotations

import base64
import json
import re
from pathlib import Path

THUMB = re.compile(r"^thumbs/[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\.jpg$")
MAX_THUMB_BYTES = 300 * 1024

PAGE = """<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex, nofollow">
<title>TCL 直播监控看板</title>
<style>
:root{--bg:#0e1014;--card:#181b22;--line:#2a2f3a;--text:#e9ebef;--muted:#9aa1ad;--live:#2fbf71;--off:#8a93a3;--bad:#f0a43a;--err:#ef5b5b;--chip:#222733;--accent:#5b8cff}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
main{max-width:560px;margin:0 auto;padding:12px 12px 40px}
header h1{font-size:18px;margin:4px 0 2px}header p{margin:0;color:var(--muted);font-size:12px}
.banner{margin:10px 0;padding:8px 10px;border-radius:10px;background:#3a2020;color:#ffd7d7;font-size:13px}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:12px 0}
.stat{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:8px 6px;text-align:center}
.stat b{display:block;font-size:20px}.stat span{color:var(--muted);font-size:12px}
.filters{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0}
.filters button{border:1px solid var(--line);background:var(--chip);color:var(--text);border-radius:999px;padding:5px 11px;font-size:13px}
.filters button[aria-pressed="true"]{background:var(--accent);border-color:var(--accent);color:#fff}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden;display:flex;flex-direction:column}
.card img{width:100%;aspect-ratio:3/4;object-fit:cover;background:#111;display:block}
.ph{aspect-ratio:16/9;display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:12px;background:#12151b}
.body{padding:8px;display:flex;flex-direction:column;gap:4px;flex:1}
.name{font-weight:600;font-size:13px;word-break:break-all}
.meta{color:var(--muted);font-size:12px}
.badge{display:inline-block;border-radius:6px;padding:1px 6px;font-size:11px;font-weight:600;margin-right:4px}
.s-live{background:rgba(47,191,113,.18);color:var(--live)}.s-offline{background:rgba(138,147,163,.18);color:var(--off)}
.s-abnormal{background:rgba(240,164,58,.18);color:var(--bad)}.s-blocked{background:rgba(239,91,91,.18);color:var(--err)}
.go{margin-top:auto;display:block;text-align:center;padding:7px;border-radius:8px;background:var(--accent);color:#fff;text-decoration:none;font-size:13px}
.go[aria-disabled="true"]{background:var(--chip);color:var(--muted)}
.empty{color:var(--muted);text-align:center;padding:30px 0;grid-column:1/-1}
</style>
</head>
<body>
<main>
<header><h1>TCL 直播监控</h1><p id="when"></p></header>
<div id="banner" class="banner" hidden></div>
<section class="stats" id="stats"></section>
<nav class="filters" id="platforms" aria-label="平台"></nav>
<nav class="filters" id="statuses" aria-label="状态"></nav>
<section class="grid" id="grid"></section>
</main>
<script type="application/json" id="data">__DATA__</script>
<script>
(function(){
  var data = JSON.parse(document.getElementById('data').textContent);
  var snap = data.snapshot, thumbs = data.thumbs;
  var PLATFORM = {jd:'京东', tmall:'天猫', taobao:'淘宝'};
  var CODE = {OK:'直播中', OFFLINE:'未开播', REDIRECTED:'跳转', LOGIN_REQUIRED:'需登录', CAPTCHA_X5SEC:'滑块/验证',
    GROUP_CIRCUIT_OPEN:'组熔断', NAV_TIMEOUT:'超时', POST_AUDIT_BLOCKED:'写拦截', SCHEMA_MISMATCH:'结构不符'};
  var BLOCKED = {LOGIN_REQUIRED:1, CAPTCHA_X5SEC:1, GROUP_CIRCUIT_OPEN:1};
  function bucket(r){ return r.code === 'OK' ? 'live' : r.code === 'OFFLINE' ? 'offline' : 'abnormal'; }
  function el(tag, cls, text){ var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function bj(iso){ try { return new Date(iso).toLocaleString('zh-CN', {timeZone:'Asia/Shanghai', hour12:false}); } catch (e) { return iso; } }
  function safeUrl(u){ return typeof u === 'string' && (/^https:\\/\\/lives\\.jd\\.com\\/#\\/\\d+$/.test(u) || /^https:\\/\\/h5\\.m\\.taobao\\.com\\/taolive\\/video\\.html\\?userId=\\d+$/.test(u)) ? u : null; }
  document.getElementById('when').textContent = '更新于 ' + bj(snap.generated_at) + '（北京时间）· 批次 ' + snap.run_id;
  if (snap.canary && snap.canary.passed === false) {
    var b = document.getElementById('banner'); b.hidden = false;
    b.textContent = '阳性对照未通过（' + (snap.canary.code || '无结果') + '），本批京东"未开播/异常"结论可信度下降。';
  }
  var s = snap.summary, stats = document.getElementById('stats');
  [['总数', s.total], ['直播中', s.live], ['未开播', s.offline], ['异常', s.abnormal]].forEach(function(p){
    var c = el('div', 'stat'); c.appendChild(el('b', null, String(p[1]))); c.appendChild(el('span', null, p[0])); stats.appendChild(c);
  });
  var state = {platform:'all', status:'all'};
  function chips(id, key, options){
    var nav = document.getElementById(id);
    options.forEach(function(o){
      var btn = el('button', null, o[1]); btn.type = 'button'; btn.dataset.value = o[0];
      btn.setAttribute('aria-pressed', String(state[key] === o[0]));
      btn.addEventListener('click', function(){
        state[key] = o[0];
        Array.prototype.forEach.call(nav.children, function(x){ x.setAttribute('aria-pressed', String(x.dataset.value === o[0])); });
        render();
      });
      nav.appendChild(btn);
    });
  }
  chips('platforms', 'platform', [['all','全部平台'],['jd','京东'],['tmall','天猫'],['taobao','淘宝']]);
  chips('statuses', 'status', [['all','全部状态'],['live','直播中'],['offline','未开播'],['abnormal','异常']]);
  function render(){
    var grid = document.getElementById('grid'); grid.textContent = '';
    var rows = snap.rooms.filter(function(r){
      return (state.platform === 'all' || r.platform === state.platform) && (state.status === 'all' || bucket(r) === state.status);
    });
    if (!rows.length) { grid.appendChild(el('div', 'empty', '没有符合条件的直播间')); return; }
    rows.forEach(function(r){
      var card = el('article', 'card'), src = r.thumbnail && thumbs[r.thumbnail];
      if (src) { var img = el('img'); img.src = src; img.alt = ''; img.loading = 'lazy'; card.appendChild(img); }
      else card.appendChild(el('div', 'ph', PLATFORM[r.platform] || r.platform));
      var body = el('div', 'body');
      body.appendChild(el('div', 'name', r.display_name || r.target_key));
      var line = el('div', 'meta'), kind = BLOCKED[r.code] ? 'blocked' : bucket(r);
      line.appendChild(el('span', 'badge s-' + kind, CODE[r.code] || r.code));
      line.appendChild(document.createTextNode(PLATFORM[r.platform] || r.platform));
      body.appendChild(line);
      var extra = [];
      if (r.online_count != null) extra.push('在线 ' + r.online_count);
      if (r.item_price != null) extra.push('¥' + r.item_price);
      if (r.keywords_hit && r.keywords_hit.length) extra.push('#' + r.keywords_hit.join(' #'));
      if (extra.length) body.appendChild(el('div', 'meta', extra.join(' · ')));
      if (r.item_title) body.appendChild(el('div', 'meta', r.item_title));
      body.appendChild(el('div', 'meta', bj(r.observed_at) + (r.reason ? ' · ' + r.reason : '')));
      var url = safeUrl(r.room_url), go = el('a', 'go', url ? '进入直播间' : '暂无链接');
      if (url) { go.href = url; go.target = '_blank'; go.rel = 'noopener noreferrer'; } else go.setAttribute('aria-disabled', 'true');
      body.appendChild(go); card.appendChild(body); grid.appendChild(card);
    });
  }
  render();
})();
</script>
</body>
</html>
"""


def embedded_json(value: object) -> str:
    text = json.dumps(value, ensure_ascii=False, allow_nan=False)
    return text.replace("&", "\\u0026").replace("<", "\\u003c").replace(">", "\\u003e")


def thumbnails(snapshot: dict, evidence_dir: Path | None) -> dict[str, str]:
    found = {}
    for room in snapshot.get("rooms", []):
        name = room.get("thumbnail")
        if not evidence_dir or not isinstance(name, str) or not THUMB.fullmatch(name):
            continue
        path = evidence_dir / name
        if path.is_file() and path.stat().st_size <= MAX_THUMB_BYTES:
            found[name] = "data:image/jpeg;base64," + base64.b64encode(path.read_bytes()).decode("ascii")
    return found


def render(snapshot: dict, evidence_dir: Path | None = None) -> str:
    data = {"snapshot": snapshot, "thumbs": thumbnails(snapshot, evidence_dir)}
    return PAGE.replace("__DATA__", embedded_json(data))


def write(snapshot: dict, path: Path, evidence_dir: Path | None = None) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(render(snapshot, evidence_dir), encoding="utf-8")
    return path
