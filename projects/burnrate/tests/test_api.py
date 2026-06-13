"""Flask test-client coverage of the API surface and the burn→recover loop."""

import pytest

from burnrate import create_app, service


@pytest.fixture
def client():
    app = create_app()
    app.testing = True
    service.reset()
    with app.test_client() as c:
        yield c
    service.reset()


def test_healthz(client):
    r = client.get("/healthz")
    assert r.status_code == 200
    body = r.get_json()
    assert body["status"] == "ok"
    assert body["task_backend"] in ("tasktiger", "redis", "inline")


def test_outreach_send_and_outbox(client):
    r = client.post("/v1/outreach", json={"channel": "sms", "to": "x", "body": "hi"})
    assert r.status_code == 200
    assert r.get_json()["channel"] == "sms"
    assert client.get("/v1/outreach").get_json()["sent"]


def test_metrics_is_prometheus(client):
    client.post("/admin/loadtest", json={"n": 30})
    r = client.get("/metrics")
    assert r.status_code == 200
    assert "text/plain" in r.content_type
    assert b"burnrate_requests_total" in r.data


def test_slo_endpoint(client):
    client.post("/admin/loadtest", json={"n": 50})
    s = client.get("/slo").get_json()
    assert s["availability"]["status"] == "healthy"
    assert s["burn_policy"]["action"] == "none"


def test_inject_burns_then_reset_recovers(client):
    client.post("/admin/inject", json={"error_rate": 0.08, "latency_ms": 450})
    burning = client.post("/admin/loadtest", json={"n": 300}).get_json()
    assert burning["burn_policy"]["action"] == "page"
    assert burning["availability"]["status"] == "exhausted"

    recovered = client.post("/admin/reset").get_json()
    client.post("/admin/loadtest", json={"n": 300})
    recovered = client.get("/slo").get_json()
    assert recovered["overall_status"] == "healthy"
    assert recovered["burn_policy"]["action"] == "none"


def test_incident_summary_offline(client):
    client.post("/admin/inject", json={"error_rate": 0.08})
    client.post("/admin/loadtest", json={"n": 300})
    r = client.post("/incident/summary", json={"mode": "offline"})
    body = r.get_json()
    assert body["severity"] == "sev1"
    assert body["provider"] == "offline"
    assert len(body["suggested_steps"]) >= 3


def test_tasks_endpoints(client):
    t = client.get("/tasks").get_json()
    assert "process_batch" in t["registered"]
    r = client.post("/tasks/process_batch", json={"n": 40}).get_json()
    assert r["task"] == "process_batch"
    assert client.get("/slo").get_json()["window_requests"] == 40


def test_evals_and_llm(client):
    assert client.get("/evals").get_json()["severity_accuracy"] >= 0.99
    assert "providers" in client.get("/llm").get_json()


def test_dashboard_served(client):
    r = client.get("/")
    assert r.status_code == 200
    assert b"burnrate" in r.data
