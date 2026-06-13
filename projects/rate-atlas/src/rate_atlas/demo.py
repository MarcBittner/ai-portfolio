"""Offline demo: ingest the three differently-shaped price files, normalize them,
and compare a procedure's rate across payers + flag outliers — THEN feed a
fourth, UNKNOWN-format file and have the LLM (or the deterministic offline
matcher) map its columns to the canonical schema so it ingests too.

Run: python -m rate_atlas.demo   (no network required)
"""

from rate_atlas import assist, outliers, store
from rate_atlas.data import UNKNOWN_HOSPITAL, UNKNOWN_SAMPLE


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

    # --- NEW: a fourth file in an UNKNOWN format → LLM-assisted column mapping ---
    print("\nA 4th file arrives in an UNKNOWN format (none of the 3 adapters fit):")
    cols = UNKNOWN_SAMPLE.splitlines()[0]
    print(f"   header: {cols}")
    a = assist.assist(UNKNOWN_HOSPITAL, UNKNOWN_SAMPLE)
    print(f"   detected: {a['detected_kind']}  ·  mapped via: {a['provider']} "
          f"({a['model']})")
    print("   proposed column → canonical mapping:")
    for src, canon in a["mapping"].items():
        print(f"      {src:<14} → {canon if canon else '(dropped)'}")
    print(f"   applied deterministically → {a['rows_mapped']}/{a['rows_in']} "
          f"canonical rows ingested for {a['hospital']}")

    # the assisted rows are now first-class: re-compare 70450 with Delta included
    store.ingest_records(UNKNOWN_HOSPITAL.lower().replace(" ", "-"),
                         UNKNOWN_HOSPITAL, a["records"])
    c2 = store.compare(code)
    print(f"   {code} now spans {len(c2['quotes'])} quotes across "
          f"{len({q['hospital'] for q in c2['quotes']})} hospitals "
          f"(was {len(c['quotes'])}) — the unknown file is in the comparison.")


if __name__ == "__main__":
    main()
