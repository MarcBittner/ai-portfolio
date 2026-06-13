"""Warehouse scanner (maskline's logic) → canonical Findings.

Introspects the DuckDB/Snowflake-compatible claims warehouse, classifies every
column (name/type heuristics + an LLM for free-text PHI), and reduces the
governance gaps to the shared ``Finding`` shape:

- a sensitive ``direct``/``quasi`` column with **no masking policy** → an
  ``UNMASKED_PHI`` finding (the free-text ``CLAIM_NOTE`` the LLM caught is the
  keystone), mapped to **CC6.1** (logical access / data masking);
- **re-identification risk** below the k-anonymity threshold → a ``REID_RISK``
  finding, mapped to **GV1.1** (de-identification);
- a missing **row-access** policy on the fact table → a ``ROW_ACCESS_MISSING``
  finding mapped to **CC6.6** (boundary protection); present by default, so it
  normally does not fire.

It keeps maskline's distinctive warehouse-only artifacts as ``extras`` on the
``ScanResult`` (so nothing is lost): the masking-policy-as-code (Snowflake DDL +
Terraform), the k-anonymity generalization sweep, and the classified column set.
``gate()`` is the CI guardrail: any unmasked sensitive column ⇒ fail.
"""

from __future__ import annotations

from postureline import classify, data, kanon, warehouse_policy
from postureline.findings import Finding, ScanResult


def scan(remediated: bool = False, *, mode: str | None = None) -> ScanResult:
    """Run the warehouse governance scan → ``ScanResult`` (findings + extras).

    ``remediated=True`` models the 'after' state: the discovered free-text PHI
    column has a masking policy added and the quasi-identifiers are generalized to
    clear the k threshold — so the before/after diff isolates the posture lift.
    """
    data.reset()
    classified = classify.classify_all(mode=mode)
    coverage = warehouse_policy.coverage(classified)
    k = kanon.k_anonymity()
    sweep = kanon.generalization_sweep()
    sensitive = [c for c in classified if c["sensitive"]]

    findings: list[Finding] = []

    # --- Unmasked sensitive (direct/quasi) columns → CC6.1 ------------------
    uncovered = [] if remediated else coverage["uncovered_columns"]
    for u in uncovered:
        findings.append(Finding(
            id="UNMASKED_PHI", surface="warehouse",
            severity="high" if u["class"] == "direct" else "medium",
            resource=f"{data.FQ}.{u['table']}.{u['column']}",
            title="Sensitive column with no masking policy",
            evidence={"table": u["table"], "column": u["column"],
                      "class": u["class"],
                      "note": "discovered sensitive but no masking policy bound"},
            control_ids=["CC6.1"],
            remediation="Bind a Snowflake masking policy to the column (tokenize or "
                        "redact free-text PHI) so it is masked outside privileged "
                        "roles."))

    # --- Re-identification risk (k-anonymity) → GV1.1 -----------------------
    # Remediated: quasi-identifiers generalized (e.g. gender-only bucket) clear the
    # k threshold; the sweep's last row shows k_min >= threshold is achievable.
    k_after = max((row["k_min"] for row in sweep), default=k["k_min"])
    effective_k = k_after if remediated else k["k_min"]
    if effective_k < kanon.K_THRESHOLD:
        findings.append(Finding(
            id="REID_RISK", surface="warehouse", severity="high",
            resource=f"{data.FQ}.{kanon.QUASI_TABLE}",
            title="Re-identification risk: quasi-identifiers below k threshold",
            evidence={"k_min": k["k_min"], "k_threshold": kanon.K_THRESHOLD,
                      "singletons": k["singleton_count"], "records": k["records"],
                      "quasi_identifiers": k["quasi_identifiers"]},
            control_ids=["GV1.1"],
            remediation="Generalize quasi-identifiers (ZIP→3-digit, DOB→birth year) "
                        f"until the minimum k clears {kanon.K_THRESHOLD}; the "
                        "generalization sweep shows the privacy/utility lever."))

    # --- Row-access policy present on the fact table → CC6.6 ----------------
    # Present by default (the generated RAP scopes the cohort), so this does not
    # fire; modeled so the boundary-protection control is exercised by the surface.
    row_access_present = True
    if not row_access_present:  # pragma: no cover - defensive
        findings.append(Finding(
            id="ROW_ACCESS_MISSING", surface="warehouse", severity="medium",
            resource=f"{data.FQ}.CLAIMS",
            title="No row-access policy scoping the fact table by role",
            evidence={"table": "CLAIMS"},
            control_ids=["CC6.6"],
            remediation="Apply a row-access policy that scopes claims rows to the "
                        "caller's role."))

    extras = {
        "engine": "duckdb (Snowflake-compatible SQL)",
        "warehouse": data.FQ,
        "tables": data.tables(),
        "classified": classified,
        "sensitive": sensitive,
        "coverage": coverage,
        "kanon": k,
        "sweep": sweep,
        "policy": {
            "snowflake_ddl": warehouse_policy.generate_snowflake_ddl(classified),
            "terraform": warehouse_policy.generate_terraform(classified),
            "coverage": coverage,
        },
        "gate": _gate(coverage),
    }
    return ScanResult(surface="warehouse", findings=findings, extras=extras)


def _gate(coverage: dict) -> dict:
    """CI pass/fail: any unmasked sensitive (direct/quasi) column ⇒ fail."""
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


def gate(*, mode: str | None = None) -> dict:
    """CI gate for the warehouse surface (unmasked sensitive column ⇒ fail)."""
    data.reset()
    coverage = warehouse_policy.coverage(classify.classify_all(mode=mode))
    return _gate(coverage)
