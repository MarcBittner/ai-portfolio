"""Reproducible eval: structural GRC invariants + posture before/after remediation.

Writes ``eval-report.md`` at the project root and prints a summary. Run via
``./run.sh eval`` (or ``python -m perimeter.evaluate``). Deterministic offline, so
the report reproduces to the digit with zero keys; set ``LLM_MODE`` / provider keys
to generate the board narrative with a live model instead.

The invariants are asserted as *measured facts*, not claimed: every finding maps to
≥ 1 control across the frameworks, every failing control traces to ≥ 1 finding, the
posture math checks out, the multi-framework roll-up is consistent, and the board
report's top-risk list covers every critical exposure (an uncovered critical is a
governance gap).
"""

from __future__ import annotations

import os
from pathlib import Path

from perimeter import controls, narrative
from perimeter.risk import SEVERITY_WEIGHT, score_for
from perimeter.scan import remediation_diff, scan

REPORT = Path(__file__).resolve().parents[2] / "eval-report.md"


def _invariants(report: dict) -> dict:
    findings, control_rows = report["findings"], report["controls"]
    fw_rows = report["framework_rollup"]

    every_finding_mapped = all(f["controls"] for f in findings)
    failing_trace = all(
        c["finding_count"] == len(c["findings"]) >= 1
        for c in control_rows if c["status"] == "fail")
    penalty = sum(SEVERITY_WEIGHT.get(f["severity"], 0) for f in findings)
    posture_math = report["posture"]["score"] == score_for(penalty)
    sev_sum = sum(report["severity_counts"].values()) == len(findings)

    # every finding's control ids exist in the catalog (no orphan mapping)
    catalog_ids = {c["id"] for c in controls.catalog()}
    controls_known = all(cid in catalog_ids
                         for f in findings for cid in f["controls"])
    # multi-framework: every failing control is counted in every framework whose
    # crosswalk it carries
    failing_controls = [c for c in control_rows if c["status"] == "fail"]
    fw_consistent = all(
        sum(1 for c in failing_controls if r["framework"] in c["frameworks"])
        == r["controls_failing"]
        for r in fw_rows)
    return {
        "every_finding_maps_to_a_control": every_finding_mapped,
        "every_failing_control_traces_to_findings": failing_trace,
        "all_mapped_controls_exist_in_catalog": controls_known,
        "framework_rollup_consistent": fw_consistent,
        "posture_math_checks_out": posture_math,
        "severity_counts_sum_to_findings": sev_sum,
    }


def run() -> dict:
    report = scan()
    inv = _invariants(report)
    narr = narrative.evaluate()
    diff = remediation_diff()
    return {"invariants": inv, "narrative": narr, "diff": diff,
            "findings": len(report["findings"]),
            "controls": len(report["controls"]),
            "frameworks": len(report["framework_rollup"]),
            "framework_rollup": report["framework_rollup"],
            "mode": os.environ.get("LLM_MODE", "auto")}


