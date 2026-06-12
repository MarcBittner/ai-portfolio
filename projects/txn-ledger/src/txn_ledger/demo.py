"""Offline demo: build the dataset, show the query plan before/after the index,
run an FEC-style rollup, and simulate an end-of-quarter surge.

Run: python -m txn_ledger.demo   (no network required)
"""

from txn_ledger import db, loadtest, queries


def main() -> None:
    m = db.build()
    s = queries.summary()
    print(f"Loaded {s['rows']:,} contributions in {m['load_ms']} ms "
          f"(${s['total_raised']:,.0f} across {s['distinct_donors']:,} donors)\n")

    print("Aggregation query plan — the query treated as an artifact:")
    print("  BEFORE index:")
    for ln in m["plan_before"]:
        print(f"    {ln}")
    print("  AFTER  index (idx_cycle_committee):")
    for ln in m["plan_after"]:
        print(f"    {ln}")

    a = queries.aggregate(2026)
    print(f"\nFEC-style rollup, 2026 cycle ({a['elapsed_ms']} ms):")
    print(f"  {'committee':<28}{'raised':>12}{'donors':>9}{'itemized':>12}")
    for r in a["rows"][:5]:
        print(f"  {r['name']:<28}{r['total_raised']:>12,.0f}{r['donors']:>9,}"
              f"{r['itemized']:>12,.0f}")

    lt = loadtest.surge(1000)
    print(f"\nEnd-of-quarter surge — {lt['queries']:,} aggregation queries:")
    print(f"  {lt['qps']:,} qps · p50 {lt['p50_ms']}ms · p95 {lt['p95_ms']}ms · "
          f"p99 {lt['p99_ms']}ms · max {lt['max_ms']}ms")


if __name__ == "__main__":
    main()
