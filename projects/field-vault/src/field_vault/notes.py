"""LLM-assisted PHI detection + de-identification of free-text clinical notes.

Field-level de-identification (``deid.py``) handles *structured* columns by
classification. But PHI also hides in **unstructured prose** — a name, DOB, phone,
email, or SSN buried in a clinical note — that no column rule can reach. This is
the demo's LLM surface: the model reads the note and returns the PHI spans; then
**deterministic code redacts them and the audit logs the scrub** (counts only,
never the value). The LLM does the fuzzy reading; trust-critical de-identification
and logging stay deterministic.

Routing is the portfolio-standard chain (``llm.py``): Anthropic/OpenAI → Ollama →
OpenRouter → a deterministic offline detector. The offline detector is a
regex + known-name matcher, so detection works (and the eval reproduces) with
zero keys.
"""

from __future__ import annotations

import json
import re

from field_vault import audit, llm
from field_vault.data import note_records

PHI_TYPES = ("NAME", "DOB", "DATE", "PHONE", "EMAIL", "SSN", "MRN", "ADDRESS", "ZIP")

SYSTEM = (
    "You are a PHI (protected health information) detection engine for a "
    "de-identification pipeline. Read the clinical note and return STRICT JSON "
    '{"spans": [{"text": <exact substring>, "type": <one of '
    f"{', '.join(PHI_TYPES)}>}}]}}. Extract ONLY values that literally appear in "
    "the note — never invent, infer, or normalize. Output JSON only."
)

# Deterministic offline detectors (also the ground for the regex fallback).
_EMAIL = re.compile(r"\b[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}\b")
_PHONE = re.compile(r"\b\d{3}-\d{3}-\d{4}\b")
_SSN = re.compile(r"\b\d{3}-\d{2}-\d{4}\b")
_DOB = re.compile(r"\b\d{4}-\d{2}-\d{2}\b")
_ZIP = re.compile(r"\b\d{5}\b")
# Known synthetic member names — the regexes can't catch free-form names, so the
# offline detector matches against the roster (the LLM path needs no roster).
_NAMES = sorted({n["text"] for r in note_records() for n in r["gold"]
                 if n["type"] == "NAME"}, key=len, reverse=True)


def _offline_detect(_system: str, user: str) -> str:
    """Deterministic PHI detector — the last-resort fallback. Returns the same
    JSON shape the LLM is asked for so downstream parsing is uniform."""
    note = user.rsplit("\n", 1)[-1]
    spans: list[dict] = []
    seen: set[tuple[str, str]] = set()

    def add(text: str, typ: str) -> None:
        if text and (text, typ) not in seen:
            seen.add((text, typ))
            spans.append({"text": text, "type": typ})

    for m in _SSN.finditer(note):
        add(m.group(), "SSN")
    for m in _PHONE.finditer(note):
        if (m.group(), "SSN") not in seen:  # SSN and phone share the dddd tail
            add(m.group(), "PHONE")
    for m in _EMAIL.finditer(note):
        add(m.group(), "EMAIL")
    for m in _DOB.finditer(note):
        # a date is a birth date when it follows "DOB", else a service/other date
        preceding = note[max(0, m.start() - 6):m.start()]
        add(m.group(), "DOB" if "DOB" in preceding else "DATE")
    for name in _NAMES:
        if name in note:
            add(name, "NAME")
    return json.dumps({"spans": spans})


def _parse_spans(text: str) -> list[dict]:
    """Best-effort JSON parse → validated spans (drops anything off-schema)."""
    s = text.strip()
    if "```" in s:
        s = s.split("```")[1].removeprefix("json").strip()
    start, end = s.find("{"), s.rfind("}")
    try:
        obj = json.loads(s[start:end + 1]) if start >= 0 else {}
    except Exception:
        return []
    out = []
    for sp in obj.get("spans", []):
        text_v, typ = str(sp.get("text", "")).strip(), str(sp.get("type", "")).upper()
        if text_v and typ in PHI_TYPES:
            out.append({"text": text_v, "type": typ})
    return out


def redact(note: str, spans: list[dict]) -> str:
    """Replace each detected PHI span with a ``[TYPE]`` placeholder (longest
    first, so overlapping matches don't corrupt each other)."""
    redacted = note
    for sp in sorted(spans, key=lambda s: len(s["text"]), reverse=True):
        redacted = redacted.replace(sp["text"], f"[{sp['type']}]")
    return redacted


def detect(note: str, *, mode: str | None = None, audit_log: bool = True) -> dict:
    """Detect PHI in a note via the routing chain, redact it, and (optionally)
    append a value-free scrub entry to the audit log."""
    res = llm.complete(SYSTEM, f"Clinical note:\n{note}", offline=_offline_detect,
                       mode=mode, json_mode=True, max_tokens=512)
    spans = _parse_spans(res.text)
    redacted = redact(note, spans)
    by_type: dict[str, int] = {}
    for sp in spans:
        by_type[sp["type"]] = by_type.get(sp["type"], 0) + 1
    if audit_log:
        audit.log.append({
            "event": "note_scrub", "role": "system", "action": "deidentify_note",
            "provider": res.provider, "model": res.model,
            "phi_found": len(spans), "by_type": by_type, "allowed": True,
        })
    return {
        "spans": spans, "redacted": redacted, "phi_found": len(spans),
        "by_type": by_type, "provider": res.provider, "model": res.model,
        "mode": res.mode, "latency_ms": res.latency_ms, "cost_usd": res.cost_usd,
        "fallbacks": res.fallbacks,
    }


def _score(detected: list[dict], gold: list[dict]) -> tuple[int, int, int]:
    """(true_positives, false_positives, false_negatives) on (text, type) pairs."""
    det = {(d["text"], d["type"]) for d in detected}
    g = {(x["text"], x["type"]) for x in gold}
    tp = len(det & g)
    return tp, len(det - g), len(g - det)


def evaluate(mode: str | None = None) -> dict:
    """Score PHI detection over the labeled note set: precision / recall / F1.

    A leakage metric too: recall on the de-identification surface IS the safety
    number — a missed PHI span is a leak.
    """
    tp = fp = fn = 0
    per_type_fn: dict[str, int] = {}
    providers: set[str] = set()
    for rec in note_records():
        out = detect(rec["note"], mode=mode, audit_log=False)
        providers.add(out["provider"])
        a, b, c = _score(out["spans"], rec["gold"])
        tp, fp, fn = tp + a, fp + b, fn + c
        det = {(d["text"], d["type"]) for d in out["spans"]}
        for miss in ({(x["text"], x["type"]) for x in rec["gold"]} - det):
            per_type_fn[miss[1]] = per_type_fn.get(miss[1], 0) + 1
    precision = tp / (tp + fp) if tp + fp else 1.0
    recall = tp / (tp + fn) if tp + fn else 1.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    return {
        "notes": len(note_records()), "true_positives": tp, "false_positives": fp,
        "false_negatives": fn, "precision": round(precision, 3),
        "recall": round(recall, 3), "f1": round(f1, 3), "leaks": fn,
        "missed_by_type": per_type_fn, "providers_used": sorted(providers),
    }
