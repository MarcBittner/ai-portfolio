from attack_surface import ct
from attack_surface.scanner import scan, scan_fixture


def test_fixture_report_shape():
    r = scan_fixture()
    assert r["mode"] == "fixture" and r["domain"]
    assert len(r["assets"]["subdomains"]) == 8
    assert r["findings"]
    # severity counts sum to the number of findings
    assert sum(r["severity_counts"].values()) == len(r["findings"])
    assert 0 <= r["posture"]["score"] <= 100 and r["posture"]["grade"]


def test_findings_sorted_critical_first():
    sev = [f["severity"] for f in scan_fixture()["findings"]]
    order = {"critical": 0, "high": 1, "medium": 2, "low": 3}
    assert sev == sorted(sev, key=lambda s: order[s])


def test_governed_evidence_invariant():
    r = scan_fixture()
    # every finding maps to at least one control
    assert all(f["controls"] for f in r["findings"])
    # every failing control traces back to findings
    for c in r["controls"]:
        if c["status"] == "fail":
            assert c["finding_count"] == len(c["findings"]) >= 1


def test_live_mode_is_passive(monkeypatch):
    monkeypatch.setattr(ct, "enumerate_live",
                        lambda d, timeout=15.0: [{"name": f"a.{d}", "issuer": "x",
                                                  "not_after": "2027"}])
    r = scan("example.com", mode="live")
    assert r["mode"] == "live"
    assert r["findings"] == [] and r["controls"] == []
    assert "passive" in r["note"].lower()
    assert r["assets"]["subdomains"] == ["a.example.com"]
