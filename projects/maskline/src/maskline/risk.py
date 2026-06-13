"""Re-identification risk: k-anonymity over the quasi-identifier columns,
computed with SQL on the warehouse.

Masking direct identifiers is necessary but not sufficient: an attacker who never
sees a name can still single out an individual by **linking quasi-identifiers**
(birth date, ZIP, gender) against an external dataset. k-anonymity measures that
exposure — the size of the smallest group sharing the same quasi-identifier tuple.
``k = 1`` means a row is unique on its quasi-identifiers and re-identifiable by
linkage even with every direct identifier masked.

The computation is a ``GROUP BY`` over the quasi columns (Snowflake-compatible SQL
on the DuckDB warehouse). The generalization sweep shows the lever: coarsening the
quasi-identifiers (ZIP→3-digit, DOB→birth year) raises k, trading analytic
resolution for privacy.
"""

from __future__ import annotations

from maskline import warehouse

# Quasi-identifiers live on MEMBERS. (table, [columns]).
QUASI_TABLE = "MEMBERS"
DEFAULT_QUASI = ("DOB", "ZIP", "GENDER")


def _k_over(select_exprs: list[str]) -> dict:
    """Run the equivalence-class GROUP BY and summarize k."""
    cols = ", ".join(select_exprs)
    sql = (
        f"WITH classes AS ("
        f"  SELECT {cols}, COUNT(*) AS k "
        f"  FROM {warehouse.FQ}.{QUASI_TABLE} GROUP BY {cols}) "
        f"SELECT MIN(k), COUNT(*), SUM(CASE WHEN k = 1 THEN 1 ELSE 0 END), "
        f"       (SELECT COUNT(*) FROM {warehouse.FQ}.{QUASI_TABLE}) "
        f"FROM classes"
    )
    k_min, classes, singletons, total = warehouse.query(sql)[0]
    return {
        "k_min": int(k_min) if k_min is not None else 0,
        "equivalence_classes": int(classes),
        "singleton_count": int(singletons or 0),
        "records": int(total),
    }


def k_anonymity(quasi: tuple[str, ...] = DEFAULT_QUASI) -> dict:
    """k-anonymity over the raw quasi-identifier tuple."""
    res = _k_over([f'"{q}"' for q in quasi])
    res["quasi_identifiers"] = list(quasi)
    res["reidentifiable_by_linkage"] = res["singleton_count"] > 0
    return res


def generalization_sweep() -> list[dict]:
    """Show the lever: coarser quasi-identifiers raise k.

    Each row is a generalization strategy expressed as SQL and the k it yields —
    the privacy/utility trade-off, computed on the warehouse.
    """
    configs = [
        ("DOB + ZIP5 + gender", ['"DOB"', '"ZIP"', '"GENDER"']),
        ("DOB + ZIP3 + gender",
         ['"DOB"', "SUBSTR(\"ZIP\", 1, 3)", '"GENDER"']),
        ("birth-year + ZIP3",
         ["YEAR(\"DOB\")", "SUBSTR(\"ZIP\", 1, 3)"]),
        ("birth-decade + gender",
         ["(YEAR(\"DOB\") / 10)::INT", '"GENDER"']),
        ("gender only", ['"GENDER"']),
    ]
    out = []
    for label, exprs in configs:
        res = _k_over(exprs)
        out.append({
            "generalization": label, "k_min": res["k_min"],
            "singletons": res["singleton_count"],
            "equivalence_classes": res["equivalence_classes"],
        })
    return out
