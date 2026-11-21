"""Dashboard safety and the static layer-isolation rules R1-R3 (SPEC.md section 2)."""

import ast
from pathlib import Path

from output import dashboard

SRC = Path(__file__).resolve().parents[2] / "src"


def snapshot(**room_overrides):
    room = {"target_key": "jd-a", "platform": "jd", "display_name": "</script><img src=x onerror=alert(1)>",
            "account_group": None, "live_id": "49019552", "room_url": "https://lives.jd.com/#/49019552",
            "code": "OK", "reason": "detail_live", "live_status": "live", "observed_at": "2026-11-20T12:00:00+00:00",
            "elapsed_ms": 9000, "detect_ms": 4000, "online_count": 12, "item_title": "TCL 空调", "item_price": 2999.0,
            "keywords_hit": ["TCL"], "thumbnail": "thumbs/jd-a.jpg",
            "discovery": {"code": "OK", "reason": None, "source": "static", "mode": "direct"}, "diagnostics": {}}
    room.update(room_overrides)
    return {"schema_version": "2.0", "generated_at": "2026-11-20T12:00:00+00:00", "run_id": "r1",
            "canary": {"target_key": "jd-a", "passed": False, "code": "NAV_TIMEOUT", "live_status": "unknown"},
            "summary": {"total": 1, "live": 1, "offline": 0, "abnormal": 0, "by_code": {"OK": 1},
                        "by_platform": {"jd": 1}, "circuit_open_groups": [], "max_detect_ms": 4000,
                        "median_detect_ms": 4000}, "rooms": [room]}


def test_embedded_data_cannot_break_out_of_the_script_tag(tmp_path):
    (tmp_path / "thumbs").mkdir()
    (tmp_path / "thumbs" / "jd-a.jpg").write_bytes(b"\xff\xd8thumb")
    html = dashboard.render(snapshot(), tmp_path)
    data = html.split('id="data">', 1)[1].split("</script>", 1)[0]
    assert "</script" not in data and "<img" not in data and "\\u003c/script\\u003e" in data
    assert "data:image/jpeg;base64," in data
    assert "textContent" in html and "innerHTML" not in html
    for marker in ("全部平台", "京东", "天猫", "淘宝", "直播中", "未开播", "异常", "进入直播间", "阳性对照未通过"):
        assert marker in html
    assert 'name="viewport"' in html and "grid-template-columns:1fr 1fr" in html


def test_thumbnail_paths_outside_thumbs_are_ignored(tmp_path):
    (tmp_path / "secret.jpg").write_bytes(b"x")
    assert dashboard.thumbnails(snapshot(thumbnail="../secret.jpg"), tmp_path) == {}


def imports(path: Path) -> set[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    found = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            found.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            if node.level:  # relative import inside a package
                package = ".".join(path.relative_to(SRC).with_suffix("").parts[:-node.level])
                found.add(f"{package}.{node.module}" if node.module else package)
            elif node.module:
                found.add(node.module)
    return found


def modules(folder: str):
    return sorted((SRC / folder).rglob("*.py"))


def test_r1_platform_engines_never_import_each_other():
    for path in modules("platforms/jd"):
        assert not any(name.startswith("platforms.ali_live") for name in imports(path)), path
    for path in modules("platforms/ali_live"):
        assert not any(name.startswith("platforms.jd") or name == "single_room_probe" for name in imports(path)), path


def test_r2_output_reads_contracts_only():
    for path in modules("output"):
        assert not any(name.startswith(("platforms", "core.browser", "single_room_probe")) for name in imports(path)), path


def test_r3_core_imports_neither_platforms_nor_output():
    for path in modules("core"):
        assert not any(name.startswith(("platforms", "output", "single_room_probe")) for name in imports(path)), path


def test_r4_each_platform_has_two_distinct_policy_classes():
    from platforms.ali_live.policy import AliDiscoveryPolicy, AliMonitorPolicy
    from platforms.jd.policy import JdDiscoveryPolicy, JdMonitorPolicy

    for discovery, monitor in ((JdDiscoveryPolicy, JdMonitorPolicy), (AliDiscoveryPolicy, AliMonitorPolicy)):
        assert discovery is not monitor and not issubclass(discovery, monitor) and not issubclass(monitor, discovery)
        assert discovery.name != monitor.name
