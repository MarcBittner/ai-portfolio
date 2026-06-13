"""Evidence export — turn a governed report into an auditor-ready bundle.

Exposure-origin artifact (from perimeter), generalized to either surface. An
auditor wants, per control, the findings that failed it and the multi-framework
crosswalk that control satisfies. This assembles that bundle (all controls, or a
single ``control=``) and serializes it as JSON or CSV — the trace from
"posture finding" to "the control it affects" across all six frameworks.
"""

from __future__ import annotations

import csv
import io

from postureline import controls
from postureline.scan import run


def bundle(surface: str, control: str | None = None) -> dict:
    """Per-control evidence bundle for ``surface``: each control with its crosswalk,
    status, and the findings that drive it. ``control`` narrows to a single id."""
    report = run(surface)
    by_id = {f["id"]: f for f in report["findings"]}
    rows = []
    for c in report["controls"]:
        if control and c["id"] != control:
            continue
        evidence = []
        for hit in c["findings"]:
            src = by_id.get(hit["id"], {})
            evidence.append({
                "id": hit["id"],
                "resource": hit["resource"],
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
        "surface": surface,
        "frameworks": controls.frameworks(),
        "control": control,
        "controls": rows,
        "control_count": len(rows),
    }


def to_csv(surface: str, control: str | None = None) -> str:
    """Flat one-row-per-(control, finding) CSV for spreadsheet / GRC-tool import."""
    b = bundle(surface, control)
    fw_cols = b["frameworks"]
    out = io.StringIO()
    w = csv.writer(out)
    w.writerow(["control", "control_title", "status", *fw_cols,
                "finding_id", "resource", "severity", "finding", "remediation"])
    for c in b["controls"]:
        fw_vals = [c["frameworks"].get(fw, "") for fw in fw_cols]
        if not c["evidence"]:
            w.writerow([c["control"], c["title"], c["status"], *fw_vals,
                        "", "", "", "", ""])
            continue
        for e in c["evidence"]:
            w.writerow([c["control"], c["title"], c["status"], *fw_vals,
                        e["id"], e["resource"], e["severity"], e["title"],
                        e["remediation"]])
    return out.getvalue()
