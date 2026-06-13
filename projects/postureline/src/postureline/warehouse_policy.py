"""Masking + row-access policy-as-code: a declarative spec compiled to Snowflake
DDL and to Terraform, plus a coverage check that turns an uncovered sensitive
column into a CI failure. Warehouse-surface artifact (from maskline).

The spec is small and declarative on purpose — a reviewer reads *what* each class
gets, not procedural code:

- **Per column-class → a masking function.** ``direct`` is fully masked,
  ``quasi`` is generalized, ``clinical``/``financial`` are visible to analysts.
  The generated ``CREATE MASKING POLICY`` is column-data-type-aware and keyed off
  the caller's Snowflake role (``CURRENT_ROLE()``).
- **Per role → a row predicate.** A row-access policy scopes which rows a role
  sees.

``generate_snowflake_ddl()`` emits the real artifact; ``generate_terraform()``
emits the same intent as ``snowflake_*`` resources. ``coverage()`` reports which
discovered sensitive columns have **no** masking policy — the governance gap.
"""

from __future__ import annotations

from postureline import data

# Roles that may see unmasked sensitive data.
UNMASKED_ROLES = ("PHI_STEWARD", "COMPLIANCE_AUDITOR")

# Per column-class → (policy name, masked return expression).
CLASS_MASK: dict[str, dict] = {
    "direct": {
        "policy": "MASK_DIRECT_IDENTIFIER",
        "expr": "'***MASKED***'",
        "rationale": "direct identifier — fully masked outside privileged roles",
    },
    "quasi": {
        "policy": "MASK_QUASI_IDENTIFIER",
        "expr": "REGEXP_REPLACE(val, '[0-9]', '*')",
        "rationale": "quasi-identifier — generalized to reduce re-identification risk",
    },
    "clinical": {
        "policy": "MASK_CLINICAL",
        "expr": "val",
        "rationale": "clinical — visible to analysts; row-access scopes the cohort",
    },
    "financial": {
        "policy": "MASK_FINANCIAL",
        "expr": "val",
        "rationale": "financial — visible to analysts; row-access scopes the cohort",
    },
}

# Column-classes that REQUIRE a masking policy (an uncovered one fails the gate).
REQUIRES_MASK = ("direct", "quasi")

# Row-access policy: a role → the row predicate it is scoped to.
ROW_ACCESS = {
    "policy": "RAP_CLAIMS_BY_ROLE",
    "predicate": (
        "CASE\n"
        "    WHEN CURRENT_ROLE() IN ('PHI_STEWARD', 'COMPLIANCE_AUDITOR') THEN TRUE\n"
        "    WHEN CURRENT_ROLE() = 'CLAIMS_ANALYST' THEN OUTCOME IS NOT NULL\n"
        "    ELSE FALSE\n"
        "END"
    ),
    "applies_to": [("CLAIMS", "CLAIMS")],  # (table, has-OUTCOME column)
}


def _mask_arg_type(col_type: str) -> str:
    """Snowflake masking-policy argument type for a column type."""
    t = col_type.upper()
    if t.startswith("NUMBER") or t.startswith("NUMERIC"):
        return "NUMBER"
    if t == "DATE":
        return "DATE"
    return "VARCHAR"


def _masked_expr(cls: str, arg_type: str) -> str:
    """The masked-return expression, adapted to non-string argument types."""
    expr = CLASS_MASK[cls]["expr"]
    if expr == "val":
        return "val"
    if arg_type != "VARCHAR":
        # masking a NUMBER/DATE: redact to a NULL/sentinel rather than regex
        return "NULL"
    return expr


def required_policies(classified: list[dict]) -> dict[str, dict]:
    """The set of masking policies needed by the sensitive columns present.

    A free-text column whose PHI was discovered by the LLM (method == "llm") is NOT
    covered by the name-driven policy set — it surfaces as a coverage gap / gate
    failure until a steward adds a tokenization/masking policy for it.
    """
    policies: dict[str, dict] = {}
    for c in classified:
        cls = c["class"]
        if cls not in CLASS_MASK:
            continue
        if c.get("method") == "llm":
            continue
        arg = _mask_arg_type(c["type"])
        name = CLASS_MASK[cls]["policy"]
        if arg != "VARCHAR":
            name = f"{name}_{arg}"
        key = name
        policies.setdefault(key, {
            "name": name, "class": cls, "arg_type": arg,
            "expr": _masked_expr(cls, arg),
            "rationale": CLASS_MASK[cls]["rationale"], "columns": [],
        })
        policies[key]["columns"].append((c["table"], c["column"]))
    return policies


