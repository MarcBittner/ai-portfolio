"""API endpoints via FastAPI's TestClient."""

from fastapi.testclient import TestClient

from pii_redactor.api import app

client = TestClient(app)


def test_health():
    body = client.get("/health").json()
    assert body["status"] == "ok"
    assert body["types"] >= 7
    assert "token" in body["styles"]


def test_types_listing():
    types = client.get("/types").json()
    names = {t["name"] for t in types}
    assert {"EMAIL", "SSN", "CREDIT_CARD"} <= names
    assert all(t["description"] for t in types)


def test_detect_endpoint_returns_spans_and_counts():
    r = client.post("/detect", json={"text": "mail a@b.com, ssn 123-45-6789"})
    body = r.json()
    assert body["total"] == 2
    assert body["counts"] == {"EMAIL": 1, "SSN": 1}
    kinds = {s["type"] for s in body["spans"]}
    assert kinds == {"EMAIL", "SSN"}
    # spans are valid offsets into the text
    first = body["spans"][0]
    assert 0 <= first["start"] < first["end"]


def test_redact_endpoint():
    r = client.post(
        "/redact", json={"text": "card 4111 1111 1111 1111", "style": "label"}
    )
    body = r.json()
    assert body["redacted"] == "card <CREDIT_CARD>"
    assert body["total"] == 1 and body["style"] == "label"


def test_redact_unknown_style_422():
    r = client.post("/redact", json={"text": "a@b.com", "style": "nope"})
    assert r.status_code == 422


def test_detect_unknown_type_422():
    r = client.post("/detect", json={"text": "a@b.com", "types": ["EMAIL", "BOGUS"]})
    assert r.status_code == 422


def test_index_served():
    r = client.get("/")
    assert r.status_code == 200
    assert "pii-redactor" in r.text.lower()
