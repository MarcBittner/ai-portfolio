"""SOC 2 (Trust Services Criteria) + ISO/IEC 27001:2022 control catalog, and the
roll-up that turns findings into per-control status.

The GRC point: a finding isn't evidence until it's mapped to a control with a
status and a remediation. This catalog is the bridge from "we found an exposure"
to "here is the auditable control it affects."
"""

# Each control carries a NIST SP 800-171 ↔ CMMC L2 crosswalk so the same finding
# can be defended against a federal-supply-chain (CMMC) auditor as well as a
# SOC 2 / ISO one — one piece of evidence, multiple frameworks.
CATALOG: dict[str, dict] = {
    "SOC2:CC6.1": {"framework": "SOC 2", "title": "Logical & physical access controls",
                   "nist_800_171": "3.1.1", "cmmc": "AC.L2-3.1.1"},
    "SOC2:CC6.6": {"framework": "SOC 2", "title": "Boundary protection (network)",
                   "nist_800_171": "3.13.1", "cmmc": "SC.L2-3.13.1"},
    "SOC2:CC6.7": {"framework": "SOC 2", "title": "Data in transit protection",
                   "nist_800_171": "3.13.8", "cmmc": "SC.L2-3.13.8"},
    "SOC2:CC7.1": {"framework": "SOC 2", "title": "Detection of new vulnerabilities",
                   "nist_800_171": "3.14.1", "cmmc": "SI.L2-3.14.1"},
    "ISO:A.5.7":  {"framework": "ISO 27001", "title": "Threat intelligence",
                   "nist_800_171": "3.14.3", "cmmc": "SI.L2-3.14.3"},
    "ISO:A.5.15": {"framework": "ISO 27001", "title": "Access control",
                   "nist_800_171": "3.1.1", "cmmc": "AC.L2-3.1.1"},
    "ISO:A.8.20": {"framework": "ISO 27001", "title": "Networks security",
                   "nist_800_171": "3.13.1", "cmmc": "SC.L2-3.13.1"},
    "ISO:A.8.24": {"framework": "ISO 27001", "title": "Use of cryptography",
                   "nist_800_171": "3.13.11", "cmmc": "SC.L2-3.13.11"},
}


def catalog() -> list[dict]:
    return [{"id": cid, **c} for cid, c in CATALOG.items()]


def evaluate(findings: list[dict]) -> list[dict]:
    """For every control in scope, list the findings mapped to it and a status."""
    by_control: dict[str, list[dict]] = {cid: [] for cid in CATALOG}
    for f in findings:
        for cid in f.get("controls", []):
            by_control.setdefault(cid, []).append(
                {"rule_id": f["rule_id"], "asset": f["asset"], "severity": f["severity"]})
    out = []
    for cid, hits in by_control.items():
        meta = CATALOG.get(cid, {"framework": "?", "title": cid})
        out.append({"id": cid, **meta,
                    "status": "fail" if hits else "pass",
                    "findings": hits, "finding_count": len(hits)})
    out.sort(key=lambda c: (c["status"] != "fail", c["id"]))
    return out
