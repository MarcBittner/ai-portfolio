"""Deterministic guardrail rules.

Each rule is a compiled regex tagged with a category, a severity, and the
direction it applies to — `input` (prompt going into a model), `output`
(response coming out), or `both`. Injection/jailbreak/exfiltration matter on
input; secret and PII leakage matter on output. ``redact`` rules mask the
matched value in findings so the guardrail never echoes a secret it caught.
"""

import re
from dataclasses import dataclass

SEVERITY_WEIGHT = {"low": 0.25, "medium": 0.5, "high": 0.85, "critical": 1.0}


@dataclass(frozen=True)
class Rule:
    id: str
    category: str  # injection | jailbreak | exfiltration | secret | pii
    severity: str  # low | medium | high | critical
    applies_to: str  # input | output | both
    description: str
    pattern: re.Pattern[str]
    redact: bool = False  # mask the matched value in findings


def _r(pat: str, flags: int = re.IGNORECASE) -> re.Pattern[str]:
    return re.compile(pat, flags)


RULES: list[Rule] = [
    # --- prompt injection (input) ---
    Rule("ignore_previous", "injection", "high", "input",
         "Attempt to override prior instructions",
         _r(r"\b(ignore|disregard|forget)\b.{0,30}\b(previous|prior|above|earlier|"
            r"all)\b.{0,20}\b(instructions?|prompts?|messages?|rules?)\b")),
    Rule("reveal_prompt", "injection", "high", "input",
         "Attempt to extract the system prompt",
         _r(r"\b(reveal|show|print|repeat|output|tell me)\b.{0,30}"
            r"\b(system\s+prompt|your\s+(instructions?|prompt|rules?|guidelines?))\b")),
    Rule("override_rules", "injection", "high", "input",
         "Attempt to disable guidelines/safety",
         _r(r"\b(ignore|bypass|disable|turn off|override)\b.{0,25}"
            r"\b(safety|guidelines?|filters?|restrictions?|rules?|policy)\b")),
    # --- jailbreak (input) ---
    Rule("dan", "jailbreak", "high", "input",
         "Known jailbreak persona / mode",
         _r(r"\b(DAN\b|do anything now|developer mode|jailbreak|"
            r"unrestricted mode)\b")),
    Rule("roleplay_no_rules", "jailbreak", "high", "input",
         "Roleplay framed to remove restrictions",
         _r(r"\b(pretend|act as|you are now|imagine you are)\b.{0,40}"
            r"\b(no|without|free of|ignore)\b.{0,15}"
            r"\b(restrictions?|rules?|limits?|guidelines?|filter)\b")),
    # --- exfiltration (both) ---
    Rule("exfiltrate", "exfiltration", "medium", "both",
         "Instruction to send/post data elsewhere",
         _r(r"\b(send|post|upload|exfiltrate|forward)\b.{0,30}"
            r"\b(to\s+https?://|to\s+\S+@|webhook|endpoint|server)\b")),
    Rule("encoded_payload", "exfiltration", "low", "both",
         "Long base64-like blob (possible hidden payload)",
         _r(r"\b[A-Za-z0-9+/]{40,}={0,2}\b", 0)),
    # --- secret leakage (output) ---
    Rule("openai_key", "secret", "critical", "output",
         "OpenAI / Anthropic API key", _r(r"\bsk-(ant-)?[A-Za-z0-9-]{20,}\b", 0),
         redact=True),
    Rule("aws_key", "secret", "critical", "output",
         "AWS access key id", _r(r"\bAKIA[0-9A-Z]{16}\b", 0), redact=True),
    Rule("github_token", "secret", "critical", "output",
         "GitHub token", _r(r"\bgh[pousr]_[A-Za-z0-9]{20,}\b", 0), redact=True),
    Rule("google_key", "secret", "critical", "output",
         "Google API key", _r(r"\bAIza[0-9A-Za-z_-]{30,}\b", 0), redact=True),
    Rule("slack_token", "secret", "critical", "output",
         "Slack token", _r(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b", 0), redact=True),
    Rule("private_key", "secret", "critical", "output",
         "Private key block",
         _r(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----", 0), redact=True),
    Rule("bearer", "secret", "high", "output",
         "Bearer / authorization token",
         _r(r"\b(?:Bearer|Authorization:?)\s+[A-Za-z0-9._\-]{16,}"), redact=True),
    # --- PII leakage (output) ---
    Rule("email", "pii", "medium", "output", "Email address",
         _r(r"\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b", 0), redact=True),
    Rule("ssn", "pii", "high", "output", "US Social Security Number",
         _r(r"\b\d{3}-\d{2}-\d{4}\b", 0), redact=True),
    Rule("credit_card", "pii", "high", "output", "Credit-card-like number",
         _r(r"\b(?:\d[ -]?){13,18}\d\b", 0), redact=True),
    Rule("phone", "pii", "medium", "output", "Phone number",
         _r(r"\b(?:\+?1[ .-]?)?(?:\(\d{3}\)[ .-]?|\d{3}[ .-])\d{3}[ .-]\d{4}\b", 0),
         redact=True),
]

RULE_INDEX = {r.id: r for r in RULES}
CATEGORIES = sorted({r.category for r in RULES})
