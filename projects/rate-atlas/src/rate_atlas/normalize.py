"""Detect a price-file's shape and map it to one canonical record model.

Canonical record: ``{hospital, code, code_type, description, payer, plan, rate}``.
The hard part of price transparency isn't the query — it's that every file is
shaped differently. Three adapters here (CMS-style nested JSON, flat JSON array,
pipe-CSV); detection is by structure, so a new hospital file slots in by adding an
adapter, not by changing everything downstream.
"""

import csv
import io
import json

_CANON = ("hospital", "code", "code_type", "description", "payer", "plan", "rate")


def _rec(hospital, code, code_type, desc, payer, plan, rate) -> dict:
    return dict(zip(_CANON, (str(hospital), str(code), str(code_type), str(desc),
                             str(payer), (str(plan) if plan else None), float(rate)),
                    strict=True))


def _pretty(name: str) -> str:
    return " ".join(w.capitalize() for w in name.split("-"))


def _from_cms(obj: dict) -> list[dict]:
    hospital = obj.get("hospital_name", "Unknown")
    out = []
    for code in obj.get("standard_charge_information", []):
        for ch in code.get("standard_charges", []):
            out.append(_rec(hospital, code["billing_code"], code["billing_code_type"],
                            code["description"], ch["payer_name"],
                            ch.get("plan_name"), ch["negotiated_dollar"]))
    return out


def _from_flat(name: str, arr: list) -> list[dict]:
    hospital = _pretty(name)
    return [_rec(hospital, r["code"], r["type"], r["desc"], r["payer"],
                 r.get("plan"), r["rate"]) for r in arr]


def _from_csv(name: str, raw: str) -> list[dict]:
    hospital = _pretty(name)
    reader = csv.DictReader(io.StringIO(raw), delimiter="|")
    return [_rec(hospital, r["code"], r["code_type"], r["description"], r["payer"],
                 r.get("plan"), r["negotiated_rate"]) for r in reader]


def normalize_source(name: str, raw: str) -> tuple[list[dict], str]:
    """Return ``(records, detected_shape)``."""
    raw = raw.strip()
    try:
        obj = json.loads(raw)
    except json.JSONDecodeError:
        return _from_csv(name, raw), "pipe_csv"
    if isinstance(obj, dict) and "standard_charge_information" in obj:
        return _from_cms(obj), "cms_nested_json"
    if isinstance(obj, list):
        return _from_flat(name, obj), "flat_json"
    raise ValueError(f"unrecognized price-file shape for {name!r}")
