"""Contract freeze: schemas are valid, the example validates, bad documents are rejected."""

import json

import pytest

from conftest import ali_target, jd_target
from core.config import ConfigError, load_settings, parse_settings
from core.contracts import ContractError, problems, require, validator
from core.errors import Code
from core.models import resolved_room, snapshot_room, summarize


def test_all_schemas_are_valid_draft_2020_12():
    for name in ("targets", "resolved_rooms", "monitor_snapshot"):
        assert validator(name) is not None


def test_example_targets_validate_and_parse(example_doc):
    assert problems("targets", example_doc) == []
    settings = parse_settings(example_doc)
    assert settings.canary.key == "jd-canary" and len(settings.targets) == 8


def test_env_secret_takes_precedence_over_file(example_doc, tmp_path):
    other = dict(example_doc, targets=[jd_target("only-one", "12345678")])
    settings = load_settings(tmp_path / "missing.json", env={"V2_TARGETS_JSON": json.dumps(other)})
    assert [t.key for t in settings.targets] == ["only-one"]
    with pytest.raises(ConfigError):
        load_settings(None, env={})


def test_config_errors_never_echo_secret_values(example_doc):
    doc = json.loads(json.dumps(example_doc))
    doc["targets"][0]["live_id"] = "SECRET-VALUE-123"
    with pytest.raises(ConfigError) as error:
        parse_settings(doc)
    assert "SECRET-VALUE-123" not in str(error.value)


@pytest.mark.parametrize("mutate", [
    lambda d: d["targets"].append(dict(d["targets"][0])),                       # duplicate key
    lambda d: d["targets"].append(jd_target("second-canary", "22345678", True)),  # two canaries
    lambda d: d["targets"].extend(ali_target(f"g1-{i}", 1, account=str(1000000 + i)) for i in range(7)),  # >7 in group
    lambda d: d["targets"].append(jd_target("dup-live", "99000000001")),          # duplicate JD live_id
    lambda d: d["targets"].extend(jd_target(f"many-{i}", str(20000000 + i)) for i in range(13)),  # >20 targets
    lambda d: d["targets"][5].update(canary=True),                                # Ali canary
    lambda d: d["targets"][6].pop("account_group"),                               # Ali without group
    lambda d: d["targets"][1].update(short_link="https://evil.example/x"),        # foreign short link
])
def test_business_rules_reject(example_doc, mutate):
    doc = json.loads(json.dumps(example_doc))
    mutate(doc)
    with pytest.raises(ConfigError):
        parse_settings(doc)


def _resolved(settings, **overrides):
    target = settings.targets[0]
    row = resolved_room(target, code=Code.OK, reason="configured_live_id", source="static",
                        live_id=target.live_id, room_url=f"https://lives.jd.com/#/{target.live_id}",
                        resolved_at="2026-11-20T00:00:00+00:00", cache_age_seconds=None,
                        verification="config", audit={})
    row.update(overrides)
    return {"schema_version": "2.0", "generated_at": "2026-11-20T00:00:00+00:00", "run_id": "t1", "rooms": [row]}


def test_resolved_contract_invariants(make_settings):
    settings = make_settings()
    require("resolved_rooms", _resolved(settings))
    for bad in (
        {"source": "cache", "cache_age_seconds": 5},              # cache with OK is forbidden
        {"code": "NAV_TIMEOUT"},                                  # static source must be OK
        {"source": "none", "code": "NAV_TIMEOUT"},                # none must not carry a room_url
        {"room_url": "https://lives.jd.com/#/123"},               # malformed id
        {"room_url": "https://evil.example/#/12345678"},
        {"reason": "Free Text With Spaces"},
    ):
        with pytest.raises(ContractError):
            require("resolved_rooms", _resolved(settings, **bad))


def test_snapshot_builder_enforces_status_invariants(make_settings):
    settings = make_settings()
    target = settings.targets[0]
    row = _resolved(settings)["rooms"][0]
    with pytest.raises(ValueError):
        snapshot_room(target, row, code=Code.OK, reason="x", live_status="offline")
    room = snapshot_room(target, row, code=Code.NAV_TIMEOUT, reason="x", live_status="live", item_price=9.9,
                         thumbnail="thumbs/jd-canary.jpg")
    assert room["live_status"] == "unknown" and room["item_price"] is None and room["thumbnail"] is None
    doc = {"schema_version": "2.0", "generated_at": "2026-11-20T00:00:00+00:00", "run_id": "t1",
           "canary": {"target_key": None, "passed": None, "code": None, "live_status": None},
           "summary": summarize([room], []), "rooms": [room]}
    require("monitor_snapshot", doc)
    doc["rooms"][0] = dict(room, live_status="live")
    assert problems("monitor_snapshot", doc)
