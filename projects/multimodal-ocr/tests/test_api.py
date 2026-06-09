"""API endpoints via FastAPI's TestClient."""

from fastapi.testclient import TestClient

from multimodal_ocr.api import app

client = TestClient(app)


def test_health():
    body = client.get("/health").json()
    assert body["status"] == "ok" and body["samples"] == 2
    assert body["ocr_backend"] in {"tesseract", "samples-only"}
    assert "ollama" in body


def test_providers_endpoint():
    assert client.get("/providers").json()["available"]["mock"] is True


def test_samples_listing():
    samples = client.get("/samples").json()
    names = {s["name"] for s in samples}
    assert names == {"receipt", "intake_form"}
    assert all(s["tokens"] for s in samples)  # tokens have boxes


def test_process_sample_deterministic():
    body = client.post("/process", json={"sample": "receipt", "use_llm": False}).json()
    assert body["counts"].get("EMAIL") == 1
    assert body["boxes"], "redaction boxes returned"
    assert "[EMAIL]" in body["redacted_text"]
    assert len(body["tokens"]) > 0
    assert body["routing"] is None


def test_llm_ner_mock_adds_nothing():
    # provider=mock -> no extra entities; routing reported; regex stands
    body = client.post("/process", json={
        "sample": "receipt", "use_llm": True, "provider": "mock"}).json()
    assert body["routing"]["provider"] == "mock"
    assert body["counts"].get("EMAIL") == 1


def test_process_tokens_directly():
    tokens = [
        {"text": "mail", "x": 0, "y": 0, "w": 36, "h": 20},
        {"text": "a@b.com", "x": 45, "y": 0, "w": 63, "h": 20},
    ]
    body = client.post("/process", json={"tokens": tokens, "use_llm": False}).json()
    assert body["counts"].get("EMAIL") == 1
    assert len(body["boxes"]) == 1 and body["boxes"][0]["x"] == 45


def test_process_requires_sample_or_tokens_422():
    assert client.post("/process", json={}).status_code == 422


def test_process_unknown_sample_422():
    assert client.post("/process", json={"sample": "nope"}).status_code == 422


def test_ocr_without_backend_is_422():
    # no tesseract in the test env -> graceful 422, not a crash
    import base64
    img = base64.b64encode(b"not really an image").decode()
    r = client.post("/ocr", json={"image_b64": img})
    assert r.status_code == 422


def test_index_served():
    r = client.get("/")
    assert r.status_code == 200 and "multimodal-ocr" in r.text.lower()
