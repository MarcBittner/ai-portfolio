"""Orchestrate a governed posture run: inventory → fingerprint → controls →
multi-framework roll-up → severity-weighted posture.

``scan()`` produces the full governed report on the synthetic estate; the
``remediated`` flavour runs the 'after' state so ``diff()`` can isolate the
posture lift. ``gate()`` is the CI hook: it fails the build when the posture
falls below a threshold or any disallowed-severity exposure is open.
"""

from __future__ import annotations

from perimeter import controls, fingerprint, risk
from perimeter.data import ESTATE, SCAN_DATE, hosts, remediated_hosts


def scan(remediated: bool = False) -> dict:
    """Full governed report on the synthetic internet-exposure estate.

    ``remediated=True`` runs the 'after' state (the two internet-open databases
    pulled off the public edge, the expired legacy cert renewed) so the before/after
    diff isolates the posture lift and the controls/frameworks that flip fail → pass.
    """
    estate_hosts = remediated_hosts() if remediated else hosts()
    findings: list[dict] = []
    for host in estate_hosts:
        findings.extend(fingerprint.derive_host(host))
    findings.sort(key=lambda f: (risk.SEVERITY_ORDER.get(f["severity"], 9), f["asset"]))

    control_rows = controls.evaluate(findings)
    framework_rows = controls.framework_rollup(control_rows)
    sev = risk.severity_counts(findings)
    return {
        "estate": ESTATE,
        "scan_date": SCAN_DATE,
        "remediated": remediated,
        "inventory": _inventory_summary(estate_hosts),
        "hosts": estate_hosts,
        "findings": findings,
        "severity_counts": sev,
        "controls": control_rows,
        "framework_rollup": framework_rows,
        "posture": risk.posture(findings, control_rows, framework_rows),
    }


def remediation_diff() -> dict:
    """Before/after the top remediations: posture lift + controls/frameworks flipped.

    Deterministic — both states come from the fixture estate, so the demo and the
    eval report the same numbers with zero keys.
    """
    d = risk.diff(scan(remediated=False), scan(remediated=True))
    d["estate"] = ESTATE
    return d


def gate(min_score: int = 60, fail_on: tuple[str, ...] = ("critical",)) -> dict:
    """CI gate: pass only if posture clears ``min_score`` and no exposure of a
    disallowed severity is open. Returns the decision + the reasons.
    """
    report = scan()
    p = report["posture"]
    blocking = [f for f in report["findings"] if f["severity"] in fail_on]
    reasons: list[str] = []
    if p["score"] < min_score:
        reasons.append(f"posture {p['score']} < min_score {min_score}")
    if blocking:
        rules = sorted({f["rule_id"] for f in blocking})
        reasons.append(f"{len(blocking)} {'/'.join(fail_on)} exposure(s) open: "
                       f"{', '.join(rules)}")
    return {
        "passed": not reasons,
        "score": p["score"],
        "grade": p["grade"],
        "min_score": min_score,
        "fail_on": list(fail_on),
        "blocking_exposures": len(blocking),
        "reasons": reasons,
    }


def _inventory_summary(estate_hosts: list[dict]) -> dict:
    services = [s for h in estate_hosts for s in h["services"]]
    asns = sorted({h["asn"] for h in estate_hosts})
    countries = sorted({h["country"] for h in estate_hosts})
    internet_open = sum(1 for s in services if s.get("exposure") == "0.0.0.0/0")
    with_tls = sum(1 for s in services if s.get("tls"))
    return {
        "hosts": len(estate_hosts),
        "services": len(services),
        "internet_open_services": internet_open,
        "tls_services": with_tls,
        "asns": asns,
        "countries": countries,
    }
