from fastapi.testclient import TestClient

from rtc_guard.api import app

client = TestClient(app)


def test_health_and_templates():
    b = client.get("/health").json()
    assert b["status"] == "ok" and b["templates"] > 0 and b["threats"] >= 6
    assert "viewer" in client.get("/templates").json()["templates"]


def test_mint_returns_scoped_grant():
    r = client.post("/v1/token", json={"identity": "alice", "room": "room-a",
                                       "template": "publisher", "ttl": 300})
    assert r.status_code == 200
    b = r.json()
    assert b["token"].count(".") == 2
    assert b["claims"]["video"]["room"] == "room-a"
    assert b["claims"]["video"]["canPublish"] is True


def test_verify_valid_and_room_mismatch():
    tok = client.post("/v1/token", json={"identity": "a", "room": "room-a"}).json()
    tok = tok["token"]
    ok = client.post("/v1/verify", json={"token": tok, "expected_room": "room-a"}).json()
    bad = client.post("/v1/verify", json={"token": tok, "expected_room": "room-b"}).json()
    assert ok["valid"] is True and bad["valid"] is False


def test_adversary_all_blocked():
    a = client.get("/adversary").json()
    assert a["block_rate"] == 1.0


def test_threat_model_served():
    assert client.get("/threat-model").json()["count"] >= 6


def test_unknown_template_422():
    assert client.post("/v1/token", json={"template": "root"}).status_code == 422


def test_voice_agent_sample_served():
    r = client.get("/sample/voice-agent")
    assert r.status_code == 200 and "voice agent" in r.text.lower()


def test_grant_audit_flags_over_permissioned():
    r = client.post("/grant/audit", json={
        "identity": "eve", "room": "", "role": "viewer", "ttl": 86_400,
        "roomJoin": True, "canSubscribe": True, "canPublish": True,
        "canPublishData": True})
    assert r.status_code == 200
    b = r.json()
    assert b["least_privilege"] is False
    assert b["by_severity"]["high"] >= 1
    assert b["explanation"]


def test_grant_audit_clean_viewer_is_least_privilege():
    r = client.post("/grant/audit", json={
        "identity": "alice", "room": "room-a", "role": "viewer", "ttl": 300,
        "roomJoin": True, "canSubscribe": True})
    assert r.json()["least_privilege"] is True


def test_evals_endpoint():
    b = client.get("/evals").json()
    assert b["recall"] == 1.0 and b["false_negatives"] == 0


def test_llm_status_endpoint():
    b = client.get("/llm").json()
    assert set(b["providers"]) == {"anthropic", "openai", "ollama", "openrouter"}
    assert b["offline_fallback"] is True
