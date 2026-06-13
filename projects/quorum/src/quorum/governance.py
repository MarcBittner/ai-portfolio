"""Governance is a property of the *orchestrator*, not of any one workflow.

Three concerns live here and apply to every agent call the engine makes, no
matter which :class:`~quorum.workflows.WorkflowSpec` is running:

* **PII redaction** (``redact``) — deterministic regex masking of email / phone /
  SSN / account numbers. The orchestrator redacts agent input *before* it reaches
  a model **and** redacts anything *before* it is written to the audit, so neither
  a third-party provider nor the trail ever sees raw PII.
* **Tamper-evident audit** (:class:`AuditLog`) — an append-only, hash-chained log
  of every agent step. Each entry hashes the previous entry plus its own content,
  so any later edit breaks the chain and :meth:`AuditLog.verify` reports the first
  broken ``seq``. Entries are **value-light**: a redacted prompt/output summary and
  telemetry, never the raw document text.
* **Observability rollup** (``rollup``) — per-run provider / model / latency / cost
  totals from the recorded step telemetry, so cost and latency are a reported
  number, not a guess.

All three are deterministic; the agents do the fuzzy work, governance does the
trust-critical, reproducible work.
"""

from __future__ import annotations

import hashlib
import json
import re
import time
from dataclasses import dataclass, field

# --------------------------------------------------------------------------- #
# PII redaction                                                                #
# --------------------------------------------------------------------------- #

# Order matters: SSN before the generic account number so the more specific
# pattern wins; phone after SSN since both are digit runs.
_PII_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("EMAIL", re.compile(r"\b[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}\b")),
    ("SSN", re.compile(r"\b\d{3}-\d{2}-\d{4}\b")),
    ("PHONE", re.compile(r"\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b")),
    ("ACCOUNT", re.compile(r"\b(?:acct|account)[#:\s-]*\d{6,}\b", re.IGNORECASE)),
    ("ACCOUNT", re.compile(r"\b\d{10,16}\b")),  # bare long digit runs (card/acct)
]


def redact(text: str) -> tuple[str, dict[str, int]]:
    """Mask PII in ``text`` with ``[TYPE]`` placeholders.

    Returns the redacted text plus a count-by-type tally (e.g. ``{"EMAIL": 2}``)
    so the audit can record *how much* PII was scrubbed without storing any of it.
    """
    counts: dict[str, int] = {}
    out = text
    for typ, pat in _PII_PATTERNS:
        def _sub(m: re.Match[str], _typ: str = typ) -> str:
            counts[_typ] = counts.get(_typ, 0) + 1
            return f"[{_typ}]"

        out = pat.sub(_sub, out)
    return out, counts


def redact_text(text: str) -> str:
    """``redact`` keeping only the scrubbed string."""
    return redact(text)[0]


def contains_pii(text: str) -> bool:
    return any(pat.search(text) for _, pat in _PII_PATTERNS)


# --------------------------------------------------------------------------- #
# Tamper-evident audit                                                         #
# --------------------------------------------------------------------------- #

GENESIS = "0" * 64


@dataclass
class AuditLog:
    """Append-only, hash-chained audit of agent steps — tamper-evident."""

    _entries: list[dict] = field(default_factory=list)

    @staticmethod
    def _hash(entry: dict) -> str:
        body = {k: v for k, v in entry.items() if k != "hash"}
        return hashlib.sha256(
            json.dumps(body, sort_keys=True, default=str).encode()).hexdigest()

    def append(self, event: dict) -> dict:
        prev = self._entries[-1]["hash"] if self._entries else GENESIS
        entry = {"seq": len(self._entries), "ts": round(time.time(), 3),
                 **event, "prev_hash": prev}
        entry["hash"] = self._hash(entry)
        self._entries.append(entry)
        return entry

    def verify(self) -> dict:
        prev = GENESIS
        for e in self._entries:
            if e["prev_hash"] != prev:
                return {"ok": False, "broken_at": e["seq"],
                        "reason": "broken chain link"}
            if self._hash(e) != e["hash"]:
                return {"ok": False, "broken_at": e["seq"],
                        "reason": "content hash mismatch"}
            prev = e["hash"]
        return {"ok": True, "broken_at": None, "length": len(self._entries)}

    def entries(self) -> list[dict]:
        return list(self._entries)

    def reset(self) -> None:
        self._entries.clear()

    def __len__(self) -> int:
        return len(self._entries)

    def demo_tamper(self, seq: int) -> bool:
        """Edit a logged step WITHOUT re-hashing, to show verify() catches it."""
        for e in self._entries:
            if e["seq"] == seq:
                e["output_summary"] = (e.get("output_summary", "") + " [edited]")
                e["_tampered"] = True
                return True
        return False


# --------------------------------------------------------------------------- #
# Observability rollup                                                          #
# --------------------------------------------------------------------------- #

def rollup(steps: list) -> dict:
    """Aggregate per-step telemetry into a run-level cost/latency summary.

    ``steps`` is a list of :class:`~quorum.agent.StepResult` (anything with
    ``provider``/``model``/``latency_ms``/``cost_usd`` attributes).
    """
    total_latency = round(sum(s.latency_ms for s in steps), 1)
    total_cost = round(sum(s.cost_usd for s in steps), 6)
    by_provider: dict[str, int] = {}
    for s in steps:
        by_provider[s.provider] = by_provider.get(s.provider, 0) + 1
    return {
        "steps": len(steps),
        "total_latency_ms": total_latency,
        "total_cost_usd": total_cost,
        "by_provider": by_provider,
        "models": sorted({s.model for s in steps}),
    }
