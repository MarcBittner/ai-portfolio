"""Exposure surface: fingerprint detectors + remediation diff + posture."""

from datetime import date

from postureline import posture, scan
from postureline.data import SCAN_DATE, hosts
from postureline.fingerprint import derive_host

_AS_OF = date.fromisoformat(SCAN_DATE)
_BY = {h["hostname"].split(".")[0]: h for h in hosts()}


def _rules(short):
    return {f["rule_id"] for f in derive_host(_BY[short], _AS_OF)}


# --- fingerprint detectors --------------------------------------------------

def test_exposed_datastore_and_admin_are_critical():
    db = next(f for f in derive_host(_BY["data-01"], _AS_OF)
              if f["rule_id"] == "DB_EXPOSED")
    assert db["severity"] == "critical" and "CC6.6" in db["controls"]
    admin = next(f for f in derive_host(_BY["admin"], _AS_OF)
                 if f["rule_id"] == "ADMIN_EXPOSED")
    assert admin["severity"] == "critical" and "CC6.1" in admin["controls"]


def test_tls_and_eol_detectors():
    assert "TLS_EXPIRED" in _rules("legacy")
    assert {"WEAK_KEY", "WEAK_SIG", "SELF_SIGNED"} <= _rules("vpn")
    assert "DEPRECATED_TLS" in _rules("mail")
    assert "TLS_EXPIRING" in _rules("cdn")
    assert "EOL_SOFTWARE" in _rules("bastion") and "EOL_SOFTWARE" in _rules("old-web")


def test_restricted_and_clean_hosts_produce_no_findings():
    assert "DB_EXPOSED" not in _rules("db-prod")  # restricted exposure
    assert derive_host(_BY["docs"], _AS_OF) == []


# --- posture scoring (severity-weighted, saturating) ------------------------

def test_score_is_severity_weighted_and_saturating():
    assert posture.score_for(0) == 100
    assert posture.score_for(10) > posture.score_for(30) > posture.score_for(120) >= 0


def test_grade_bands():
    assert posture.grade(95) == "A" and posture.grade(80) == "B"
    assert posture.grade(65) == "C" and posture.grade(50) == "D"
    assert posture.grade(20) == "F"


def test_exposure_scan_posture_and_frameworks():
    r = scan.run("exposure")
    p = r["posture"]
    assert 0 <= p["score"] <= 100 and p["grade"]
    assert p["controls_failing"] >= 1
    assert len(r["framework_rollup"]) == 6
    assert sum(r["severity_counts"].values()) == len(r["findings"])


# --- remediation diff -------------------------------------------------------

def test_remediation_diff_improves_posture_and_flips_controls():
    d = scan.diff("exposure")
    assert d["after"]["posture"]["score"] > d["before"]["posture"]["score"]
    assert d["score_delta"] > 0
    assert {"DB_EXPOSED", "ADMIN_EXPOSED", "EOL_SOFTWARE", "TLS_EXPIRED"} \
        <= set(d["fixed_findings"])
    assert {"CC6.1", "CC6.6"} <= set(d["controls_remediated"])


def test_remediation_diff_reports_framework_progress():
    d = scan.diff("exposure")
    for fw in d["framework_progress"]:
        assert fw["after_failing"] <= fw["before_failing"]
    # at least one framework strictly improves
    assert any(fw["after_failing"] < fw["before_failing"]
               for fw in d["framework_progress"])
