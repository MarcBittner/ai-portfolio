"""Classify every warehouse column into a sensitivity class that drives policy.

Warehouse-surface helper (from maskline). Two paths, one shape:

- **Structured columns** are classified by **name + type heuristics** — a
  ``MEMBER_NAME``/``SSN``/``EMAIL`` column is a direct identifier, ``DOB``/``ZIP``
  a quasi-identifier, a ``DX_CODE`` clinical, an ``ALLOWED_AMOUNT`` financial.
- **Free-text columns** (a ``CLAIM_NOTE``) are where PHI hides in prose that no
  column rule sees. We sample a few values and ask the **LLM** (via the portfolio
  routing chain, JSON mode) which PHI types are embedded. The deterministic
  ``offline`` fallback is regex + name heuristics over the same samples and returns
  the **same JSON shape**, so classification works (and the eval reproduces) with
  zero keys.

Classes: ``direct`` · ``quasi`` · ``clinical`` · ``financial`` · ``non_sensitive``.
A column is "sensitive" iff its class is not ``non_sensitive``.
"""

from __future__ import annotations

import json
import re

from postureline import data, llm

CLASSES = ("direct", "quasi", "clinical", "financial", "non_sensitive")
PHI_TYPES = ("NAME", "DOB", "DATE", "PHONE", "EMAIL", "SSN", "MRN", "ADDRESS", "ZIP")

# Name-substring heuristics for structured columns (checked in order).
_DIRECT = ("NAME", "SSN", "EMAIL", "PHONE", "MEMBER_ID", "NPI", "MRN", "ADDRESS")
_QUASI = ("DOB", "BIRTH", "ZIP", "GENDER", "SERVICE_DATE", "AGE")
_CLINICAL = ("DX_CODE", "PROCEDURE", "DIAGNOSIS", "OUTCOME", "SPECIALTY", "CPT")
_FINANCIAL = ("AMOUNT", "PAID", "ALLOWED", "COST", "CHARGE", "PRICE")
# Free-text columns to read with the LLM rather than the name rule.
_FREETEXT = ("NOTE", "TEXT", "COMMENT", "DESCRIPTION", "REASON")

# Deterministic offline detectors for embedded PHI in free text.
_EMAIL = re.compile(r"\b[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}\b")
_PHONE = re.compile(r"\b\d{3}-\d{3}-\d{4}\b")
_SSN = re.compile(r"\b\d{3}-\d{2}-\d{4}\b")
_DOB = re.compile(r"\bDOB\b[^\d]{0,6}\d{4}-\d{2}-\d{2}\b", re.IGNORECASE)
_NAME = re.compile(r"\b[A-Z][a-z]+ [A-Z][a-z]+\b")  # two capitalized words

SYSTEM = (
    "You are a PHI (protected health information) classifier for a data-warehouse "
    "governance tool. You are given sample values from one free-text column. "
    "Return STRICT JSON {\"phi_types\": [<subset of "
    f"{', '.join(PHI_TYPES)}>], \"contains_phi\": <bool>}}. List a type only if a "
    "value of that type LITERALLY appears in the samples. Output JSON only."
)


def _free_text_offline(_system: str, user: str) -> str:
    """Deterministic embedded-PHI detector over sampled free-text values."""
    blob = user
    found: set[str] = set()
    if _SSN.search(blob):
        found.add("SSN")
    if _PHONE.search(blob):
        found.add("PHONE")
    if _EMAIL.search(blob):
        found.add("EMAIL")
    if _DOB.search(blob):
        found.add("DOB")
    if _NAME.search(blob):
        found.add("NAME")
    return json.dumps({"phi_types": sorted(found), "contains_phi": bool(found)})


def _parse_phi(text: str) -> list[str]:
    s = text.strip()
    if "```" in s:
        s = s.split("```")[1].removeprefix("json").strip()
    start, end = s.find("{"), s.rfind("}")
    try:
        obj = json.loads(s[start:end + 1]) if start >= 0 else {}
    except Exception:
        return []
    return [t for t in (str(x).upper() for x in obj.get("phi_types", []))
            if t in PHI_TYPES]


def _structured_class(name: str) -> str | None:
    """Name-heuristic class for a structured column, or None if it's free text."""
    up = name.upper()
    if any(k in up for k in _FREETEXT):
        return None
    if any(k in up for k in _DIRECT):
        return "direct"
    if any(k in up for k in _QUASI):
        return "quasi"
    if any(k in up for k in _FINANCIAL):
        return "financial"
    if any(k in up for k in _CLINICAL):
        return "clinical"
    return "non_sensitive"


def _phi_to_class(phi_types: list[str]) -> str:
    """Reduce detected free-text PHI types to a single column class."""
    if any(t in ("NAME", "EMAIL", "PHONE", "SSN", "MRN", "ADDRESS") for t in phi_types):
        return "direct"
    if any(t in ("DOB", "DATE", "ZIP") for t in phi_types):
        return "quasi"
    return "non_sensitive"


def classify_column(table: str, col: dict, *, mode: str | None = None) -> dict:
    """Classify one column → ``{table, column, type, class, method, phi_types}``."""
    name = col["name"]
    cls = _structured_class(name)
    phi_types: list[str] = []
    method = "heuristic"
    provider = "rule"
    if cls is None:  # free text → ask the model
        samples = col.get("samples") or data.sample_values(table, name)
        user = "Column: {}\nSamples:\n{}".format(name, "\n".join(samples))
        res = llm.complete(SYSTEM, user, offline=_free_text_offline,
                           mode=mode, json_mode=True, max_tokens=256)
        phi_types = _parse_phi(res.text)
        cls = _phi_to_class(phi_types) if phi_types else "non_sensitive"
        method = "llm"
        provider = res.provider
    return {
        "table": table, "column": name, "type": col["type"],
        "class": cls, "sensitive": cls != "non_sensitive",
        "method": method, "provider": provider, "phi_types": phi_types,
    }


def classify_all(*, mode: str | None = None) -> list[dict]:
    """Classify every column in the warehouse."""
    out = []
    for tbl in data.schema():
        for col in tbl["columns"]:
            out.append(classify_column(tbl["table"], col, mode=mode))
    return out


def sensitive_columns(classified: list[dict] | None = None,
                      *, mode: str | None = None) -> list[dict]:
    """Just the columns that carry sensitive data (class != non_sensitive)."""
    rows = classified if classified is not None else classify_all(mode=mode)
    return [c for c in rows if c["sensitive"]]
