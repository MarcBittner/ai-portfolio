"""API endpoints via FastAPI's TestClient."""

from fastapi.testclient import TestClient

from synth_data.api import app

client = TestClient(app)


def test_health():
    body = client.get("/health").json()
    assert body["status"] == "ok" and body["presets"] == 3 and body["types"] >= 10
    assert "ollama" in body


def test_providers_endpoint():
    assert client.get("/providers").json()["available"]["mock"] is True


def test_schemas_and_types():
    presets = {p["name"] for p in client.get("/schemas").json()}
    assert presets == {"users", "transactions", "support_tickets"}
    types = {t["name"] for t in client.get("/types").json()}
    assert {"email", "phone", "integer", "date", "llm"} <= types


def test_llm_field_mock_falls_back_to_placeholder():
    # provider=mock -> deterministic placeholder; routing reported
    body = client.post("/generate", json={
        "fields": [{"name": "review", "type": "llm", "description": "a short review"}],
        "n": 3, "seed": 1, "use_llm": True, "provider": "mock"}).json()
    assert body["routing"]["provider"] == "mock"
    assert len(body["rows"]) == 3 and all(r["review"] for r in body["rows"])


def test_generate_preset_json():
    body = client.post("/generate", json={"preset": "users", "n": 5, "seed": 42}).json()
    assert body["n"] == 5 and body["seed"] == 42
    assert "email" in body["columns"]
    assert len(body["rows"]) == 5
    assert all("@example." in r["email"] for r in body["rows"])


def test_generate_is_reproducible():
    a = client.post("/generate", json={"preset": "users", "n": 5, "seed": 99}).json()
    b = client.post("/generate", json={"preset": "users", "n": 5, "seed": 99}).json()
    assert a["rows"] == b["rows"]


def test_generate_custom_fields():
    body = client.post("/generate", json={
        "fields": [{"name": "n", "type": "integer", "min": 1, "max": 3}],
        "n": 4, "seed": 1}).json()
    assert all(1 <= r["n"] <= 3 for r in body["rows"])


def test_generate_csv_format():
    r = client.post("/generate", json={"preset": "users", "n": 2, "format": "csv"})
    assert r.headers["content-type"].startswith("text/csv")
    assert r.text.splitlines()[0].startswith("id,name,email")


def test_generate_unknown_preset_422():
    assert client.post("/generate", json={"preset": "nope"}).status_code == 422


def test_generate_requires_preset_or_fields_422():
    assert client.post("/generate", json={"n": 5}).status_code == 422


def test_index_served():
    r = client.get("/")
    assert r.status_code == 200 and "synth-data" in r.text.lower()
