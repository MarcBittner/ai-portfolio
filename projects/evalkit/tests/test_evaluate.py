"""Evaluation aggregation, regression gating, and run comparison."""

import pytest

from evalkit.evaluate import compare, evaluate, gate


def test_evaluate_per_item_and_aggregate():
    items = [("Paris", "Paris"), ("London", "Paris")]
    per_item, aggregate = evaluate(items, ["exact_match", "token_f1"])
    assert per_item[0]["exact_match"] == 1.0
    assert per_item[1]["exact_match"] == 0.0
    assert aggregate["exact_match"] == 0.5  # mean of 1 and 0


def test_evaluate_defaults_to_all_metrics():
    per_item, aggregate = evaluate([("a", "a")])
    assert set(aggregate) == {
        "exact_match", "contains", "token_f1", "semantic_similarity", "refusal_match",
    }


def test_evaluate_empty_and_unknown():
    per_item, aggregate = evaluate([], ["token_f1"])
    assert per_item == [] and aggregate == {"token_f1": 0.0}
    with pytest.raises(ValueError):
        evaluate([("a", "a")], ["nope"])


def test_gate_pass_and_fail():
    agg = {"token_f1": 0.8, "exact_match": 0.4}
    passed, failures = gate(agg, {"token_f1": 0.7})
    assert passed and failures == {}
    passed, failures = gate(agg, {"token_f1": 0.7, "exact_match": 0.5})
    assert not passed
    assert failures["exact_match"] == {"score": 0.4, "min": 0.5}


def test_compare_deltas():
    cmp = compare({"token_f1": 0.6}, {"token_f1": 0.75, "exact_match": 0.5})
    assert cmp["token_f1"]["delta"] == 0.15
    assert cmp["exact_match"]["baseline"] is None
    assert cmp["exact_match"]["delta"] == 0.5
