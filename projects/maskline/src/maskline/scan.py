"""Orchestrate the full governance scan and the CI gate.

``scan()`` runs the pipeline end-to-end:

    discover (warehouse introspection)
      → classify (name/type heuristics + LLM for free-text PHI)
      → policy coverage (which sensitive columns have no masking policy)
      → re-identification risk (k-anonymity)
      → controls (SOC 2 / HIPAA pass-fail + posture)

``gate()`` reduces the scan to a single pass/fail for CI: any sensitive column
that must be masked but isn't is a **fail**. This is the guardrail-in-the-pipeline
idea — the same scan that produces the console dashboard is the thing that blocks
a merge, so governance is a gate that runs, not a doc that rots.
"""

from __future__ import annotations

from maskline import classify, controls, narrative, policy, risk, warehouse


def scan(*, mode: str | None = None, include_narrative: bool = False) -> dict:
    """Run the full governance pipeline and return one consolidated result."""
    classified = classify.classify_all(mode=mode)
    sensitive = [c for c in classified if c["sensitive"]]
    coverage = policy.coverage(classified)
    kanon = risk.k_anonymity()
    sweep = risk.generalization_sweep()
    posture = controls.evaluate(classified, coverage, kanon)
    policies = policy.required_policies(classified)

    summary = {
        "tables": warehouse.tables(),
        "total_columns": len(classified),
        "sensitive_columns": len(sensitive),
        "policies_generated": len(policies),
        "coverage": coverage,
        "risk": kanon,
        "controls": posture,
    }
    result = {
        "warehouse": warehouse.FQ,
        "engine": "duckdb (Snowflake-compatible SQL)",
        "classified": classified,
        "sensitive": sensitive,
        "coverage": coverage,
        "risk": {"kanon": kanon, "sweep": sweep},
        "controls": posture,
        "summary": summary,
        "gate": gate(coverage),
    }
    if include_narrative:
        result["narrative"] = narrative.summarize(summary, mode=mode)
    return result


def gate(coverage: dict | None = None, *, mode: str | None = None) -> dict:
    """CI pass/fail: any unmasked sensitive (direct/quasi) column ⇒ fail."""
    if coverage is None:
        coverage = policy.coverage(classify.classify_all(mode=mode))
    uncovered = coverage["uncovered_columns"]
    passed = not uncovered
    return {
        "pass": passed,
        "exit_code": 0 if passed else 1,
        "uncovered_columns": uncovered,
        "reason": (
            "all sensitive columns are covered by a masking policy"
            if passed else
            f"{len(uncovered)} sensitive column(s) have no masking policy: "
            + ", ".join(f"{u['table']}.{u['column']}" for u in uncovered)
        ),
    }