def _render(r: dict) -> str:
    inv, narr, diff = r["invariants"], r["narrative"], r["diff"]
    b, a = diff["before"]["posture"], diff["after"]["posture"]
    yes = "✓"  # check mark
    lines = [
        "# perimeter — eval report",
        "",
        "Reproducible with `./run.sh eval`. Deterministic offline (template board "
        "report + fixture posture) by default, so these numbers reproduce exactly "
        "with zero keys; set provider keys or `LLM_MODE` to generate the board "
        "narrative with a live model.",
        "",
        "## Governed-evidence invariants",
        "",
        f"Asserted as measured facts over the **{r['findings']}** exposure findings, "
        f"**{r['controls']}** in-scope controls, and **{r['frameworks']}** compliance "
        f"frameworks of the fixture posture run.",
        "",
        "| invariant | holds |",
        "| --- | --- |",
    ]
    label = {
        "every_finding_maps_to_a_control": "every finding maps to ≥ 1 control",
        "every_failing_control_traces_to_findings":
            "every failing control traces to ≥ 1 finding",
        "all_mapped_controls_exist_in_catalog":
            "every mapped control id exists in the catalog",
        "framework_rollup_consistent":
            "per-framework roll-up matches the per-control status",
        "posture_math_checks_out":
            "posture = 100 / (1 + Σ severity penalty / K)",
        "severity_counts_sum_to_findings": "severity counts sum to finding count",
    }
    for k in label:
        lines.append(f"| {label[k]} | {yes if inv[k] else 'FAIL'} |")

    lines += [
        "",
        "## Multi-framework coverage",
        "",
        "One exposure finding, mapped through the crosswalk, lands on a control in "
        "each framework — so the same evidence is defensible to a SOC 2, ISO 27001, "
        "NIST 800-53/800-171, and CMMC assessor at once.",
        "",
        "| framework | failing | total | failing control ids |",
        "| --- | --- | --- | --- |",
    ]
    for fw in r["framework_rollup"]:
        ids = ", ".join(f"`{i}`" for i in fw["failing_control_ids"]) or "—"
        lines.append(f"| {fw['framework']} | {fw['controls_failing']} | "
                     f"{fw['controls_total']} | {ids} |")

    lines += [
        "",
        "## Board report — top-risk coverage",
        "",
        "The LLM board report writes posture prose plus a prioritized top-risk list "
        "over the *already-computed* report. **Coverage of every critical (and high) "
        "finding is the safety metric** — an uncovered critical is a gap in the board "
        "report.",
        "",
        "| metric | value |",
        "| --- | --- |",
        f"| criticals | {', '.join(narr['criticals']) or 'none'} |",
        f"| findings requiring coverage | {len(narr['must_cover'])} |",
        f"| covered in top risks | {len(narr['covered'])} |",
        f"| uncovered (gaps) | {', '.join(narr['missed']) or 'none'} |",
        f"| every critical covered | {yes if narr['criticals_covered'] else 'FAIL'} |",
        f"| provider | {narr['provider']} |",
        "",
        "## Posture over time — remediation diff",
        "",
        "Fixing the top exposures (`" + "`, `".join(diff["fixed_findings"])
        + "`) lifts the posture and flips the controls and frameworks they hit "
          "fail → pass:",
        "",
        "| state | score | grade | controls failing | frameworks failing |",
        "| --- | --- | --- | --- | --- |",
        f"| before | {b['score']}/100 | {b['grade']} | "
        f"{b['controls_failing']}/{b['controls_total']} | "
        f"{b['frameworks_failing']}/{b['frameworks_total']} |",
        f"| after | {a['score']}/100 | {a['grade']} | "
        f"{a['controls_failing']}/{a['controls_total']} | "
        f"{a['frameworks_failing']}/{a['frameworks_total']} |",
        "",
        f"Posture moved **{b['grade']} → {a['grade']}** "
        f"(+{diff['score_delta']} points); "
        f"**{len(diff['controls_remediated'])} control(s) remediated** "
        f"({', '.join(diff['controls_remediated'])})"
        + (f"; frameworks cleared: {', '.join(diff['frameworks_cleared'])}."
           if diff["frameworks_cleared"] else "."),
        "",
    ]
    return "\n".join(lines)


def main() -> None:
    r = run()
    REPORT.write_text(_render(r))
    inv, narr, diff = r["invariants"], r["narrative"], r["diff"]
    b, a = diff["before"]["posture"], diff["after"]["posture"]
    print(f"invariants: {sum(inv.values())}/{len(inv)} hold")
    print(f"narrative: criticals_covered={narr['criticals_covered']} "
          f"coverage_complete={narr['coverage_complete']} "
          f"(provider: {narr['provider']})")
    print(f"remediation diff: {b['grade']}({b['score']}) -> {a['grade']}({a['score']}), "
          f"{len(diff['controls_remediated'])} controls remediated")
    print(f"wrote {REPORT}")


if __name__ == "__main__":
    main()
