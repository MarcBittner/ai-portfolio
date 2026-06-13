"""Orchestrate a scan: enumerate → fingerprint → map to controls → posture.

Fixture mode produces the full control-mapped exposure report on the owned
synthetic domain. Live mode does passive CT-log recon only (subdomains) on a
real domain — no active probing, no findings — which is the responsible default
for anything you don't own.
"""

from attack_surface import controls, ct, fingerprint
from attack_surface.data import DOMAIN, SERVICES, remediated_services

SEVERITY_WEIGHT = {"critical": 10, "high": 6, "medium": 3, "low": 1}
SEVERITY_ORDER = {"critical": 0, "high": 1, "medium": 2, "low": 3}


def _grade(score: int) -> str:
    return ("A" if score >= 90 else "B" if score >= 75 else "C" if score >= 60
            else "D" if score >= 40 else "F")


def _posture(findings: list[dict], control_rows: list[dict]) -> dict:
    penalty = sum(SEVERITY_WEIGHT.get(f["severity"], 0) for f in findings)
    score = max(0, 100 - penalty)
    failing = sum(1 for c in control_rows if c["status"] == "fail")
    return {"score": score, "grade": _grade(score),
            "controls_failing": failing, "controls_total": len(control_rows)}


def scan_fixture(remediated: bool = False) -> dict:
    """Full control-mapped report on the owned fixture.

    ``remediated=True`` runs the 'after' state where the two critical findings
    are fixed, so the before/after diff (``remediation_diff``) isolates the
    posture lift and the controls that flip fail → pass.
    """
    services = remediated_services() if remediated else SERVICES
    entries = ct.enumerate_fixture()
    findings: list[dict] = []
    for svc in services:
        findings.extend(fingerprint.derive(svc, DOMAIN))
    findings.sort(key=lambda f: (SEVERITY_ORDER.get(f["severity"], 9), f["asset"]))
    control_rows = controls.evaluate(findings)
    sev_counts = {s: sum(1 for f in findings if f["severity"] == s)
                  for s in SEVERITY_WEIGHT}
    return {
        "domain": DOMAIN, "mode": "fixture",
        "remediated": remediated,
        "assets": {
            "subdomains": ct.subdomains(entries),
            "ct_entries": entries,
            "services": [{"asset": f"{s['subdomain']}.{DOMAIN}:{s['port']}",
                          "service": s["service"], "exposed": s["internet_exposed"]}
                         for s in services],
        },
        "findings": findings,
        "severity_counts": sev_counts,
        "controls": control_rows,
        "posture": _posture(findings, control_rows),
    }


def remediation_diff() -> dict:
    """Before/after the two critical fixes: posture lift + which controls flip.

    Deterministic — both states come from the fixture, so the demo and the eval
    report the same numbers with zero keys.
    """
    before = scan_fixture(remediated=False)
    after = scan_fixture(remediated=True)
    fixed = sorted({f["rule_id"] for f in before["findings"]}
                   - {f["rule_id"] for f in after["findings"]})
    before_fail = {c["id"] for c in before["controls"] if c["status"] == "fail"}
    after_fail = {c["id"] for c in after["controls"] if c["status"] == "fail"}
    return {
        "domain": DOMAIN,
        "before": {"posture": before["posture"],
                   "severity_counts": before["severity_counts"]},
        "after": {"posture": after["posture"],
                  "severity_counts": after["severity_counts"]},
        "fixed_findings": fixed,
        "controls_remediated": sorted(before_fail - after_fail),
        "score_delta": after["posture"]["score"] - before["posture"]["score"],
    }


def scan_live(domain: str) -> dict:
    entries = ct.enumerate_live(domain)
    return {
        "domain": domain, "mode": "live",
        "note": "passive CT-log recon only — no active scanning of third-party hosts; "
                "the control-mapped findings report runs on the owned fixture domain.",
        "assets": {"subdomains": ct.subdomains(entries), "ct_entries": entries},
        "findings": [], "controls": [],
    }


def scan(domain: str | None = None, mode: str = "fixture") -> dict:
    if mode == "live":
        return scan_live(domain or DOMAIN)
    return scan_fixture()
