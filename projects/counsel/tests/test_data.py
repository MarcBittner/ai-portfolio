"""Unit tests for the appendable, resettable ledger (data.py).

The ledger is the trust boundary's ground truth: a human may append source rows,
but the data stays deterministic and validated. These run against the cached
singleton and reset it after each test so other modules see a pristine seed.
"""

import pytest

from counsel import compute, data
from counsel.data import build_dataset


@pytest.fixture(autouse=True)
def _clean_dataset():
    data.reset_dataset()
    yield
    data.reset_dataset()


def test_add_transaction_appends_tagged_and_sorted():
    ds = build_dataset()
    n0 = len(ds.transactions)
    t = data.add_transaction(ds, "acct_credit", "2025-06-14",
                             "Blue Mug Coffee", "dining", -8.50)
    assert t.id == "txn_user_000"
    assert data.is_user_added(t) is True
    assert t.amount == -8.50
    assert len(ds.transactions) == n0 + 1
    # the list stays sorted by (date, id)
    keys = [(x.date, x.id) for x in ds.transactions]
    assert keys == sorted(keys)
    # second add increments the user counter
    t2 = data.add_transaction(ds, "acct_credit", "2025-06-15",
                              "Corner Noodle", "dining", -12.00)
    assert t2.id == "txn_user_001"


def test_add_transaction_flows_into_compute():
    ds = build_dataset()
    from datetime import timedelta
    end = data.TODAY
    start = end - timedelta(days=30)
    before = compute.category_spend(ds, "dining", start, end).answer_number
    t = data.add_transaction(ds, "acct_credit", end.isoformat(),
                             "Pier 7 Grill", "dining", -100.00)
    after = compute.category_spend(ds, "dining", start, end)
    assert after.answer_number == round(before + 100.0, 2)
    assert t.id in after.citation_ids


def test_add_transaction_rejects_bad_inputs():
    ds = build_dataset()
    with pytest.raises(ValueError):
        data.add_transaction(ds, "acct_nope", "2025-06-14", "X", "dining", -1.0)
    with pytest.raises(ValueError):
        data.add_transaction(ds, "acct_credit", "2025-06-14", "X", "crypto", -1.0)
    with pytest.raises(ValueError):
        data.add_transaction(ds, "acct_credit", "nope", "X", "dining", -1.0)
    with pytest.raises(ValueError):
        data.add_transaction(ds, "acct_credit", "2025-06-14", "  ", "dining", -1.0)
    with pytest.raises(ValueError):
        data.add_transaction(ds, "acct_credit", "2025-06-14", "X", "dining",
                             float("nan"))


def test_reset_dataset_drops_user_rows():
    ds = build_dataset()
    seed_n = len(ds.transactions)
    data.add_transaction(ds, "acct_credit", "2025-06-14", "X", "dining", -1.0)
    data.add_transaction(ds, "acct_credit", "2025-06-14", "Y", "dining", -2.0)
    assert len(build_dataset().transactions) == seed_n + 2
    ds2 = data.reset_dataset()
    assert len(ds2.transactions) == seed_n
    assert all(not data.is_user_added(t) for t in ds2.transactions)
    # reset returns the rebuilt singleton
    assert build_dataset() is ds2
