"""Reproducible eval: structural GRC invariants + posture before/after remediation.

Writes ``eval-report.md`` at the project root and prints a summary. Run via
``./run.sh eval`` (or ``python -m attack_surface.evaluate``). Deterministic
offline, so the report reproduces to the digit with zero keys; set ``LLM_MODE`` /
provider keys to generate the exec narrative with a live model instead.

The invariants are asserted as *measured facts*, not claimed: every finding maps
to ≥1 control, every failing control traces to ≥1 finding, the posture math
checks out, and the exec narrative's remediation guidance covers every critical
exposure (an uncovered critical is a governance gap).
"""

from __future__ import annotations

import os
from pathlib import Path

from attack_surface import narrative
from attack_surface.scanner import SEVERITY_WEIGHT, remediation_diff, scan_fixture

REPORT = Path(__file__).resolve().parents[2] / "eval-report.md"


def _invariants(report: dict) -> dict:
    findings, control_rows = report["findings"], report["controls"]
    every_finding_mapped = all(f["controls"] for f in findings)
    failing_trace = all(
        c["finding_count"] == len(c["findings"]) >= 1
        for c in control_rows if c["status"] == "fail")
    penalty = sum(SEVERITY_WEIGHT.get(f["severity"], 0) for f in findings)
    posture_math = report["posture"]["score"] == max(0, 100 - penalty)
    sev_sum = sum(report["severity_counts"].values()) == len(findings)
    return {
        "every_finding_maps_to_a_control": every_finding_mapped,
        "every_failing_control_traces_to_findings": failing_trace,
        "posture_math_checks_out": posture_math,
        "severity_counts_sum_to_findings": sev_sum,
    }


def run() -> dict:
    report = scan_fixture()
    inv = _invariants(report)
    narr = narrative.evaluate()
    diff = remediation_diff()
    return {"invariants": inv, "narrative": narr, "diff": diff,
            "findings": len(report["findings"]),
            "controls": len(report["controls"]),
            "mode": os.environ.get("LLM_MODE", "auto")}


def _render(r: dict) -> str:
    inv, narr, diff = r["invariants"], r["narrative"], r["diff"]
    b, a = diff["before"]["posture"], diff["after"]["posture"]
    yes = "✓"  # check mark
    lines = [
        "# attack-surface — eval report",
        "",
        "Reproducible with `./run.sh eval`. Deterministic offline (template "
        "narrative + fixture report) by default, so these numbers reproduce "
        "exactly with zero keys; set provider keys or `LLM_MODE` to generate the "
        "exec narrative with a live model.",
        "",
        "## Governed-evidence invariants",
        "",
        f"Asserted as measured facts over the **{r['findings']}** findings and "
        f"**{r['controls']}** in-scope controls of the fixture report.",
        "",
        "| invariant | holds |",
        "| --- | --- |",
    ]
    label = {
        "every_finding_maps_to_a_control": "every finding maps to ≥ 1 control",
        "every_failing_control_traces_to_findings":
            "every failing control traces to ≥ 1 finding",
        "posture_math_checks_out": "posture = 100 − Σ severity penalty (clamped ≥ 0)",
        "severity_counts_sum_to_findings": "severity counts sum to finding count",
    }
    for k, v in inv.items():
        lines.append(f"| {label[k]} | {yes if v else 'FAIL'} |")
    lines += [
        "",
        "## Exec narrative — remediation coverage",
        "",
        "The LLM exec narrative writes board-ready prose plus remediation guidance "
        "over the *already-computed* report. **Coverage of every critical (and "
        "high) finding is the safety metric** — an uncovered critical is a gap in "
        "the board report.",
        "",
        "| metric | value |",
        "| --- | --- |",
        f"| criticals | {', '.join(narr['criticals']) or 'none'} |",
        f"| findings requiring guidance | {len(narr['must_cover'])} |",
        f"| covered by remediation | {len(narr['covered'])} |",
        f"| uncovered (gaps) | {', '.join(narr['missed']) or 'none'} |",
        f"| every critical covered | {yes if narr['criticals_covered'] else 'FAIL'} |",
        f"| provider | {narr['provider']} |",
        "",
        "## Posture over time — remediation diff",
        "",
        "Fixing the two critical findings (`" + "`, `".join(diff["fixed_findings"])
        + "`) lifts the posture and flips the controls they hit fail → pass:",
        "",
        "| state | score | grade | controls failing |",
        "| --- | --- | --- | --- |",
        f"| before | {b['score']}/100 | {b['grade']} | "
        f"{b['controls_failing']}/{b['controls_total']} |",
        f"| after | {a['score']}/100 | {a['grade']} | "
        f"{a['controls_failing']}/{a['controls_total']} |",
        "",
        f"Posture moved **{b['grade']} → {a['grade']}** "
        f"(+{diff['score_delta']} points); "
        f"**{len(diff['controls_remediated'])} control(s) remediated** "
        f"({', '.join(diff['controls_remediated'])}).",
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
