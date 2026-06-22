"""In-process API tests via FastAPI TestClient (offline-pinned, hermetic)."""

import pytest
from fastapi.testclient import TestClient

from counsel.api import QUEUE, app

client = TestClient(app)


@pytest.fixture(autouse=True)
def _offline_and_clean(monkeypatch):
    monkeypatch.setenv("LLM_MODE", "offline")
    QUEUE.reset()
    yield
    QUEUE.reset()


def test_health_ok():
    b = client.get("/health").json()
    assert b["status"] == "ok"
    assert b["accounts"] > 0 and b["transactions"] > 0
    assert b["offline_fallback"] is True


def test_llm_status_shape():
    b = client.get("/llm").json()
    assert set(b["providers"]) == {"anthropic", "openai", "ollama", "openrouter"}
    assert b["offline_fallback"] is True


def test_dataset_summary_has_no_records():
    b = client.get("/dataset").json()
    assert "transactions" in b and isinstance(b["transactions"], int)
    assert "amount" not in str(b)  # counts only, no raw txns


def test_ask_grounded_verifies():
    b = client.post("/ask", json={"question": "What's my net worth?",
                                  "mode": "offline"}).json()
    assert b["refused"] is False
    assert b["intent"] == "net_worth"
    assert b["verified_ok"] is True
    assert b["citations"]


def test_ask_ungrounded_refuses():
    b = client.post("/ask", json={"question": "What's my credit score?",
                                  "mode": "offline"}).json()
    assert b["refused"] is True
    assert b["refusal_reason"] == "ungrounded"


def test_ask_guardrail_refuses():
    b = client.post("/ask", json={"question": "Which stock should I buy?",
                                  "mode": "offline"}).json()
    assert b["refused"] is True
    assert b["refusal_reason"].startswith("guardrail")


def test_ask_unknown_mode_is_422():
    r = client.post("/ask", json={"question": "hi", "mode": "bogus"})
    assert r.status_code == 422


def test_propose_then_pending_then_approve_applies_simulated():
    p = client.post("/propose", json={"kind": "flag_charge"}).json()["proposal"]
    assert p["status"] == "pending"
    # listed as pending
    listed = client.get("/proposals?status=pending").json()["proposals"]
    assert any(x["id"] == p["id"] for x in listed)
    # approve → applied + simulated
    done = client.post("/decide", json={"id": p["id"], "approve": True}
                       ).json()["proposal"]
    assert done["status"] == "applied"
    assert done["effect"]["real_money_moved"] is False


def test_decide_unknown_id_404():
    r = client.post("/decide", json={"id": "prop_nope", "approve": True})
    assert r.status_code == 404


def test_propose_unknown_kind_422():
    r = client.post("/propose", json={"kind": "wire_money"})
    assert r.status_code == 422


def test_diagnostics_offline_all_pass():
    b = client.get("/diagnostics?mode=offline").json()
    m = b["modes"]["offline"]
    assert m["passed"] == m["total"]
    assert m["grounded_verified"] == m["grounded_total"]


def test_examples_endpoint():
    b = client.get("/examples").json()
    assert len(b["examples"]) >= 6
    kinds = {e["kind"] for e in b["examples"]}
    assert {"grounded", "ungrounded", "guardrail"} <= kinds
