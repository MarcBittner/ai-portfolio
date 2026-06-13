from datetime import date

from perimeter.data import SCAN_DATE, hosts
from perimeter.fingerprint import derive_host

_AS_OF = date.fromisoformat(SCAN_DATE)
_BY = {h["hostname"].split(".")[0]: h for h in hosts()}


def _rules(short):
    return {f["rule_id"] for f in derive_host(_BY[short], _AS_OF)}


def test_exposed_datastore_is_critical():
    fs = derive_host(_BY["data-01"], _AS_OF)  # MongoDB on 27017
    f = next(f for f in fs if f["rule_id"] == "DB_EXPOSED")
    assert f["severity"] == "critical"
    assert "CC6.6" in f["controls"]
    assert f["evidence"]["port"] == 27017


def test_exposed_admin_panel_is_critical():
    f = next(f for f in derive_host(_BY["admin"], _AS_OF)
             if f["rule_id"] == "ADMIN_EXPOSED")
    assert f["severity"] == "critical" and "CC6.1" in f["controls"]


def test_expired_cert_flagged():
    fs = derive_host(_BY["legacy"], _AS_OF)
    f = next(f for f in fs if f["rule_id"] == "TLS_EXPIRED")
    assert f["severity"] == "high" and f["evidence"]["days_overdue"] > 0


def test_weak_key_and_weak_sig_and_self_signed():
    r = _rules("vpn")  # 1024-bit RSA, sha1, self-signed
    assert {"WEAK_KEY", "WEAK_SIG", "SELF_SIGNED"} <= r


def test_deprecated_tls_flagged():
    assert "DEPRECATED_TLS" in _rules("mail")  # TLS 1.0


def test_expiring_soon_flagged():
    assert "TLS_EXPIRING" in _rules("cdn")  # not_after within 30 days


def test_eol_software_flagged():
    assert "EOL_SOFTWARE" in _rules("bastion")   # OpenSSH 7.4
    assert "EOL_SOFTWARE" in _rules("old-web")    # Apache 2.2.34


def test_restricted_datastore_has_no_db_exposed():
    # db-prod is PostgreSQL but exposure=restricted → no DB_EXPOSED finding
    assert "DB_EXPOSED" not in _rules("db-prod")


def test_clean_host_has_no_findings():
    assert derive_host(_BY["docs"], _AS_OF) == []


def test_every_finding_has_severity_controls_and_evidence():
    for h in hosts():
        for f in derive_host(h, _AS_OF):
            assert f["severity"] in ("critical", "high", "medium", "low")
            assert f["controls"] and f["remediation"]
            assert isinstance(f["evidence"], dict)
