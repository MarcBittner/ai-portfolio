from fastapi.testclient import TestClient

from slo_kit.api import app

client = TestClient(app)


def _reset():
    client.post("/admin/reset")


def test_health():
    _reset()
    b = client.get("/health").json()
    assert b["status"] == "ok" and b["slo_status"] in ("healthy", "no_data")


def test_send_message_200():
    _reset()
    r = client.post("/v1/messages", json={"channel": "email", "to": "a@example.com"})
    assert r.status_code == 200
    assert client.get("/v1/messages").json()["sent"]


def test_metrics_exposition():
    _reset()
    client.post("/admin/loadtest", json={"n": 10})
    assert "slo_requests_total" in client.get("/metrics").text


def test_slo_endpoint_structure():
    _reset()
    s = client.get("/slo").json()
    assert {"availability", "latency", "overall_status"} <= set(s)


def test_incident_burns_then_recovers():
    _reset()
    healthy = client.post("/admin/loadtest", json={"n": 200}).json()
    assert healthy["overall_status"] == "healthy"
    client.post("/admin/fault", json={"error_rate": 0.5, "latency_ms": 500})
    burned = client.post("/admin/loadtest", json={"n": 200}).json()
    assert burned["overall_status"] == "at_risk"
    assert burned["availability"]["burn_rate"] > 1
    recovered = client.post("/admin/reset").json()
    assert recovered["slo"]["overall_status"] == "healthy"


def test_traces_endpoint():
    _reset()
    client.post("/admin/loadtest", json={"n": 5})
    assert client.get("/traces").json()["spans"]


def test_fault_validation():
    assert client.post("/admin/fault", json={"error_rate": 2.0}).status_code == 422
