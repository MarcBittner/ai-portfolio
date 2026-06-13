"""One unified, multi-framework control catalog + crosswalk for BOTH surfaces.

This is the merge's centre of gravity. maskline mapped warehouse findings to
**SOC 2 + HIPAA**; perimeter mapped exposure findings to a **five-framework**
crosswalk (SOC 2 → ISO 27001 → NIST 800-53 → NIST 800-171 → CMMC). postureline
folds them into ONE catalog so a single finding — whether it came from the
warehouse or the internet-exposure scanner — is defensible across **six
frameworks** at once: SOC 2, HIPAA, ISO 27001, NIST 800-53, NIST 800-171, CMMC.

Each control is anchored on its SOC 2 Trust Services Criteria id (the common
spine both demos already shared) and carries its crosswalk to the equivalent
control in every other framework. Findings reference the anchor ids; this module
expands them across frameworks, rolls per-control status up from the findings
(``fail`` iff any finding maps to it), and aggregates that into the per-framework
pass/fail picture each auditor asks for.

The catalog is the union of the two origins:
- perimeter's boundary/crypto/software controls (CC6.1, CC6.6, CC6.7, CC6.8,
  CC7.1, CC7.2), now also carrying a HIPAA crosswalk;
- maskline's warehouse-specific controls — column masking (CC6.1 extended) and
  **de-identification / re-identification risk** (a new ``GV1.1`` data-governance
  control anchored on HIPAA 164.514, the k-anonymity gate).
"""

from __future__ import annotations

# Canonical control catalog. ``id`` is the SOC 2 / governance anchor; each row
# crosswalks to the equivalent ISO/IEC 27001:2022 Annex A control, NIST SP 800-53
# Rev 5 control, NIST SP 800-171 requirement, CMMC Level 2 practice, and the
# relevant HIPAA Security Rule citation. ``surfaces`` records which scanner(s) a
# control is exercised by (informational; both surfaces can hit any control).
CATALOG: dict[str, dict] = {
    "CC6.1": {
        "title": "Logical access — authentication, authorization & data masking",
        "hipaa": "164.312(a)(1)", "iso27001": "A.8.3", "nist_800_53": "AC-3",
        "nist_800_171": "3.1.1", "cmmc": "AC.L2-3.1.1",
        "surfaces": ["warehouse", "exposure"]},
    "CC6.6": {
        "title": "Boundary protection — limit exposure of internal services/data",
        "hipaa": "164.312(e)(1)", "iso27001": "A.8.20", "nist_800_53": "SC-7",
        "nist_800_171": "3.13.1", "cmmc": "SC.L2-3.13.1",
        "surfaces": ["warehouse", "exposure"]},
    "CC6.7": {
        "title": "Data in transit — strong cryptography & key management",
        "hipaa": "164.312(e)(2)(ii)", "iso27001": "A.8.24", "nist_800_53": "SC-8",
        "nist_800_171": "3.13.11", "cmmc": "SC.L2-3.13.11",
        "surfaces": ["exposure"]},
    "CC6.8": {
        "title": "Unauthorized / malicious software — supported, patched versions",
        "hipaa": "164.308(a)(5)(ii)(B)", "iso27001": "A.8.8", "nist_800_53": "SI-2",
        "nist_800_171": "3.14.1", "cmmc": "SI.L2-3.14.1",
        "surfaces": ["exposure"]},
    "CC7.1": {
        "title": "Detection — continuous vulnerability & exposure monitoring",
        "hipaa": "164.308(a)(1)(ii)(A)", "iso27001": "A.8.8", "nist_800_53": "RA-5",
        "nist_800_171": "3.11.2", "cmmc": "RA.L2-3.11.2",
        "surfaces": ["exposure"]},
    "CC7.2": {
        "title": "Monitoring — anomalous external exposure of system components",
        "hipaa": "164.308(a)(1)(ii)(D)", "iso27001": "A.8.16", "nist_800_53": "SI-4",
        "nist_800_171": "3.14.6", "cmmc": "SI.L2-3.14.6",
        "surfaces": ["warehouse", "exposure"]},
    # Warehouse-origin data-governance control: de-identification / re-id risk.
    # Anchored on HIPAA 164.514 (de-identification — Safe Harbor / Expert
    # Determination); crosswalked to the privacy/data-governance controls in the
    # other frameworks. This is the k-anonymity gate maskline owned.
    "GV1.1": {
        "title": "De-identification — re-identification risk within tolerance",
        "hipaa": "164.514(b)", "iso27001": "A.8.11", "nist_800_53": "SI-19",
        "nist_800_171": "3.1.3", "cmmc": "AC.L2-3.1.3",
        "surfaces": ["warehouse"]},
}

# The six frameworks the catalog reports against and the field that names each
# control's mapping in that framework. SOC 2 uses the catalog id itself.
FRAMEWORKS: dict[str, str | None] = {
    "SOC 2": None,
    "HIPAA": "hipaa",
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
    """The full control catalog, each row carrying its six-framework crosswalk."""
    return [{"id": cid, "title": meta["title"], "surfaces": meta["surfaces"],
             "frameworks": _refs(cid)}
            for cid, meta in CATALOG.items()]


def frameworks() -> list[str]:
    return list(FRAMEWORKS)


def mapped_controls_for(control_ids: list[str]) -> list[str]:
    """Which catalog control ids a finding's anchor ids resolve to (invariant aid)."""
    return [cid for cid in control_ids if cid in CATALOG]


def evaluate(findings: list[dict]) -> list[dict]:
    """For every control in the catalog, the findings mapped to it + a pass/fail.

    A control fails iff any finding maps to it; status is *derived* from the
    findings (never asserted), so a failing control always traces back to the
    evidence that failed it. Findings reference controls via ``control_ids``.
    """
    by_control: dict[str, list[dict]] = {cid: [] for cid in CATALOG}
    for f in findings:
        for cid in f.get("control_ids", []):
            by_control.setdefault(cid, []).append(
                {"id": f["id"], "resource": f["resource"],
                 "severity": f["severity"], "surface": f.get("surface")})
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

    The multi-framework picture a GRC director presents: for each framework, how
    many of its mapped controls pass vs. fail, and which framework-native control
    ids are currently failing.
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
