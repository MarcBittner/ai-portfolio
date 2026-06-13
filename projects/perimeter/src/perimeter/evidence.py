"""Evidence export — turn the governed report into an auditor-ready bundle.

An auditor doesn't want the posture headline; they want, per control, the exposures
that failed it and the multi-framework crosswalk that control satisfies. This module
assembles that bundle (all controls, or a single ``control=`` for a focused request)
and serializes it as JSON or CSV — the artifact you hand to a SOC 2 / ISO / CMMC
assessor as the trace from "internet-exposure finding" to "the control it affects."
"""

from __future__ import annotations

import csv
import io

from perimeter import controls
from perimeter.scan import scan


def bundle(control: str | None = None) -> dict:
    """Per-control evidence bundle: each control with its crosswalk, status, and the
    exposure findings that drive it. ``control`` narrows to a single control id.
    """
    report = scan()
    by_id = {f["rule_id"]: f for f in report["findings"]}
    rows = []
    for c in report["controls"]:
        if control and c["id"] != control:
            continue
        evidence = []
        for hit in c["findings"]:
            src = by_id.get(hit["rule_id"], {})
            evidence.append({
                "rule_id": hit["rule_id"],
                "asset": hit["asset"],
                "severity": hit["severity"],
                "title": src.get("title", ""),
                "evidence": src.get("evidence", {}),
                "remediation": src.get("remediation", ""),
            })
        rows.append({
            "control": c["id"],
            "title": c["title"],
            "frameworks": c["frameworks"],
            "status": c["status"],
            "finding_count": c["finding_count"],
            "evidence": evidence,
        })
    return {
        "estate": report["estate"],
        "scan_date": report["scan_date"],
        "frameworks": controls.frameworks(),
        "control": control,
        "controls": rows,
        "control_count": len(rows),
    }


def to_csv(control: str | None = None) -> str:
    """Flat one-row-per-(control, finding) CSV for spreadsheet / GRC-tool import."""
    b = bundle(control)
    fw_cols = b["frameworks"]
    out = io.StringIO()
    w = csv.writer(out)
    w.writerow(["control", "control_title", "status", *fw_cols,
                "rule_id", "asset", "severity", "finding", "remediation"])
    for c in b["controls"]:
        fw_vals = [c["frameworks"].get(fw, "") for fw in fw_cols]
        if not c["evidence"]:
            w.writerow([c["control"], c["title"], c["status"], *fw_vals,
                        "", "", "", "", ""])
            continue
        for e in c["evidence"]:
            w.writerow([c["control"], c["title"], c["status"], *fw_vals,
                        e["rule_id"], e["asset"], e["severity"], e["title"],
                        e["remediation"]])
    return out.getvalue()
