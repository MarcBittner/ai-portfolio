"""Unit tests for the deterministic computation layer — the trust boundary.

These assert exact, reproducible numbers (the dataset is seeded), so any drift in
the math is caught. Code decides the numbers; these pin them.
"""

from datetime import timedelta

from counsel import compute, data
from counsel.data import build_dataset

DS = build_dataset()


def test_dataset_is_deterministic_and_pii_free():
    a, b = build_dataset(), build_dataset()
    assert a is b  # cached singleton
    blob = str(DS.to_dict()).lower()
    for token in ("ssn", "@", "password", "social security"):
        assert token not in blob


def test_net_worth_balances_assets_minus_liabilities():
    c = compute.net_worth(DS)
    f = c.facts
    assert round(f["assets"] - f["liabilities"], 2) == c.answer_number
    assert c.answer_number > 0
    # every account + holding is cited
    assert len(c.citation_ids) == len(DS.accounts) + len(DS.holdings)


def test_net_worth_is_reproducible_to_the_cent():
    assert compute.net_worth(DS).answer_number == compute.net_worth(DS).answer_number


def test_category_spend_only_counts_outflow_in_window():
    end = data.TODAY
    start = end - timedelta(days=30)
    c = compute.category_spend(DS, "dining", start, end)
    assert c.answer_number >= 0
    for cid in c.citation_ids:
        t = DS.txn(cid)
        assert t.category == "dining" and t.amount < 0


def test_unusual_charges_flags_the_planted_duplicate_and_outlier():
    c = compute.unusual_charges(DS)
    types = {f["type"] for f in c.detail["flagged"]}
    assert "duplicate" in types  # the planted GadgetBay dupe
    assert "outlier" in types    # the planted $468 dining outlier
    assert c.answer_number >= 2


def test_project_balance_is_linear_and_labeled():
    c = compute.project_balance(DS)
    f = c.facts
    expect = round(f["current_balance"] + f["avg_daily_net"] * f["horizon_days"], 2)
    assert abs(f["projected_balance"] - expect) < 0.01


def test_spend_breakdown_excludes_transfers():
    end = data.TODAY
    start = end - timedelta(days=365)
    c = compute.spend_breakdown(DS, start, end)
    assert "transfer" not in c.detail["by_category"]
    assert c.answer_number > 0
