"""API endpoints via FastAPI's TestClient."""

from fastapi.testclient import TestClient

from doc_extract.api import app

client = TestClient(app)


def test_health():
    body = client.get("/health").json()
    assert body["status"] == "ok" and body["schemas"] == 3


def test_schemas_listing():
    schemas = client.get("/schemas").json()
    names = {s["name"] for s in schemas}
    assert names == {"invoice", "resume", "contact"}
    invoice = next(s for s in schemas if s["name"] == "invoice")
    assert any(f["name"] == "total" and f["type"] == "money" for f in invoice["fields"])


def test_extract_endpoint():
    r = client.post("/extract", json={
        "text": "Invoice #: INV-9\nTotal due: $42.00\nemail: a@b.com",
        "schema": "invoice",
    })
    body = r.json()
    assert body["schema"] == "invoice"
    assert body["total"] == 6  # six invoice fields
    found = {f["name"]: f for f in body["fields"] if f["found"]}
    assert found["invoice_number"]["value"] == "INV-9"
    assert found["total"]["normalized"] == "42.00"
    assert found["vendor_email"]["value"] == "a@b.com"
    assert body["found"] == len(found) >= 3


def test_extract_unknown_schema_422():
    r = client.post("/extract", json={"text": "x", "schema": "nope"})
    assert r.status_code == 422


def test_index_served():
    r = client.get("/")
    assert r.status_code == 200 and "doc-extract" in r.text.lower()
