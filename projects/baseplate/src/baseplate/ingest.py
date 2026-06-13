"""The example workload riding on the paved road: a small price-transparency
ingest service.

It loads a synthetic machine-readable rate file (fictional hospitals/payers),
validates each row against the canonical rate schema, and reports a
**data-quality score** — the fraction of rows that pass validation. That score
is wired up as a first-class **SLI** in ``docs/observability.md``: a service can
be "up" (200s, low latency) while silently serving bad data, so data-quality
pass rate is the SLI that catches it.

This is deliberately lightweight. The platform tooling (IaC, golden CI, GitOps,
the scaffolder) is the focus; this is the demo workload that proves the paved
road carries a real, domain-relevant service. All data is synthetic and clearly
fictional; no real data; this makes no HIPAA claim.
"""

from __future__ import annotations

# Canonical rate-file schema the platform's ingest contract expects.
REQUIRED_FIELDS = ("code", "code_type", "payer", "rate", "hospital")
VALID_CODE_TYPES = {"CPT", "HCPCS", "DRG", "NDC"}

# Bundled synthetic machine-readable rate file. Rows 6-8 carry deliberate defects
# (missing payer, non-numeric rate, negative rate, unknown code type) so the
# data-quality SLI has something to catch.
SAMPLE_ROWS: list[dict] = [
    {"code": "99213", "code_type": "CPT", "payer": "Sample Health", "rate": 128.5,
     "hospital": "General Hospital A"},
    {"code": "99214", "code_type": "CPT", "payer": "Acme PPO", "rate": 192.0,
     "hospital": "General Hospital A"},
    {"code": "470", "code_type": "DRG", "payer": "Sample Health", "rate": 14250.0,
     "hospital": "Coastal Medical B"},
    {"code": "J1885", "code_type": "HCPCS", "payer": "Acme PPO", "rate": 6.75,
     "hospital": "Coastal Medical B"},
    {"code": "00071-0155", "code_type": "NDC", "payer": "Northstar HMO",
     "rate": 41.2, "hospital": "Valley Clinic C"},
    {"code": "99215", "code_type": "CPT", "payer": "", "rate": 240.0,
     "hospital": "Valley Clinic C"},                       # defect: missing payer
    {"code": "80053", "code_type": "CPT", "payer": "Sample Health",
     "rate": "n/a", "hospital": "General Hospital A"},      # defect: non-numeric
    {"code": "93000", "code_type": "XYZ", "payer": "Acme PPO", "rate": -10.0,
     "hospital": "Coastal Medical B"},                      # defect: bad type + neg
]


def validate_row(row: dict) -> list[str]:
    """Return a list of validation failures for one row ([] means it passed)."""
    issues: list[str] = []
    for f in REQUIRED_FIELDS:
        val = row.get(f)
        if val is None or (isinstance(val, str) and not val.strip()):
            issues.append(f"missing:{f}")
    ct = row.get("code_type")
    if ct and ct not in VALID_CODE_TYPES:
        issues.append(f"bad_code_type:{ct}")
    rate = row.get("rate")
    if rate is not None:
        try:
            if float(rate) <= 0:
                issues.append("non_positive_rate")
        except (TypeError, ValueError):
            issues.append("non_numeric_rate")
    return issues


def score(rows: list[dict] | None = None) -> dict:
    """Validate a rate file and compute the data-quality SLI.

    Returns total/valid/invalid counts, the pass-rate (the SLI value), a defect
    histogram, and a small sample of offending rows. Deterministic.
    """
    rows = SAMPLE_ROWS if rows is None else rows
    total = len(rows)
    defects: dict[str, int] = {}
    bad_rows: list[dict] = []
    valid = 0
    for i, row in enumerate(rows):
        issues = validate_row(row)
        if issues:
            for code in issues:
                key = code.split(":")[0]
                defects[key] = defects.get(key, 0) + 1
            if len(bad_rows) < 5:
                bad_rows.append({"row": i, "issues": issues})
        else:
            valid += 1
    invalid = total - valid
    pass_rate = round(valid / total, 4) if total else 0.0
    return {
        "rows": total,
        "valid": valid,
        "invalid": invalid,
        "data_quality_pass_rate": pass_rate,   # the SLI
        "defects": dict(sorted(defects.items())),
        "sample_failures": bad_rows,
    }