def generate_snowflake_ddl(classified: list[dict]) -> str:
    """Compile the policy spec to Snowflake DDL (the real governance artifact)."""
    policies = required_policies(classified)
    out: list[str] = [
        "-- postureline: generated Snowflake masking + row-access policy-as-code",
        f"-- target: {data.FQ}",
        "-- NOTE: generated for Snowflake; apply with the Snowflake connector.",
        "",
        "USE SCHEMA ANALYTICS.CLAIMS;",
        "",
        "-- ===== column-masking policies (per sensitivity class) =====",
    ]
    unmasked = ", ".join(f"'{r}'" for r in UNMASKED_ROLES)
    for p in policies.values():
        out += [
            "",
            f"-- {p['rationale']}",
            f"CREATE OR REPLACE MASKING POLICY {p['name']}",
            f"  AS (val {p['arg_type']}) RETURNS {p['arg_type']} ->",
            "  CASE",
            f"    WHEN CURRENT_ROLE() IN ({unmasked}) THEN val",
            f"    ELSE {p['expr']}",
            "  END;",
        ]
    out += ["", "-- ===== apply masking policies to columns ====="]
    for p in policies.values():
        for tbl, colname in p["columns"]:
            out.append(
                f"ALTER TABLE {data.FQ}.{tbl} "
                f"MODIFY COLUMN {colname} SET MASKING POLICY {p['name']};")
    rap = ROW_ACCESS
    out += [
        "",
        "-- ===== row-access policy (per-role row scoping) =====",
        f"CREATE OR REPLACE ROW ACCESS POLICY {rap['policy']}",
        "  AS (OUTCOME NUMBER) RETURNS BOOLEAN ->",
    ]
    out += ["  " + line for line in rap["predicate"].splitlines()]
    out[-1] = out[-1] + ";"
    for tbl, _ in rap["applies_to"]:
        out.append(
            f"ALTER TABLE {data.FQ}.{tbl} "
            f"ADD ROW ACCESS POLICY {rap['policy']} ON (OUTCOME);")
    out.append("")
    return "\n".join(out)


def generate_terraform(classified: list[dict]) -> str:
    """Compile the same policy spec to Terraform (snowflake provider) resources."""
    policies = required_policies(classified)
    out: list[str] = [
        "# postureline: generated Terraform (snowflake provider) for masking +",
        "# row-access policy-as-code. Plan/apply against a real Snowflake account.",
        "",
        "terraform {",
        "  required_providers {",
        "    snowflake = {",
        '      source  = "Snowflake-Labs/snowflake"',
        '      version = "~> 0.95"',
        "    }",
        "  }",
        "}",
        "",
        'locals {',
        '  database = "ANALYTICS"',
        '  schema   = "CLAIMS"',
        '  unmasked_roles = [' + ", ".join(f'"{r}"' for r in UNMASKED_ROLES) + ']',
        '}',
    ]
    unmasked = "join(', ', formatlist(\"'%s'\", local.unmasked_roles))"
    for p in policies.values():
        res = p["name"].lower()
        out += [
            "",
            f'resource "snowflake_masking_policy" "{res}" {{',
            f'  name     = "{p["name"]}"',
            "  database = local.database",
            "  schema   = local.schema",
            "  argument {",
            '    name = "VAL"',
            f'    type = "{p["arg_type"]}"',
            "  }",
            f'  return_data_type   = "{p["arg_type"]}"',
            "  body = <<-SQL",
            f"    CASE WHEN CURRENT_ROLE() IN (${{{unmasked}}}) THEN VAL",
            f"         ELSE {p['expr']} END",
            "  SQL",
            f'  comment = "{p["rationale"]}"',
            "}",
        ]
    rap = ROW_ACCESS
    out += [
        "",
        f'resource "snowflake_row_access_policy" "{rap["policy"].lower()}" {{',
        f'  name     = "{rap["policy"]}"',
        "  database = local.database",
        "  schema   = local.schema",
        "  argument {",
        '    name = "OUTCOME"',
        '    type = "NUMBER"',
        "  }",
        "  body = <<-SQL",
    ]
    out += ["    " + line for line in rap["predicate"].splitlines()]
    out += ["  SQL", "}", ""]
    return "\n".join(out)


def coverage(classified: list[dict]) -> dict:
    """Which discovered sensitive columns have NO masking policy — the gap.

    Clinical/financial are sensitive-but-intentionally-visible, so they are not
    gaps; only ``direct`` / ``quasi`` columns missing a policy fail the gate.
    """
    policies = required_policies(classified)
    covered_cols = {(t, c) for p in policies.values() for (t, c) in p["columns"]
                    if p["class"] in REQUIRES_MASK}
    sensitive = [c for c in classified if c["sensitive"]]
    must_mask = [c for c in sensitive if c["class"] in REQUIRES_MASK]
    gaps = [c for c in must_mask if (c["table"], c["column"]) not in covered_cols]
    return {
        "sensitive_columns": len(sensitive),
        "must_mask_columns": len(must_mask),
        "covered_columns": len(must_mask) - len(gaps),
        "uncovered_columns": [
            {"table": c["table"], "column": c["column"], "class": c["class"]}
            for c in gaps
        ],
        "fully_covered": not gaps,
    }
