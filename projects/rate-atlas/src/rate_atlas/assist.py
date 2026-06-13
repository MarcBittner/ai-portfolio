"""LLM-assisted column → canonical-schema mapping for UNKNOWN file shapes.

The three adapters in ``normalize.py`` are hand-written, one per *known* shape.
But real payer/hospital MRFs arrive in formats nobody has seen — a CSV whose
header is ``billing_cpt,insurer,allowed_amt,facility`` instead of the columns the
adapters expect. Writing a new adapter for every variant doesn't scale.

This is the demo's LLM surface. ``POST /normalize/assist`` takes a *sample* of an
unknown file (its header/keys + a few rows) and asks the model to map each source
column to a canonical field — ``code · code_type · payer · plan · rate · hospital
· description``. The model does the fuzzy reading (synonyms, abbreviations,
vendor-specific names); the **mapping is then applied deterministically** to
ingest the file. The model proposes the schema crosswalk, code performs the
ingest — the trust-critical normalization stays deterministic.

Routing is the portfolio-standard chain (``llm.py``): Anthropic/OpenAI → Ollama →
OpenRouter → a deterministic offline matcher. The offline matcher is a synonym
table over normalized header tokens, so assisted ingest works (and the eval
reproduces) with zero keys.
"""

from __future__ import annotations

import csv
import io
import json
import re

from rate_atlas import llm

# The canonical fields a source column may map to (``None`` = "no canonical field").
CANONICAL_FIELDS = ("code", "code_type", "payer", "plan", "rate", "hospital",
                    "description")

# Synonym table for the deterministic matcher — also the ground truth the LLM is
# asked to reproduce. Keys are normalized header tokens (lowercased, separators
# stripped); each maps to a canonical field. Longer/more-specific keys win.
_SYNONYMS: dict[str, str] = {
    # code
    "code": "code", "cpt": "code", "hcpcs": "code", "drg": "code",
    "billingcode": "code", "billingcpt": "code", "procedurecode": "code",
    "proccode": "code", "servicecode": "code", "cptcode": "code",
    # code_type
    "codetype": "code_type", "billingcodetype": "code_type", "type": "code_type",
    "codingsystem": "code_type", "codesystem": "code_type",
    # payer
    "payer": "payer", "payername": "payer", "insurer": "payer",
    "insurance": "payer", "carrier": "payer", "healthplan": "payer",
    "payor": "payer",
    # plan
    "plan": "plan", "planname": "plan", "product": "plan", "network": "plan",
    "plantype": "plan",
    # rate
    "rate": "rate", "negotiatedrate": "rate", "negotiateddollar": "rate",
    "allowed": "rate", "allowedamt": "rate", "allowedamount": "rate",
    "amt": "rate", "price": "rate", "amount": "rate", "negotiatedamount": "rate",
    "contractrate": "rate", "dollaramount": "rate", "cost": "rate",
    # hospital
    "hospital": "hospital", "hospitalname": "hospital", "facility": "hospital",
    "facilityname": "hospital", "provider": "hospital", "providername": "hospital",
    "site": "hospital",
    # description
    "description": "description", "desc": "description", "servicename": "description",
    "proceduredescription": "description", "procdesc": "description",
    "servicedescription": "description", "label": "description",
}

SYSTEM = (
    "You are a schema-mapping engine for hospital price-transparency files. The "
    "canonical schema has these fields: "
    f"{', '.join(CANONICAL_FIELDS)}. Given the source columns (header names) and a "
    "few sample rows of an unknown-format file, map EACH source column to exactly "
    "one canonical field, or to null if it has no canonical equivalent. Return "
    'STRICT JSON {"mapping": {<source_column>: <canonical_field_or_null>}}. Use '
    "only the canonical field names listed above. Output JSON only."
)


def _norm(token: str) -> str:
    """Normalize a header token for matching: lowercase, strip non-alphanumerics."""
    return re.sub(r"[^a-z0-9]", "", token.lower())


def _match_one(col: str) -> str | None:
    """Map a single source column to a canonical field via the synonym table.

    Tries an exact normalized hit, then a substring containment (longest synonym
    first so ``billing_code`` beats ``code``). Returns ``None`` when nothing fits.
    """
    n = _norm(col)
    if not n:
        return None
    if n in _SYNONYMS:
        return _SYNONYMS[n]
    for syn in sorted(_SYNONYMS, key=len, reverse=True):
        if syn in n:
            return _SYNONYMS[syn]
    return None


