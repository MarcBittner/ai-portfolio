"""Security/compliance: control-mapping crosswalk + posture scoring (postureline math)."""

from vigil import security

_GOOD = {"strict-transport-security": "max-age=63072000",
         "content-security-policy": "default-src 'self'",
         "x-content-type-options": "nosniff",
         "x-frame-options": "DENY", "referrer-policy": "no-referrer"}


def test_clean_endpoint_has_no_findings():
    out = security.findings_from_response("https://x.test", _GOOD, '{"status":"ok"}')
    assert out == []


def test_missing_headers_produce_mapped_findings():
    findings = security.findings_from_response("https://x.test", {}, '{"status":"ok"}')
    assert findings
    for f in findings:
        assert f["control_ids"], "every finding must map to >=1 control (invariant)"


def test_health_leak_is_critical():
    findings = security.findings_from_response(
        "https://x.test", _GOOD, '{"api_key":"sk-deadbeef"}')
    leak = [f for f in findings if f["id"] == "HEALTH_LEAK"]
    assert leak and leak[0]["severity"] == "critical"
    assert "CC6.3" in leak[0]["control_ids"]


def test_non_https_flags_tls():
    from vigil.config import Target
    findings = security.scan_live(Target(slug="x", name="x", url="http://x.test"))
    assert any(f["id"] == "NO_TLS" for f in findings)


def test_controls_crosswalk_six_frameworks():
    rows = security.evaluate_controls([])
    assert rows
    for r in rows:
        # SOC 2 anchor + five crosswalk frameworks
        assert {"SOC 2", "HIPAA", "ISO 27001", "NIST 800-53",
                "NIST 800-171", "CMMC"} <= set(r["frameworks"])


def test_posture_score_saturates_and_grades():
    clean = security.findings_from_response("https://x.test", _GOOD, "{}")
    leaky = security.findings_from_response("https://x.test", {}, '{"password":"x"}')
    c_controls = security.evaluate_controls(clean)
    l_controls = security.evaluate_controls(leaky)
    c = security.posture(clean, c_controls, security.framework_rollup(c_controls))
    bad = security.posture(leaky, l_controls, security.framework_rollup(l_controls))
    assert c["score"] == 100 and c["grade"] == "A"
    assert bad["score"] < 100
    assert 0 <= bad["score"] <= 100  # saturating curve never underflows


def test_repo_scan_is_explicit_stub_not_fake_pass():
    from vigil.config import Target
    r = security.scan_repo(Target(slug="x", name="x", url="https://x.test"))
    assert r["status"] == "not_run"  # NEEDS-CREDENTIAL, never a fabricated pass
    assert r["ruleset"]
