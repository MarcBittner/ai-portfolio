from fastapi.testclient import TestClient

from attack_surface.api import app

client = TestClient(app)


def test_health():
    b = client.get("/health").json()
    assert b["status"] == "ok" and b["controls"] > 0 and b["fixture_findings"] > 0


def test_controls_catalog():
    cs = client.get("/controls").json()["controls"]
    assert any(c["framework"] == "SOC 2" for c in cs)
    assert any(c["framework"] == "ISO 27001" for c in cs)


def test_scan_report():
    r = client.get("/scan").json()
    assert r["findings"] and r["posture"]["grade"]
    assert r["posture"]["controls_failing"] >= 1


def test_post_scan_fixture():
    r = client.post("/scan", json={"mode": "fixture"}).json()
    assert r["mode"] == "fixture" and r["findings"]


def test_invalid_mode_422():
    assert client.post("/scan", json={"mode": "aggressive"}).status_code == 422
