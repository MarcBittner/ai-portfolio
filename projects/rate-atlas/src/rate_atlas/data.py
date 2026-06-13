"""Synthetic hospital price-transparency files in THREE different shapes.

Real CMS machine-readable files (MRFs) are notoriously inconsistent — every
hospital emits a different structure. These three mimic that: a CMS-style nested
JSON, a flat JSON array, and a pipe-delimited CSV. They're generated from one base
table so the data is consistent; the normalizer's job is to detect each shape and
map it to the canonical model. All hospitals, payers, codes, and rates are
fictional. Gamma's CT-head rate is a deliberate outlier.
"""

import csv
import io
import json

# Base table, pipe-delimited to keep lines short (Gamma's CT head is a deliberate
# outlier). Columns: hospital|code|code_type|description|payer|plan|rate
_RAW_BASE = """\
Alpha Medical Center|99213|CPT|Office visit, established, level 3|BlueShield|PPO|142.00
Alpha Medical Center|99213|CPT|Office visit, established, level 3|Aetna|HMO|128.50
Alpha Medical Center|99213|CPT|Office visit, established, level 3|Cigna|PPO|151.00
Alpha Medical Center|70450|CPT|CT head/brain without contrast|BlueShield|PPO|520.00
Alpha Medical Center|70450|CPT|CT head/brain without contrast|Aetna|HMO|488.00
Alpha Medical Center|80053|CPT|Comprehensive metabolic panel|Cigna|PPO|38.00
Alpha Medical Center|99214|CPT|Office visit, established, level 4|BlueShield|PPO|198.00
Beta Health System|99213|CPT|Established patient office visit|BlueShield|PPO|150.00
Beta Health System|99213|CPT|Established patient office visit|UnitedHealth|POS|133.25
Beta Health System|70450|CPT|CT scan head without contrast|BlueShield|PPO|605.00
Beta Health System|70450|CPT|CT scan head without contrast|Cigna|HMO|571.50
Beta Health System|80053|CPT|Metabolic panel, comprehensive|UnitedHealth|POS|44.00
Beta Health System|99285|CPT|Emergency dept visit, level 5|BlueShield|PPO|1320.00
Gamma Community Clinic|99213|CPT|Outpatient office visit L3|Aetna|HMO|119.00
Gamma Community Clinic|99213|CPT|Outpatient office visit L3|Medicare|FFS|92.40
Gamma Community Clinic|70450|CPT|Head CT, no contrast|Aetna|HMO|1950.00
Gamma Community Clinic|70450|CPT|Head CT, no contrast|UnitedHealth|PPO|1875.00
Gamma Community Clinic|80053|CPT|CMP labs|Medicare|FFS|22.75
"""

_COLS = ["hospital", "code", "code_type", "description", "payer", "plan", "rate"]
_BASE = [(*p[:6], float(p[6]))
         for p in (ln.split("|") for ln in _RAW_BASE.strip().splitlines())]


def _rows_for(hospital: str) -> list[dict]:
    return [dict(zip(_COLS, r, strict=True)) for r in _BASE if r[0] == hospital]


def _alpha_nested() -> str:
    """CMS-style nested JSON: code → standard_charges[] by payer."""
    rows = _rows_for("Alpha Medical Center")
    codes: dict[str, dict] = {}
    for r in rows:
        c = codes.setdefault(r["code"], {
            "billing_code": r["code"], "billing_code_type": r["code_type"],
            "description": r["description"], "standard_charges": []})
        c["standard_charges"].append({"payer_name": r["payer"], "plan_name": r["plan"],
                                      "negotiated_dollar": r["rate"]})
    return json.dumps({"hospital_name": "Alpha Medical Center",
                       "last_updated_on": "2026-01-01",
                       "standard_charge_information": list(codes.values())}, indent=2)


def _beta_flat() -> str:
    """Flat JSON array of {code, type, desc, payer, rate}."""
    rows = _rows_for("Beta Health System")
    return json.dumps([
        {"code": r["code"], "type": r["code_type"], "desc": r["description"],
         "payer": r["payer"], "plan": r["plan"], "rate": r["rate"]} for r in rows
    ], indent=2)


def _gamma_csv() -> str:
    """Pipe-delimited CSV."""
    buf = io.StringIO()
    w = csv.writer(buf, delimiter="|")
    w.writerow(["code", "code_type", "description", "payer", "plan", "negotiated_rate"])
    for r in _rows_for("Gamma Community Clinic"):
        w.writerow([r["code"], r["code_type"], r["description"], r["payer"],
                    r["plan"], r["rate"]])
    return buf.getvalue()


SOURCES: dict[str, str] = {
    "alpha-medical-center": _alpha_nested(),
    "beta-health-system": _beta_flat(),
    "gamma-community-clinic": _gamma_csv(),
}


def _delta_unknown() -> str:
    """A FOURTH file in an UNKNOWN format — vendor-specific column names that none
    of the three hand-written adapters recognize. Used by the assisted-mapping
    demo: the LLM (or offline matcher) maps these columns to the canonical schema
    so the file ingests anyway. Prices are deliberately mid-market."""
    buf = io.StringIO()
    w = csv.writer(buf)  # comma-delimited, unlike the pipe-CSV adapter
    w.writerow(["billing_cpt", "insurer", "network", "allowed_amt",
                "facility", "proc_desc"])
    for code, desc, payer, plan, rate in [
        ("99213", "Office visit, established, level 3", "Humana", "PPO", 137.00),
        ("70450", "CT head without contrast", "Humana", "PPO", 559.00),
        ("80053", "Comprehensive metabolic panel", "Humana", "PPO", 35.50),
        ("99214", "Office visit, established, level 4", "Kaiser", "HMO", 191.00),
    ]:
        w.writerow([code, payer, plan, rate, "Delta Regional Hospital", desc])
    return buf.getvalue()


# Sample of an unknown-format file, surfaced by the assisted-mapping demo/UI.
# NOT in SOURCES (the three adapters can't parse it) — it ingests via the
# LLM-proposed column mapping instead.
UNKNOWN_SAMPLE: str = _delta_unknown()
UNKNOWN_HOSPITAL: str = "Delta Regional Hospital"
