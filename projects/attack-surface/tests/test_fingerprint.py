from attack_surface.data import DOMAIN, SERVICES
from attack_surface.fingerprint import derive

_BY = {s["subdomain"]: s for s in SERVICES}


def _rules(subdomain):
    return {f["rule_id"] for f in derive(_BY[subdomain], DOMAIN)}


def test_admin_without_auth_is_critical():
    fs = derive(_BY["admin"], DOMAIN)
    f = next(f for f in fs if f["rule_id"] == "ADMIN_NO_AUTH")
    assert f["severity"] == "critical" and "SOC2:CC6.1" in f["controls"]


def test_exposed_database_is_critical():
    f = next(f for f in derive(_BY["db"], DOMAIN) if f["rule_id"] == "DB_EXPOSED")
    assert f["severity"] == "critical" and "SOC2:CC6.6" in f["controls"]


def test_expired_tls_and_dangling():
    assert "EXPIRED_TLS" in _rules("staging")
    assert "SUBDOMAIN_TAKEOVER" in _rules("old")


def test_clean_host_has_no_findings():
    assert derive(_BY["www"], DOMAIN) == []   # hsts on, auth n/a, not dangling


def test_every_finding_has_severity_and_controls():
    for svc in SERVICES:
        for f in derive(svc, DOMAIN):
            assert f["severity"] in ("critical", "high", "medium", "low")
            assert f["controls"] and f["remediation"]
