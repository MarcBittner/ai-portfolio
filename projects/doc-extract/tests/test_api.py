"""API endpoints via FastAPI's TestClient."""

from fastapi.testclient import TestClient

from doc_extract.api import app

client = TestClient(app)


def test_health():
    body = client.get("/health").json()
    assert body["status"] == "ok" and body["schemas"] == 3
    assert "ollama" in body


def test_providers_endpoint():
    assert client.get("/providers").json()["available"]["mock"] is True


def test_schemas_listing():
    schemas = client.get("/schemas").json()
    names = {s["name"] for s in schemas}
    assert names == {"invoice", "resume", "contact"}
    invoice = next(s for s in schemas if s["name"] == "invoice")
    assert any(f["name"] == "total" and f["type"] == "money" for f in invoice["fields"])


def test_extract_endpoint_deterministic():
    r = client.post("/extract", json={
        "text": "Invoice #: INV-9\nTotal due: $42.00\nemail: a@b.com",
        "schema": "invoice", "use_llm": False,
    })
    body = r.json()
    assert body["schema"] == "invoice"
    assert body["total"] == 6  # six invoice fields
    found = {f["name"]: f for f in body["fields"] if f["found"]}
    assert found["invoice_number"]["value"] == "INV-9"
    assert found["total"]["normalized"] == "42.00"
    assert found["vendor_email"]["value"] == "a@b.com"
    assert body["found"] == len(found) >= 3
    assert body["routing"] is None  # no LLM pass


def test_llm_fill_mock_changes_nothing():
    # provider=mock -> no fill, but routing reported; deterministic results stand
    r = client.post("/extract", json={
        "text": "Invoice #: INV-9", "schema": "invoice",
        "use_llm": True, "provider": "mock"}).json()
    assert r["routing"]["provider"] == "mock"
    found = {f["name"] for f in r["fields"] if f["found"]}
    assert "invoice_number" in found  # regex still works
    assert all(f["method"] != "llm" for f in r["fields"] if f["found"])


def test_client_fields_browser_to_host():
    # Browser ran the LLM on the user's host Ollama and submitted the filled
    # fields; the server uses them instead of a server-side provider and reports
    # browser→host routing. Deterministic extraction still runs first.
    doc = "Invoice #: INV-9\nTotal due: $42.00"  # no email in the doc
    r = client.post("/extract", json={
        "text": doc, "schema": "invoice", "use_llm": True,
        "provider": "local",  # not a server provider — must not 422 with client_fields
        "client_fields": [{"name": "vendor_email", "value": "sales@acme.com"}],
    }).json()
    assert r["routing"]["provider"] == "ollama (browser→host)"
    found = {f["name"]: f for f in r["fields"] if f["found"]}
    assert found["invoice_number"]["value"] == "INV-9"      # deterministic, ran first
    assert found["vendor_email"]["value"] == "sales@acme.com"  # browser-supplied
    assert found["vendor_email"]["method"] == "llm"


def test_client_fields_unreachable_falls_back_to_server():
    # Absent client_fields -> today's behavior unchanged (server LLM path / mock).
    r = client.post("/extract", json={
        "text": "Invoice #: INV-9", "schema": "invoice",
        "use_llm": True, "provider": "mock"}).json()
    assert r["routing"]["provider"] == "mock"


def test_extract_unknown_schema_422():
    r = client.post("/extract", json={"text": "x", "schema": "nope"})
    assert r.status_code == 422


def test_index_served():
    r = client.get("/")
    assert r.status_code == 200 and "doc-extract" in r.text.lower()
