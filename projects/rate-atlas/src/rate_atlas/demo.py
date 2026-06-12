"""Offline demo: ingest the three differently-shaped price files, normalize them,
and compare a procedure's rate across payers + flag outliers.

Run: python -m rate_atlas.demo   (no network required)
"""

from rate_atlas import outliers, store


def main() -> None:
    rep = store.ingest()
    print("Ingested 3 price files (each a different shape) → one model:")
    for s in rep["sources"]:
        print(f"   {s['hospital']:<24} {s['shape']:<16} {s['rows']} rows")
    print(f"   total: {rep['total_rows']} normalized rate rows\n")

    code = "70450"
    c = store.compare(code)
    print(f"Compare {code} — {c['description']}:")
    for q in c["quotes"]:
        print(f"   {q['hospital']:<24} {q['payer']:<14} ${q['rate']:>9,.2f}")
    s = c["stats"]
    print(f"   range ${s['min']:,.2f}–${s['max']:,.2f}  median ${s['median']:,.2f}  "
          f"spread {s['spread_pct']*100:.0f}%\n")

    o = outliers.find_outliers(2.0)
    print(f"Rate outliers (|z| ≥ 2.0): {o['count']}")
    for f in o["outliers"]:
        print(f"   {f['code']}  {f['hospital']:<24} ${f['rate']:>9,.2f}  "
              f"(code mean ${f['code_mean']:,.2f}, z={f['zscore']})")


if __name__ == "__main__":
    main()
