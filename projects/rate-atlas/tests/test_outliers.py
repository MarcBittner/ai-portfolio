from rate_atlas import store
from rate_atlas.outliers import find_outliers


def test_finds_statistical_outliers():
    store.ingest()
    o = find_outliers(2.0)
    assert o["count"] >= 1
    for f in o["outliers"]:
        assert abs(f["zscore"]) >= 2.0
        assert {"code", "hospital", "payer", "rate", "code_mean", "zscore"} <= set(f)


def test_higher_threshold_flags_fewer():
    store.ingest()
    assert find_outliers(3.0)["count"] <= find_outliers(1.5)["count"]


def test_codes_with_too_few_rates_are_skipped():
    # a code priced fewer than 3 times can't have a meaningful z-score
    store.ingest()
    flagged_codes = {f["code"] for f in find_outliers(0.5)["outliers"]}
    assert "99214" not in flagged_codes   # only 1 rate
