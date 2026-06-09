"""Metric primitives — determinism, ranges, and edge cases."""

import pytest

from evalkit.metrics import (
    METRIC_NAMES,
    contains,
    exact_match,
    refusal_match,
    score,
    semantic_similarity,
    token_f1,
)


def test_exact_match_normalizes():
    assert exact_match("The Cat.", "the cat") == 1.0
    assert exact_match("a cat", "a dog") == 0.0


def test_contains():
    assert contains("the capital is Paris today", "Paris") == 1.0
    assert contains("nope", "Paris") == 0.0
    assert contains("anything", "") == 0.0


def test_token_f1():
    assert token_f1("a b c", "a b c") == 1.0
    assert token_f1("a b c", "x y z") == 0.0
    assert 0.0 < token_f1("the quick brown fox", "the brown dog") < 1.0
    assert token_f1("", "") == 1.0
    assert token_f1("a", "") == 0.0


def test_semantic_similarity_range_and_determinism():
    a, b = "the garden tomatoes are ripe", "ripe tomatoes in the garden"
    s1 = semantic_similarity(a, b)
    s2 = semantic_similarity(a, b)
    assert s1 == s2  # deterministic across calls (stable hashing)
    assert 0.0 <= s1 <= 1.0
    assert s1 > semantic_similarity("tomatoes", "quarterly derivatives report")


def test_refusal_match():
    assert refusal_match("I don't know that.", "Not covered in the notes.") == 1.0
    assert refusal_match("The answer is 42.", "42") == 1.0  # both answer
    assert refusal_match("I cannot answer.", "The answer is 42.") == 0.0


def test_score_dispatch_and_unknown():
    assert score("exact_match", "x", "x") == 1.0
    with pytest.raises(ValueError):
        score("bogus", "x", "y")


def test_all_metrics_listed():
    assert set(METRIC_NAMES) == {
        "exact_match", "contains", "token_f1", "semantic_similarity", "refusal_match",
    }
