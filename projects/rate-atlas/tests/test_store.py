from rate_atlas import store


def test_ingest_loads_all_sources():
    rep = store.ingest()
    assert rep["total_rows"] == 18
    assert {s["shape"] for s in rep["sources"]} == {
        "cms_nested_json", "flat_json", "pipe_csv"}


def test_procedures_listed():
    store.ingest()
    codes = {p["code"] for p in store.procedures()}
    assert {"99213", "70450", "80053"} <= codes


def test_compare_returns_sorted_quotes_and_stats():
    store.ingest()
    c = store.compare("70450")
    rates = [q["rate"] for q in c["quotes"]]
    assert rates == sorted(rates)                  # ascending
    assert c["stats"]["min"] < c["stats"]["max"]
    assert c["stats"]["spread_pct"] > 0
    # head CT spans payers/hospitals
    assert len({q["hospital"] for q in c["quotes"]}) >= 2


def test_compare_unknown_code_is_empty():
    store.ingest()
    assert store.compare("00000")["quotes"] == []


def test_search_matches_description():
    store.ingest()
    assert any(r["code"] == "70450" for r in store.search("CT"))
