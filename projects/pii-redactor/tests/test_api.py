"""API endpoints via FastAPI's TestClient.

Regex-core tests pin ``use_llm=false`` so they're hermetic regardless of whether
Ollama happens to be running; the LLM path is tested via ``provider="mock"``.
"""

from fastapi.testclient import TestClient

from pii_redactor.api import app

client = TestClient(app)


def test_health():
    body = client.get("/health").json()
    assert body["status"] == "ok"
    assert body["types"] >= 7
    assert "token" in body["styles"]
    assert "ollama" in body  # reachability reported


def test_providers_endpoint():
    body = client.get("/providers").json()
    assert body["available"]["mock"] is True
    assert "ollama" in body["available"]
    assert body["default_order"][-1] == "mock"  # mock is the terminal fallback


def test_types_listing_includes_llm_types():
    types = client.get("/types").json()
    names = {t["name"] for t in types}
    assert {"EMAIL", "SSN", "CREDIT_CARD"} <= names
    assert {"PERSON", "ORG", "LOCATION"} <= names
    assert any(t["source"] == "llm" for t in types)


def test_detect_regex_core():
    r = client.post("/detect", json={
        "text": "mail a@b.com, ssn 123-45-6789", "use_llm": False})
    body = r.json()
    assert body["total"] == 2
    assert body["counts"] == {"EMAIL": 1, "SSN": 1}
    assert {s["type"] for s in body["spans"]} == {"EMAIL", "SSN"}
    assert all(s["source"] == "regex" for s in body["spans"])
    assert body["routing"] is None


def test_redact_regex_core():
    r = client.post("/redact", json={
        "text": "card 4111 1111 1111 1111", "style": "label", "use_llm": False})
    body = r.json()
    assert body["redacted"] == "card <CREDIT_CARD>"
    assert body["total"] == 1 and body["style"] == "label"


def test_llm_path_with_mock_falls_back_to_regex():
    # provider=mock -> no entities returned, but routing is reported
    r = client.post("/detect", json={
        "text": "Jane from Acme: a@b.com", "use_llm": True, "provider": "mock"})
    body = r.json()
    assert body["routing"]["provider"] == "mock"
    assert any(s["type"] == "EMAIL" for s in body["spans"])     # regex still works
    assert all(s["source"] == "regex" for s in body["spans"])   # mock adds nothing


def test_redact_unknown_style_422():
    r = client.post("/redact", json={"text": "a@b.com", "style": "nope"})
    assert r.status_code == 422


def test_detect_unknown_type_422():
    r = client.post("/detect", json={
        "text": "a@b.com", "types": ["EMAIL", "BOGUS"], "use_llm": False})
    assert r.status_code == 422


def test_unknown_provider_422():
    r = client.post("/detect", json={"text": "x", "provider": "bogus"})
    assert r.status_code == 422


def test_index_served():
    assert "pii-redactor" in client.get("/").text.lower()