def offline_map(_system: str, user: str) -> str:
    """Deterministic header matcher — the last-resort fallback. Parses the source
    columns out of the user prompt and returns the same JSON shape the LLM is
    asked for, so downstream parsing is uniform."""
    cols = _columns_from_prompt(user)
    mapping = {c: _match_one(c) for c in cols}
    return json.dumps({"mapping": mapping})


_COLS_RE = re.compile(r"columns:\s*(.+)", re.IGNORECASE)


def _columns_from_prompt(user: str) -> list[str]:
    """Pull the column list back out of the prompt the offline fn receives."""
    m = _COLS_RE.search(user)
    if not m:
        return []
    return [c.strip() for c in m.group(1).split(",") if c.strip()]


def _build_prompt(columns: list[str], rows: list[dict]) -> str:
    sample = rows[:3]
    return (f"Source columns: {', '.join(columns)}\n"
            f"Sample rows (JSON): {json.dumps(sample)}\n"
            "Map each source column to a canonical field.")


def _parse_mapping(text: str, columns: list[str]) -> dict[str, str | None]:
    """Best-effort JSON parse → validated mapping (only known columns + fields)."""
    s = text.strip()
    if "```" in s:
        s = s.split("```")[1].removeprefix("json").strip()
    start, end = s.find("{"), s.rfind("}")
    try:
        obj = json.loads(s[start:end + 1]) if start >= 0 else {}
    except Exception:
        obj = {}
    raw = obj.get("mapping", obj) if isinstance(obj, dict) else {}
    out: dict[str, str | None] = {}
    for col in columns:
        val = raw.get(col) if isinstance(raw, dict) else None
        out[col] = val if val in CANONICAL_FIELDS else None
    return out


def _parse_sample(raw: str) -> tuple[list[str], list[dict], str]:
    """Parse an unknown-format sample into ``(columns, rows, detected_kind)``.

    Accepts a JSON array of objects, or delimited text (comma / pipe / tab). This
    is *structural* sniffing only — the column *meaning* is what the LLM/offline
    matcher resolves.
    """
    raw = raw.strip()
    try:
        obj = json.loads(raw)
        if isinstance(obj, list) and obj and isinstance(obj[0], dict):
            cols = list(obj[0].keys())
            return cols, [dict(r) for r in obj], "json_array"
    except json.JSONDecodeError:
        pass
    # delimited: pick the delimiter that yields the most header columns
    first = raw.splitlines()[0] if raw.splitlines() else ""
    delim = max(("|", ",", "\t"), key=lambda d: first.count(d))
    reader = csv.DictReader(io.StringIO(raw), delimiter=delim)
    rows = [dict(r) for r in reader]
    cols = list(reader.fieldnames or [])
    label = {"|": "pipe", ",": "csv", "\t": "tsv"}[delim]
    return cols, rows, f"delimited:{label}"


def propose_mapping(columns: list[str], rows: list[dict], *,
                    mode: str | None = None) -> dict:
    """Ask the routing chain to map source columns → canonical fields."""
    res = llm.complete(SYSTEM, _build_prompt(columns, rows), offline=offline_map,
                       mode=mode, json_mode=True, max_tokens=512)
    mapping = _parse_mapping(res.text, columns)
    return {
        "mapping": mapping, "provider": res.provider, "model": res.model,
        "mode": res.mode, "latency_ms": res.latency_ms, "cost_usd": res.cost_usd,
        "fallbacks": res.fallbacks,
    }


def apply_mapping(hospital: str, rows: list[dict],
                  mapping: dict[str, str | None]) -> list[dict]:
    """Apply a column→canonical mapping to source rows, deterministically, to
    produce canonical 7-field records. Rows missing a code or rate are skipped."""
    inv: dict[str, str] = {}
    for src, canon in mapping.items():
        if canon and canon not in inv:  # first source column wins per canonical field
            inv[canon] = src
    def get(row: dict, field: str) -> str | None:
        src = inv.get(field)
        return row.get(src) if src else None

    records: list[dict] = []
    for r in rows:
        def g(field: str, _row: dict = r) -> str | None:
            return get(_row, field)

        code, rate = g("code"), g("rate")
        if code in (None, "") or rate in (None, ""):
            continue
        try:
            rate_f = float(str(rate).replace("$", "").replace(",", ""))
        except (TypeError, ValueError):
            continue
        plan = g("plan")
        records.append({
            "hospital": str(g("hospital") or hospital),
            "code": str(code), "code_type": str(g("code_type") or "CPT"),
            "description": str(g("description") or ""),
            "payer": str(g("payer") or "Unknown"),
            "plan": (str(plan) if plan else None), "rate": rate_f,
        })
    return records


