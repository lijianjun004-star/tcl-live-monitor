import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "ci"))
from v2_guest_acceptance_g import diagnostic_targets


def test_sku_diagnostic_needs_no_control_and_rejects_wrong_sku():
    sku = {"key": "jd-ac-sku", "platform": "jd", "mode": "sku_discover", "sku_id": "100133134399"}
    old = {"key": "jd-canary", "platform": "jd", "mode": "direct", "live_id": "49019552", "canary": True}
    config = {"schema_version": "2.0", "targets": [old, sku]}
    assert json.loads(diagnostic_targets(json.dumps(config)))["targets"] == [sku]
    config["targets"].remove(old)
    assert json.loads(diagnostic_targets(json.dumps(config)))["targets"] == [sku]
    sku["sku_id"] = "100133134398"
    with pytest.raises(ValueError):
        diagnostic_targets(json.dumps(config))
