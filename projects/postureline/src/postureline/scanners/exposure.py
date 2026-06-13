"""Exposure scanner (perimeter's logic) → canonical Findings.

Reads the synthetic internet-intelligence inventory, runs every host's services
through the structural detectors (``fingerprint.py``), and lifts each raw exposure
into the shared ``Finding`` shape — the control ids the detector attached
(``CC6.6``, ``CC6.7``, …) flow straight through, so the same finding the warehouse
scanner emits and an exposure finding land on the same multi-framework crosswalk.

``remediated=True`` runs the 'after' estate (internet-open datastores pulled behind
an allowlist, admin panel allowlisted, end-of-life software upgraded, expired cert
renewed) so the before/after diff isolates the posture lift. Surface-specific extras
(the inventory summary) ride on the ``ScanResult`` for the UI and evidence export.
"""

from __future__ import annotations

from postureline import data, fingerprint
from postureline.findings import Finding, ScanResult


def scan(remediated: bool = False, *, mode: str | None = None) -> ScanResult:
    """Run the exposure scan on the synthetic estate → ``ScanResult``."""
    estate_hosts = data.remediated_hosts() if remediated else data.hosts()
    findings: list[Finding] = []
    for host in estate_hosts:
        for raw in fingerprint.derive_host(host):
            findings.append(Finding(
                id=raw["rule_id"], surface="exposure", severity=raw["severity"],
                resource=raw["asset"], title=raw["title"],
                evidence=raw["evidence"], control_ids=raw["controls"],
                remediation=raw["remediation"]))

    extras = {
        "estate": data.ESTATE,
        "scan_date": data.SCAN_DATE,
        "inventory": _inventory_summary(estate_hosts),
        "hosts": estate_hosts,
    }
    return ScanResult(surface="exposure", findings=findings, extras=extras)


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
