"""Direction-aware prompt/response firewall.

Scans **inputs** for prompt-injection / jailbreak / exfiltration patterns and
**outputs** for secret/PII leakage (via the redaction detectors). Returns a
verdict (``allow`` / ``flag`` / ``block``) and a risk score. Findings never carry
a detected secret's value — only its type and location.
"""

import re
from dataclasses import dataclass

from llm_gateway import redact

_SEVERITY_WEIGHT = {"critical": 1.0, "high": 0.9, "medium": 0.5, "low": 0.3}
BLOCK_AT = 0.85

# (id, category, severity, pattern) — applied to inputs.
_INPUT_RULES: list[tuple[str, str, str, re.Pattern]] = [
    ("INJ_IGNORE", "injection", "high",
     re.compile(r"(?i)ignore\s+(?:all\s+)?(?:previous|prior|the\s+above)\s+instructions")),
    ("INJ_DISREGARD", "injection", "high",
     re.compile(r"(?i)disregard\s+(?:the\s+)?(?:system|previous|above)")),
    ("INJ_SYS_PROMPT", "injection", "high",
     re.compile(r"(?i)(?:reveal|print|show|repeat|output)\b.{0,25}"
                r"(?:system\s+prompt|your\s+instructions|initial\s+prompt)")),
    ("JAILBREAK", "jailbreak", "high",
     re.compile(r"(?i)\b(?:DAN|do\s+anything\s+now|developer\s+mode|jailbreak)\b")),
    ("ROLE_OVERRIDE", "jailbreak", "medium",
     re.compile(r"(?i)(?:you\s+are\s+now|forget\s+you\s+are|act\s+as\s+if|new\s+persona)")),
    ("EXFIL", "exfiltration", "high",
     re.compile(r"(?i)(?:print|reveal|show|dump|send|leak)\b.{0,25}"
                r"(?:api[_ ]?key|secret|password|credential|env(?:ironment)?\s+var)")),
    ("DELIM_INJECT", "injection", "medium",
     re.compile(r"(?i)</?(?:system|assistant|user)>|```system")),
]


@dataclass
class Verdict:
    verdict: str
    score: float
    direction: str
    findings: list[dict]

    def as_dict(self) -> dict:
        return {"verdict": self.verdict, "score": round(self.score, 2),
                "direction": self.direction, "findings": self.findings}


def _decide(findings: list[dict]) -> tuple[str, float]:
    if not findings:
        return "allow", 0.0
    score = max(_SEVERITY_WEIGHT.get(f["severity"], 0.3) for f in findings)
    return ("block" if score >= BLOCK_AT else "flag"), score


def scan(text: str, direction: str = "both") -> Verdict:
    """Scan ``text``; ``direction`` ∈ {input, output, both}."""
    findings: list[dict] = []
    if direction in ("input", "both"):
        for rid, cat, sev, pat in _INPUT_RULES:
            for m in pat.finditer(text):
                findings.append({"rule_id": rid, "category": cat, "severity": sev,
                                 "start": m.start(), "end": m.end()})
    if direction in ("output", "both"):
        for f in redact.detect(text):
            sev = "critical" if f.category == "secret" else "medium"
            findings.append({"rule_id": f"LEAK_{f.type}", "category": "leakage",
                             "severity": sev, "start": f.start, "end": f.end})
    verdict, score = _decide(findings)
    return Verdict(verdict=verdict, score=score, direction=direction, findings=findings)


def rules() -> list[dict]:
    """Static description of the input rules (for the UI / introspection)."""
    return [{"id": rid, "category": cat, "severity": sev, "applies_to": "input"}
            for rid, cat, sev, _ in _INPUT_RULES] + [
        {"id": "LEAK_*", "category": "leakage", "severity": "critical/medium",
         "applies_to": "output"}]
