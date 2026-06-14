import yaml
from fastapi.testclient import TestClient

from baseplate.api import app

client = TestClient(app)


def _reset():
    client.post("/admin/reset")


def test_health():
    b = client.get("/health").json()
    assert b["status"] == "ok"
    assert b["catalog"] >= 2
    assert b["modules"] >= 1


def test_scaffold_from_description_returns_files():
    _reset()
    r = client.post("/scaffold", json={
        "description": "A Python FastAPI service called rate-ingest that reads "
                       "rates from Postgres and serves them over HTTP"}).json()
    assert r["spec"]["name"] == "rate-ingest"
    assert r["spec"]["needs_db"] is True
    assert "Dockerfile" in r["files"]
    # the generated k8s manifest must parse
    yaml.safe_load_all(r["files"]["deploy/k8s/rate-ingest.yaml"])


def test_scaffold_explicit_spec():
    _reset()
    r = client.post("/scaffold", json={
        "name": "billing-api", "language": "go", "needs_db": False}).json()
    assert r["spec"]["name"] == "billing-api"
    assert r["spec"]["language"] == "go"
    assert r["routing"]["provider"] == "explicit"


def test_scaffold_requires_input():
    assert client.post("/scaffold", json={}).status_code == 400


def test_scaffold_client_spec_browser_to_host():
    """Browser→host Ollama path: a client_spec (mode local/auto) is used instead
    of a server LLM call, and is re-validated/normalized like the LLM's output."""
    _reset()
    r = client.post("/scaffold", json={
        "description": "rates api",
        "mode": "local",
        # raw browser input with an alias + messy name + bogus extra key
        "client_spec": {"name": "Rates API!!", "language": "fastapi",
                        "needs_db": "yes", "exposes_http": True, "evil": "x"},
    }).json()
    assert r["routing"]["provider"] == "ollama (browser→host)"
    # server normalized the untrusted raw spec: slugged name, alias→python
    assert r["spec"] == {"name": "rates-api", "language": "python",
                         "needs_db": True, "exposes_http": True}
    assert "Dockerfile" in r["files"]
    assert "rates-api" in r["files"]["Dockerfile"]
    yaml.safe_load_all(r["files"]["deploy/k8s/rates-api.yaml"])


def test_scaffold_client_spec_ignored_for_server_provider():
    """A client_spec is only honored for browser→host modes (local/auto); a
    server-only provider mode (paid/free) ignores it and stays server-side."""
    _reset()
    r = client.post("/scaffold", json={
        "description": "a python worker that reads from postgres",
        "mode": "paid",
        "client_spec": {"name": "sneaky"}}).json()
    assert r["routing"]["provider"] != "ollama (browser→host)"
    assert r["spec"]["name"] != "sneaky"


def test_scaffold_onboards_to_catalog():
    _reset()
    before = client.get("/catalog").json()["count"]
    client.post("/scaffold", json={"name": "payments-svc", "onboard": True})
    after = client.get("/catalog").json()
    assert after["count"] == before + 1
    assert any(s["name"] == "payments-svc"
               and s["onboarded_via"] == "scaffolder"
               for s in after["services"])


def test_catalog_seeded():
    _reset()
    names = {s["name"] for s in client.get("/catalog").json()["services"]}
    assert "rate-ingest" in names and "baseplate" in names


def test_ingest_and_quality():
    r = client.post("/ingest", json={}).json()
    assert r["rows"] > 0
    assert 0.0 <= r["data_quality_pass_rate"] <= 1.0
    q = client.get("/quality").json()
    assert q["data_quality_pass_rate"] == r["data_quality_pass_rate"]


def test_ingest_custom_rows():
    rows = [{"code": "1", "code_type": "CPT", "payer": "P", "rate": 1.0,
             "hospital": "H"}]
    r = client.post("/ingest", json={"rows": rows}).json()
    assert r["data_quality_pass_rate"] == 1.0


def test_slo_includes_data_quality_sli():
    v = client.get("/slo").json()
    names = {s["name"] for s in v["slos"]}
    assert "availability" in names and "data-quality" in names
    dq = next(s for s in v["slos"] if s["name"] == "data-quality")
    assert "current_sli_pct" in dq
    assert v["burn_rate_alerts"]


def test_evals():
    r = client.get("/evals").json()
    assert r["scaffold_total"] >= 1
    assert r["scaffold_pass"] == r["scaffold_total"]
    assert "data_quality" in r


def test_llm_status():
    s = client.get("/llm").json()
    assert set(s["providers"]) == {"anthropic", "openai", "ollama", "openrouter"}


def test_health_exposes_no_secrets():
    blob = str(client.get("/health").json()).lower()
    for token in ("password", "secret", "api_key", "sk-"):
        assert token not in blob
