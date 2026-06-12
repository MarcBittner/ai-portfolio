from fastapi.testclient import TestClient

from reconcile.api import app

client = TestClient(app)


def test_health():
    r = client.get("/health")
    assert r.status_code == 200
    b = r.json()
    assert b["status"] == "ok"
    assert b["baseline_lines"] > 0 and b["market_codes"] > 0 and b["samples"] > 0


def test_samples_and_baseline_and_rates():
    assert client.get("/samples").json()[0]["name"]
    assert client.get("/baseline").json()["lines"]
    assert client.get("/rates").json()["rates"]


def test_analyze_sample_reports_overcharges():
    r = client.post(
        "/analyze", json={"sample": "change-order-overcharged", "use_llm": False}
    )
    assert r.status_code == 200
    b = r.json()
    assert b["summary"]["flagged_over"] == 3
    assert b["summary"]["recoverable_total"] > 0
    assert b["review_queue"]["count"] >= 3


def test_analyze_freeform_text():
    doc = "Line Items:\n03 30 00 | Concrete | 10 CY | $300.00 | $3,000.00\n"
    r = client.post("/analyze", json={"text": doc, "use_llm": False})
    assert r.status_code == 200
    [ln] = r.json()["lines"]
    assert ln["verdict"] == "over" and ln["recoverable"] > 0


def test_eval_endpoint():
    agg = client.get("/eval").json()["aggregate"]
    assert agg["precision"] == 1.0 and agg["recall"] < 1.0


def test_unknown_sample_404():
    assert client.post("/analyze", json={"sample": "nope"}).status_code == 404


def test_missing_input_422():
    assert client.post("/analyze", json={"use_llm": False}).status_code == 422


def test_unknown_provider_422():
    r = client.post("/analyze", json={"sample": "change-order-clean", "provider": "nope"})
    assert r.status_code == 422