def assist(hospital: str, raw: str, *, mode: str | None = None) -> dict:
    """End-to-end assisted ingest of one unknown-format sample: parse → propose a
    mapping (LLM or offline) → apply it deterministically to canonical records."""
    columns, rows, kind = _parse_sample(raw)
    proposed = propose_mapping(columns, rows, mode=mode)
    records = apply_mapping(hospital, rows, proposed["mapping"])
    mapped = sum(1 for v in proposed["mapping"].values() if v)
    return {
        "hospital": hospital, "detected_kind": kind, "source_columns": columns,
        "mapping": proposed["mapping"], "records": records,
        "rows_in": len(rows), "rows_mapped": len(records),
        "columns_mapped": mapped, "columns_total": len(columns),
        "provider": proposed["provider"], "model": proposed["model"],
        "mode": proposed["mode"], "latency_ms": proposed["latency_ms"],
        "cost_usd": proposed["cost_usd"], "fallbacks": proposed["fallbacks"],
    }


# --------------------------------------------------------------------------- #
# Eval: precision/recall of column → canonical-field assignment               #
# --------------------------------------------------------------------------- #

def _labeled_set() -> list[dict]:
    """Synthetic unknown-format headers with gold canonical-field labels. Each is a
    header a real payer file might emit; ``gold`` is the correct mapping (``None``
    for columns with no canonical equivalent — e.g. an internal row id)."""
    return [
        {"name": "insurer_csv",
         "columns": ["billing_cpt", "insurer", "allowed_amt", "facility"],
         "gold": {"billing_cpt": "code", "insurer": "payer",
                  "allowed_amt": "rate", "facility": "hospital"}},
        {"name": "carrier_pipe",
         "columns": ["HCPCS", "Carrier", "Network", "NegotiatedRate", "ProcDesc"],
         "gold": {"HCPCS": "code", "Carrier": "payer", "Network": "plan",
                  "NegotiatedRate": "rate", "ProcDesc": "description"}},
        {"name": "vendor_json",
         "columns": ["service_code", "code_system", "health_plan", "price",
                     "provider_name", "row_id"],
         "gold": {"service_code": "code", "code_system": "code_type",
                  "health_plan": "payer", "price": "rate",
                  "provider_name": "hospital", "row_id": None}},
        {"name": "terse",
         "columns": ["cpt", "payor", "amt", "site"],
         "gold": {"cpt": "code", "payor": "payer", "amt": "rate",
                  "site": "hospital"}},
        {"name": "contract_export",
         "columns": ["procedure_code", "coding_system", "contract_rate",
                     "plan_type", "label", "effective_date"],
         "gold": {"procedure_code": "code", "coding_system": "code_type",
                  "contract_rate": "rate", "plan_type": "plan",
                  "label": "description", "effective_date": None}},
    ]


def evaluate(mode: str | None = None) -> dict:
    """Score the column-mapping over the labeled set: precision/recall on correct
    canonical-field assignment (a column whose gold is a real field counts toward
    recall; assigning the right field is a true positive)."""
    tp = fp = fn = 0
    providers: set[str] = set()
    per_field_miss: dict[str, int] = {}
    for case in _labeled_set():
        proposed = propose_mapping(case["columns"], [], mode=mode)
        providers.add(proposed["provider"])
        pred = proposed["mapping"]
        for col, gold in case["gold"].items():
            got = pred.get(col)
            if gold is None:
                if got is not None:
                    fp += 1  # mapped a column that should have stayed unmapped
                continue
            if got == gold:
                tp += 1
            else:
                fn += 1
                per_field_miss[gold] = per_field_miss.get(gold, 0) + 1
    precision = tp / (tp + fp) if tp + fp else 1.0
    recall = tp / (tp + fn) if tp + fn else 1.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    return {
        "headers": len(_labeled_set()), "true_positives": tp,
        "false_positives": fp, "false_negatives": fn,
        "precision": round(precision, 3), "recall": round(recall, 3),
        "f1": round(f1, 3), "missed_by_field": per_field_miss,
        "providers_used": sorted(providers),
    }
