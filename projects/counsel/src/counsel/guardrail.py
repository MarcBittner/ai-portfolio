"""Deterministic safety / bias guardrail — runs before any LLM call.

A finance copilot must refuse two classes of request *mechanically*, never
relying on the model's goodwill:

  • **discriminatory** framing — questions that ask the product to treat people
    differently by a protected attribute (race, religion, gender, age, …), e.g.
    "should I avoid lending to people of <group>". A trustworthy agent declines.
  • **unlicensed advice** — specific securities/tax/legal recommendations that
    only a licensed professional may give ("which stock should I buy", "is this
    a good time to buy TSLA"). counsel describes *your* records and does
    mechanical projections; it does not give investment/tax/legal advice.

The guardrail is pure keyword/regex matching (stdlib only) so it is testable,
offline, and identical regardless of which provider — or no provider — is live.
It returns a structured verdict the API surfaces as an honest refusal *before*
retrieval or narration, so a blocked request never reaches the model at all.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# Protected-class tokens. A question that pairs a financial *decision* verb with
# one of these is refused as discriminatory. Word-boundary matched, lowercased.
_PROTECTED = [
    "race", "racial", "black", "white", "asian", "hispanic", "latino", "latina",
    "religion", "religious", "christian", "muslim", "jewish", "hindu", "buddhist",
    "gender", "male", "female", "man", "woman", "men", "women", "transgender",
    "gay", "lesbian", "queer", "lgbt", "lgbtq",
    "disabled", "disability", "pregnant", "pregnancy",
    "national origin", "immigrant", "ethnicity", "ethnic", "skin color",
]

# Decision verbs that, paired with a protected class, make the request
# discriminatory (lending/pricing/hiring/serving differently by attribute).
_DECISION = [
    "avoid", "deny", "reject", "refuse", "charge more", "charge less", "blacklist",
    "discriminate", "exclude", "screen out", "not lend", "don't lend", "less likely",
    "more likely", "should i lend", "should i hire", "redline", "deny credit",
    "withhold", "treat differently", "raise rates for", "lower rates for",
]

# Unlicensed-advice asks: a recommendation to buy/sell a specific security, or
# tax/legal guidance. We narrate records + mechanical projections, not advice.
_ADVICE_PATTERNS = [
    r"\bshould i (buy|sell|invest in|short|dump)\b",
    r"\bwhat (stock|crypto|coin|fund|ticker)s? should i\b",
    r"\bis (it|now) a good time to (buy|sell|invest)\b",
    r"\bwhich (stock|fund|etf|crypto)s? (should|to) (buy|sell|pick)\b",
    r"\bwill (the market|\w+) (go up|go down|crash|moon|rally)\b",
    r"\bguarantee(d)? returns?\b",
    r"\bhow (do|can) i (evade|avoid paying) tax(es)?\b",
    r"\bhelp me (hide|launder)\b",
]

_ADVICE_RE = [re.compile(p) for p in _ADVICE_PATTERNS]

REFUSAL_DISCRIMINATION = (
    "I can't help with that. Making financial decisions about people based on a "
    "protected characteristic is discriminatory (and unlawful under fair-lending "
    "rules). I can analyze the records in this account, but I won't weigh anyone "
    "by who they are."
)
REFUSAL_ADVICE = (
    "I can't give personalized investment, tax, or legal advice — that requires a "
    "licensed professional. What I can do is describe your own holdings and run "
    "mechanical, clearly-labeled projections from your records."
)


@dataclass
class Verdict:
    allowed: bool
    category: str       # "" | "discrimination" | "unlicensed_advice"
    message: str        # the refusal text (empty when allowed)

    def to_dict(self) -> dict:
        return {"allowed": self.allowed, "category": self.category,
                "message": self.message}


def _has_word(text: str, words: list[str]) -> bool:
    for w in words:
        if " " in w:
            if w in text:
                return True
        # single tokens match with an optional plural/possessive suffix so
        # "immigrants"/"women" hit "immigrant"/"woman"-style entries too.
        elif re.search(rf"\b{re.escape(w)}(?:s|es|'s)?\b", text):
            return True
    return False


def check(question: str) -> Verdict:
    """Screen a question before retrieval/narration. Pure + deterministic."""
    q = (question or "").lower()

    # Unlicensed advice / illicit asks.
    for rx in _ADVICE_RE:
        if rx.search(q):
            return Verdict(False, "unlicensed_advice", REFUSAL_ADVICE)

    # Discrimination: a protected attribute + a decision verb in the same ask.
    if _has_word(q, _PROTECTED) and _has_word(q, _DECISION):
        return Verdict(False, "discrimination", REFUSAL_DISCRIMINATION)

    return Verdict(True, "", "")
