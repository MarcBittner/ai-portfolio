from txn_ledger import db, queries


def test_plan_goes_from_scan_to_index():
    m = db.build(5000, seed=1)
    assert any("SCAN" in ln for ln in m["plan_before"])
    after = " ".join(m["plan_after"])
    assert "SEARCH" in after and "INDEX" in after and "idx_cycle_committee" in after


def test_summary_counts():
    db.build(5000, seed=1)
    s = queries.summary()
    assert s["rows"] == 5000 and s["total_raised"] > 0 and s["distinct_donors"] > 0


def test_aggregate_rollup_and_itemization():
    db.build(8000, seed=2)
    a = queries.aggregate(2026)
    assert a["rows"]
    totals = [r["total_raised"] for r in a["rows"]]
    assert totals == sorted(totals, reverse=True)       # ordered by raised desc
    for r in a["rows"]:
        assert round(r["itemized"] + r["unitemized"], 2) == r["total_raised"]
        assert r["donors"] <= r["contributions"]
    assert "elapsed_ms" in a


def test_plan_regression_passes():
    db.build(5000, seed=1)
    pr = queries.plan_regression()
    assert pr["passed"] is True
    assert pr["uses_index"] and pr["covering"] and pr["scan_before_index"]


def test_aggregate_single_committee():
    db.build(8000, seed=2)
    a = queries.aggregate(2026, committee="C-0001")
    assert len(a["rows"]) <= 1
    if a["rows"]:
        assert a["rows"][0]["committee_id"] == "C-0001"
