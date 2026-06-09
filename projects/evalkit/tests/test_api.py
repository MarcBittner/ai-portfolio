"""API endpoints via FastAPI's TestClient."""

from fastapi.testclient import TestClient

from evalkit.api import app

client = TestClient(app)


def test_health():
    body = client.get("/health").json()
    assert body["status"] == "ok" and body["metrics"] == 5


def test_metrics_listing():
    metrics = client.get("/metrics").json()
    names = {m["name"] for m in metrics}
    assert "token_f1" in names and all(m["description"] for m in metrics)


def test_evaluate_with_gate():
    r = client.post("/evaluate", json={
        "items": [
            {"prediction": "Paris", "reference": "Paris"},
            {"prediction": "the capital is Paris", "reference": "Paris"},
        ],
        "metrics": ["exact_match", "contains"],
        "thresholds": {"contains": 0.9, "exact_match": 0.9},
    })
    body = r.json()
    assert body["n"] == 2
    assert body["aggregate"]["contains"] == 1.0
    assert body["aggregate"]["exact_match"] == 0.5
    assert body["gate"]["passed"] is False  # exact_match 0.5 < 0.9
    assert "exact_match" in body["gate"]["failures"]


def test_evaluate_unknown_metric_422():
    r = client.post("/evaluate", json={
        "items": [{"prediction": "a", "reference": "a"}], "metrics": ["bogus"]})
    assert r.status_code == 422


def test_evaluate_empty_items_422():
    r = client.post("/evaluate", json={"items": []})
    assert r.status_code == 422  # min_length=1


def test_compare():
    r = client.post("/compare", json={
        "baseline": {"token_f1": 0.6}, "candidate": {"token_f1": 0.75}})
    body = r.json()
    assert body["comparison"]["token_f1"]["delta"] == 0.15


def test_index_served():
    r = client.get("/")
    assert r.status_code == 200 and "evalkit" in r.text.lower()
