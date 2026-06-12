from fastapi.testclient import TestClient

from rate_atlas.api import app

client = TestClient(app)


def test_health():
    b = client.get("/health").json()
    assert b["status"] == "ok" and b["sources"] == 3 and b["total_rows"] == 18


def test_sources_report_shapes():
    ss = client.get("/sources").json()["sources"]
    assert {s["shape"] for s in ss} == {"cms_nested_json", "flat_json", "pipe_csv"}


def test_procedures():
    codes = {p["code"] for p in client.get("/procedures").json()["procedures"]}
    assert "70450" in codes


def test_compare_returns_stats():
    b = client.get("/compare/70450").json()
    assert b["stats"]["spread_pct"] > 0
    assert b["quotes"] == sorted(b["quotes"], key=lambda q: q["rate"])


def test_compare_unknown_404():
    assert client.get("/compare/00000").status_code == 404


def test_outliers():
    assert client.get("/outliers?threshold=2.0").json()["count"] >= 1


def test_search():
    assert client.get("/search?q=CT").json()["results"]
