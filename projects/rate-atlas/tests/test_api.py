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


def test_llm_status():
    b = client.get("/llm").json()
    assert set(b["providers"]) == {"anthropic", "openai", "ollama", "openrouter"}
    assert b["offline_fallback"] is True


def test_evals_offline_recall():
    b = client.get("/evals?mode=offline").json()
    assert b["recall"] == 1.0 and b["precision"] == 1.0
    assert b["headers"] >= 3


def test_assist_maps_unknown_format_and_ingests():
    b = client.post("/normalize/assist", json={"mode": "offline"}).json()
    assert b["provider"] == "offline"
    assert b["rows_mapped"] > 0
    # mapped columns include the essentials
    assert "code" in b["mapping"].values()
    assert "rate" in b["mapping"].values()
    # ingested rows show up as an llm_assisted source
    assert b["ingested"]["shape"] == "llm_assisted"
    shapes = {s["shape"] for s in client.get("/sources").json()["sources"]}
    assert "llm_assisted" in shapes
    client.post("/admin/reingest")  # restore the deterministic baseline
