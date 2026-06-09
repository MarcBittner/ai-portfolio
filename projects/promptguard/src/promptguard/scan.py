"""Scan text against the guardrail rules and return a verdict.

Findings carry their span (so a UI can highlight the user's own text), but for
``redact`` rules the *snippet* in the result is the category + length only —
the guardrail never re-emits a secret or PII value it detected. The verdict is
driven by the highest-severity finding: any high/critical → block, any
lower-severity → flag, none → allow.
"""

from dataclasses import dataclass

from promptguard.rules import RULES, SEVERITY_WEIGHT


@dataclass
class Finding:
    rule_id: str
    category: str
    severity: str
    start: int
    end: int
    snippet: str


def _applies(applies_to: str, direction: str) -> bool:
    return direction == "both" or applies_to in (direction, "both")


def scan(text: str, direction: str = "both") -> tuple[list[Finding], float, str]:
    """Return (findings, score, verdict). ``direction`` ∈ input|output|both."""
    findings: list[Finding] = []
    for rule in RULES:
        if not _applies(rule.applies_to, direction):
            continue
        for m in rule.pattern.finditer(text):
            matched = m.group(0)
            snippet = (
                f"[{rule.category} redacted · {len(matched)} chars]"
                if rule.redact else matched
            )
            findings.append(
                Finding(rule.id, rule.category, rule.severity, m.start(), m.end(),
                        snippet)
            )
    findings.sort(key=lambda f: (f.start, f.rule_id))
    score = round(max((SEVERITY_WEIGHT[f.severity] for f in findings), default=0.0), 2)
    verdict = "block" if score >= 0.85 else "flag" if score > 0 else "allow"
    return findings, score, verdict


def counts_by_category(findings: list[Finding]) -> dict[str, int]:
    out: dict[str, int] = {}
    for f in findings:
        out[f.category] = out.get(f.category, 0) + 1
    return out
