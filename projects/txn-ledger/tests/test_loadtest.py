from txn_ledger import db
from txn_ledger.loadtest import surge


def test_surge_reports_throughput_and_latency():
    db.build(5000, seed=1)
    r = surge(80)
    assert r["queries"] == 80
    assert r["qps"] > 0
    assert r["p50_ms"] <= r["p95_ms"] <= r["p99_ms"] <= r["max_ms"]


def test_surge_is_bounded():
    db.build(2000, seed=1)
    assert surge(100_000)["queries"] == 20_000   # capped
