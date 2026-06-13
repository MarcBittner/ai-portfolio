"""Lightweight, deterministic guardrails.

Input scanning flags prompt-injection / jailbreak phrasing before the agent
plans. Output scanning catches secret and PII leakage and redacts it before the
answer is returned. Both are regex-based and offline — a safety net that runs
whether or not a model is in the loop. This is intentionally small; promptguard
in the same portfolio is the full firewall.
"""

import re
from dataclasses import dataclass

_INJECTION = [
    (re.compile(r"ignore (all|any|the)? ?(previous|prior|above) instructions", re.I),
     "instruction-override"),
    (re.compile(r"disregard (the|all|your) (system|previous) prompt", re.I),
     "instruction-override"),
    (re.compile(r"\b(reveal|print|show|leak)\b.{0,30}\b(system prompt|instructions)\b",
                re.I), "prompt-exfiltration"),
    (re.compile(r"you are now (dan|developer mode|do anything)", re.I), "jailbreak"),
    (re.compile(r"\bpretend you have no (rules|restrictions|guidelines)\b", re.I),
     "jailbreak"),
]

_SECRETS = [
    (re.compile(r"sk-[A-Za-z0-9]{16,}"), "api-key"),
    (re.compile(r"AKIA[0-9A-Z]{16}"), "aws-key"),
    (re.compile(r"ghp_[A-Za-z0-9]{20,}"), "github-token"),
    (re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"), "private-key"),
]
_PII = [
    (re.compile(r"\b\d{3}-\d{2}-\d{4}\b"), "ssn"),
    (re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.-]+\b"), "email"),
    (re.compile(r"\b(?:\d[ -]?){13,16}\b"), "card-like"),
]


@dataclass
class Finding:
    kind: str
    category: str  # what was matched
    snippet: str


def scan_input(text: str) -> list[Finding]:
    """Flag prompt-injection / jailbreak phrasing (does not block by itself)."""
    out: list[Finding] = []
    for pattern, category in _INJECTION:
        for m in pattern.finditer(text):
            out.append(Finding("injection", category, m.group(0)[:80]))
    return out


def scan_and_redact_output(text: str) -> tuple[str, list[Finding]]:
    """Redact secrets/PII in ``text``; return the cleaned text and the findings."""
    findings: list[Finding] = []
    cleaned = text
    for table, kind in ((_SECRETS, "secret"), (_PII, "pii")):
        for pattern, category in table:
            def _sub(m: re.Match, _cat=category, _kind=kind) -> str:
                findings.append(Finding(_kind, _cat, "[redacted]"))
                return f"[redacted:{_cat}]"
            cleaned = pattern.sub(_sub, cleaned)
    return cleaned, findings


def findings_as_dicts(findings: list[Finding]) -> list[dict]:
    return [{"kind": f.kind, "category": f.category, "snippet": f.snippet}
            for f in findings]
