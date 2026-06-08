"""Metric primitives: token F1, lexical support, voice heuristics."""

import re

_WORD = re.compile(r"[a-z0-9]+")

ASSISTANT_TELLS = (
    "as an ai",
    "as a language model",
    "based on the context",
    "based on the provided",
    "i cannot assist",
    "according to the documents",
)


def tokens(text: str) -> list[str]:
    return _WORD.findall(text.lower())


def token_f1(prediction: str, reference: str) -> float:
    """SQuAD-style token overlap F1."""
    pred, ref = tokens(prediction), tokens(reference)
    if not pred or not ref:
        return 0.0
    common: dict[str, int] = {}
    for t in pred:
        common[t] = common.get(t, 0) + 1
    overlap = sum(min(n, ref.count(t)) for t, n in common.items())
    if overlap == 0:
        return 0.0
    precision = overlap / len(pred)
    recall = overlap / len(ref)
    return 2 * precision * recall / (precision + recall)


def contains_reference(prediction: str, reference: str) -> bool:
    """Normalized substring containment (exact-fact presence)."""
    norm = lambda s: " ".join(tokens(s))  # noqa: E731
    return norm(reference) in norm(prediction)


def lexical_support(answer: str, cited_texts: list[str]) -> float:
    """Fraction of the answer's content tokens that appear in the cited
    chunks — the offline claim-support heuristic. An LLM judge replaces
    this when a real provider is configured (see judge.py)."""
    answer_tokens = set(tokens(answer))
    if not answer_tokens:
        return 0.0
    cited = set()
    for text in cited_texts:
        cited.update(tokens(text))
    return len(answer_tokens & cited) / len(answer_tokens)


def voice_violations(answer: str) -> list[str]:
    """Assistant-isms that break persona voice. First-person absence is
    also flagged for non-refusal answers of meaningful length."""
    lowered = answer.lower()
    hits = [tell for tell in ASSISTANT_TELLS if tell in lowered]
    if len(tokens(answer)) > 10 and not re.search(r"\b(i|my|me|we)\b", lowered):
        hits.append("no first-person voice")
    return hits


def voice_heuristic(answer: str) -> float:
    """Deterministic offline proxy for voice consistency: 1.0 with no
    assistant-isms, dropping with each violation. The LLM voice judge
    replaces this when a real provider is configured (see judge.py)."""
    return max(0.0, 1.0 - 0.34 * len(voice_violations(answer)))
