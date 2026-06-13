"""Multi-framework control catalog + crosswalk, and the roll-up that turns
exposure findings into per-control and per-framework status.

The GRC point: a scan result is not evidence until it is mapped to a control with a
status and a remediation. A *director* needs more than one framework — the same
internet-exposure finding has to be defensible to a SOC 2 auditor, an ISO 27001
auditor, a federal (NIST 800-53 / 800-171) assessor, and a CMMC C3PAO at once. So
every control in this catalog carries its crosswalk across **four frameworks**, and
the roll-up reports status per control *and* per framework (the pass/fail picture a
board and each auditor actually ask for).

Each finding emitted by ``fingerprint.py`` references one or more control ids here;
``evaluate()`` inverts that into per-control status and ``framework_rollup()``
aggregates it into the per-framework pass/fail summary.
"""

from __future__ import annotations

# Canonical control catalog. The `id` is the SOC 2 Trust Services Criteria (the
# anchor framework); each row crosswalks to the equivalent ISO/IEC 27001:2022
# Annex A control, NIST SP 800-53 Rev 5 control, NIST SP 800-171 requirement, and
# CMMC Level 2 practice — one finding, defensible against all of them.
CATALOG: dict[str, dict] = {
    "CC6.1": {
        "title": "Logical access — authentication & authorization boundaries",
        "iso27001": "A.8.3", "nist_800_53": "AC-3", "nist_800_171": "3.1.1",
        "cmmc": "AC.L2-3.1.1"},
    "CC6.6": {
        "title": "Boundary protection — limit exposure of internal services",
        "iso27001": "A.8.20", "nist_800_53": "SC-7", "nist_800_171": "3.13.1",
        "cmmc": "SC.L2-3.13.1"},
    "CC6.7": {
        "title": "Data in transit — strong cryptography & key management",
        "iso27001": "A.8.24", "nist_800_53": "SC-8", "nist_800_171": "3.13.11",
        "cmmc": "SC.L2-3.13.11"},
    "CC6.8": {
        "title": "Unauthorized / malicious software — supported, patched versions",
        "iso27001": "A.8.8", "nist_800_53": "SI-2", "nist_800_171": "3.14.1",
        "cmmc": "SI.L2-3.14.1"},
    "CC7.1": {
        "title": "Detection — continuous vulnerability & exposure monitoring",
        "iso27001": "A.8.8", "nist_800_53": "RA-5", "nist_800_171": "3.11.2",
        "cmmc": "RA.L2-3.11.2"},
    "CC7.2": {
        "title": "Monitoring — anomalous external exposure of system components",
        "iso27001": "A.8.16", "nist_800_53": "SI-4", "nist_800_171": "3.14.6",
        "cmmc": "SI.L2-3.14.6"},
}

# The frameworks this catalog reports against, and the field that names each
# control's mapping in that framework. SOC 2 uses the catalog id itself.
FRAMEWORKS: dict[str, str | None] = {
    "SOC 2": None,
    "ISO 27001": "iso27001",
    "NIST 800-53": "nist_800_53",
    "NIST 800-171": "nist_800_171",
    "CMMC": "cmmc",
}


def _refs(cid: str) -> dict[str, str]:
    """The control's identifier in each framework (for crosswalk display/export)."""
    meta = CATALOG[cid]
    out = {"SOC 2": cid}
    for fw, field in FRAMEWORKS.items():
        if field:
            out[fw] = meta[field]
    return out


def catalog() -> list[dict]:
    """The full control catalog, each row carrying its four-framework crosswalk."""
    return [{"id": cid, **meta, "frameworks": _refs(cid)}
            for cid, meta in CATALOG.items()]


def frameworks() -> list[str]:
    return list(FRAMEWORKS)


def evaluate(findings: list[dict]) -> list[dict]:
    """For every control in scope, the findings mapped to it and a pass/fail status.

    A control fails if any finding maps to it; the roll-up is *derived* from the
    findings (never asserted independently), so a failing control always traces
    back to the evidence that failed it.
    """
    by_control: dict[str, list[dict]] = {cid: [] for cid in CATALOG}
    for f in findings:
        for cid in f.get("controls", []):
            by_control.setdefault(cid, []).append(
                {"rule_id": f["rule_id"], "asset": f["asset"],
                 "severity": f["severity"]})
    out = []
    for cid, hits in by_control.items():
        meta = CATALOG.get(cid, {"title": cid})
        out.append({
            "id": cid, "title": meta.get("title", cid),
            "frameworks": _refs(cid) if cid in CATALOG else {"SOC 2": cid},
            "status": "fail" if hits else "pass",
            "findings": hits, "finding_count": len(hits)})
    out.sort(key=lambda c: (c["status"] != "fail", c["id"]))
    return out


def framework_rollup(control_rows: list[dict]) -> list[dict]:
    """Aggregate per-control status into a per-framework pass/fail summary.

    This is the multi-framework picture a GRC director presents: for each of the
    five frameworks, how many of its mapped controls pass vs. fail, and which
    framework-native control ids are currently failing.
    """
    rows = []
    for fw in FRAMEWORKS:
        passing = failing = 0
        failing_ids: list[str] = []
        for c in control_rows:
            ref = c["frameworks"].get(fw)
            if not ref:
                continue
            if c["status"] == "fail":
                failing += 1
                failing_ids.append(ref)
            else:
                passing += 1
        total = passing + failing
        rows.append({
            "framework": fw,
            "controls_total": total,
            "controls_passing": passing,
            "controls_failing": failing,
            "failing_control_ids": sorted(set(failing_ids)),
            "status": "fail" if failing else "pass",
        })
    return rows
