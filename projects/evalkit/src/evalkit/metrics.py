"""Deterministic evaluation metrics — stdlib only, no model, no network.

Every metric scores one ``(prediction, reference)`` pair in [0, 1] so they
compose into a single report and a regression gate. The semantic metric uses
a hashed-bag-of-tokens embedding (cosine), so "semantic-ish" similarity is
available offline and reproducibly — weaker than a real embedder, but exact
and dependency-free (a real embedder can be plugged in later).
"""

import hashlib
import math
import re

_WORD = re.compile(r"[a-z0-9]+")
_REFUSAL = (
    "i don't know", "i do not know", "cannot answer", "can't answer",
    "no information", "not covered", "don't have", "unable to",
)
_EMBED_DIM = 256


def _tokens(text: str) -> list[str]:
    return _WORD.findall(text.lower())


def _norm(text: str) -> str:
    return " ".join(_tokens(text))


def exact_match(prediction: str, reference: str) -> float:
    """1.0 iff normalized prediction equals normalized reference."""
    return 1.0 if _norm(prediction) == _norm(reference) else 0.0


def contains(prediction: str, reference: str) -> float:
    """1.0 iff the (normalized) reference appears in the prediction."""
    ref = _norm(reference)
    return 1.0 if ref and ref in _norm(prediction) else 0.0


def token_f1(prediction: str, reference: str) -> float:
    """Token-overlap F1 between prediction and reference (SQuAD-style)."""
    pred, ref = _tokens(prediction), _tokens(reference)
    if not pred and not ref:
        return 1.0
    if not pred or not ref:
        return 0.0
    common = 0
    ref_pool = list(ref)
    for tok in pred:
        if tok in ref_pool:
            ref_pool.remove(tok)
            common += 1
    if common == 0:
        return 0.0
    precision = common / len(pred)
    recall = common / len(ref)
    return round(2 * precision * recall / (precision + recall), 4)


def _bucket(token: str) -> int:
    # stable across processes (unlike built-in hash() on str)
    return int.from_bytes(hashlib.md5(token.encode()).digest()[:4], "big") % _EMBED_DIM


def _embed(text: str) -> list[float]:
    vec = [0.0] * _EMBED_DIM
    for tok in _tokens(text):
        vec[_bucket(tok)] += 1.0
    return vec


def semantic_similarity(prediction: str, reference: str) -> float:
    """Cosine similarity of hashed bag-of-tokens embeddings, clamped to [0,1]."""
    a, b = _embed(prediction), _embed(reference)
    dot = sum(x * y for x, y in zip(a, b, strict=True))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na == 0 or nb == 0:
        return 0.0
    return round(max(0.0, min(1.0, dot / (na * nb))), 4)


def refusal_match(prediction: str, reference: str) -> float:
    """1.0 when prediction and reference agree on refusing (both refuse or
    both answer). Lets a dataset score 'correctly declined to answer'."""
    return 1.0 if _is_refusal(prediction) == _is_refusal(reference) else 0.0


def _is_refusal(text: str) -> bool:
    low = text.lower()
    return any(p in low for p in _REFUSAL)


# name -> (fn, description); every fn is (prediction, reference) -> [0,1]
METRICS: dict[str, tuple] = {
    "exact_match": (exact_match, "Normalized strings are identical"),
    "contains": (contains, "Reference appears verbatim in the prediction"),
    "token_f1": (token_f1, "Token-overlap F1 (SQuAD-style)"),
    "semantic_similarity": (
        semantic_similarity, "Cosine of hashed bag-of-tokens embeddings",
    ),
    "refusal_match": (refusal_match, "Prediction and reference agree on refusing"),
}
METRIC_NAMES = list(METRICS)


def score(metric: str, prediction: str, reference: str) -> float:
    if metric not in METRICS:
        raise ValueError(f"unknown metric {metric!r}; valid: {METRIC_NAMES}")
    return METRICS[metric][0](prediction, reference)
