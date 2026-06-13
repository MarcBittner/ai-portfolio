"""The canonical Finding model both scanners emit: validation + uniform shape."""

import pytest

from postureline import scan
from postureline.findings import Finding, ScanResult
from postureline.scanners import SURFACES, get


def test_finding_validates_surface_severity_and_controls():
    f = Finding(id="X", surface="warehouse", severity="high",
                resource="A.B.C", title="t", evidence={}, control_ids=["CC6.1"],
                remediation="fix")
    assert f.to_dict()["control_ids"] == ["CC6.1"]
    with pytest.raises(ValueError):
        Finding(id="X", surface="nope", severity="high", resource="r", title="t",
                evidence={}, control_ids=["CC6.1"], remediation="f")
    with pytest.raises(ValueError):
        Finding(id="X", surface="warehouse", severity="nope", resource="r",
                title="t", evidence={}, control_ids=["CC6.1"], remediation="f")
    with pytest.raises(ValueError):  # every finding must map to >= 1 control
        Finding(id="X", surface="warehouse", severity="high", resource="r",
                title="t", evidence={}, control_ids=[], remediation="f")


def test_registry_has_both_surfaces():
    assert set(SURFACES) == {"warehouse", "exposure"}
    assert callable(get("warehouse")) and callable(get("exposure"))
    with pytest.raises(ValueError):
        get("unknown")


def test_both_scanners_emit_uniform_finding_shape():
    keys = {"id", "surface", "severity", "resource", "title", "evidence",
            "control_ids", "remediation"}
    for surface in SURFACES:
        result = get(surface)()
        assert isinstance(result, ScanResult)
        assert result.findings, f"{surface} produced no findings"
        for f in result.dicts():
            assert set(f) == keys
            assert f["surface"] == surface
            assert f["control_ids"]


def test_run_sorts_findings_by_severity():
    findings = scan.run("exposure")["findings"]
    order = {"critical": 0, "high": 1, "medium": 2, "low": 3}
    sev = [order[f["severity"]] for f in findings]
    assert sev == sorted(sev)
