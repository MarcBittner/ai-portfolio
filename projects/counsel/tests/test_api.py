"""In-process API tests via FastAPI TestClient (offline-pinned, hermetic)."""

import pytest
from fastapi.testclient import TestClient

from counsel import data
from counsel.api import QUEUE, app

client = TestClient(app)


@pytest.fixture(autouse=True)
def _offline_and_clean(monkeypatch):
    monkeypatch.setenv("LLM_MODE", "offline")
    QUEUE.reset()
    data.reset_dataset()
    yield
    QUEUE.reset()
    data.reset_dataset()


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


# --------------------------- data tab: records ---------------------------- #

def test_records_shape_and_seed_flag():
    b = client.get("/records?limit=20").json()
    assert b["accounts"] and all("balance" in a for a in b["accounts"])
    assert b["transactions"] and len(b["transactions"]) <= 20
    t = b["transactions"][0]
    assert {"id", "merchant", "category", "amount", "user_added"} <= set(t)
    # seed ledger: everything is seed (not user-added) on a fresh dataset
    assert all(row["user_added"] is False for row in b["transactions"])
    assert b["totals"]["user_added"] == 0
    assert b["totals"]["seed"] == b["totals"]["transactions"]
    assert "window" in b and "categories" in b


def test_records_filter_by_category():
    b = client.get("/records?category=dining&limit=10").json()
    assert all(t["category"] == "dining" for t in b["transactions"])


def _add(account="acct_credit", date="2025-06-14", merchant="Olive & Vine",
         category="dining", amount=-42.00):
    return client.post("/transactions", json={
        "account_id": account, "date": date, "merchant": merchant,
        "category": category, "amount": amount})


def test_add_transaction_bad_account_is_422():
    assert _add(account="acct_nope").status_code == 422


def test_add_transaction_bad_category_is_422():
    assert _add(category="crypto").status_code == 422


def test_add_transaction_bad_date_is_422():
    assert _add(date="not-a-date").status_code == 422


def test_add_transaction_reflected_in_dataset_and_records():
    before = client.get("/dataset").json()["transactions"]
    r = _add()
    assert r.status_code == 200
    body = r.json()
    assert body["transaction"]["user_added"] is True
    assert body["transaction"]["id"].startswith("txn_user_")
    after = client.get("/dataset").json()["transactions"]
    assert after == before + 1
    # the new row shows up tagged as user-added in /records
    recs = client.get("/records?limit=200").json()
    assert recs["totals"]["user_added"] == 1
    assert any(t["user_added"] for t in recs["transactions"])


def test_add_transaction_increases_category_spend_in_ask():
    q = {"question": "How much did I spend on dining in the last 30 days?",
         "mode": "offline"}
    # baseline dining spend over the trailing 30 days
    base = client.post("/ask", json=q).json()
    assert base["intent"] == "category_spend"
    # add a large in-window dining charge then re-ask the SAME 30-day question
    _add(merchant="Pier 7 Grill", category="dining", amount=-500.00,
         date="2025-06-10")
    after = client.post("/ask", json=q).json()
    assert after["intent"] == "category_spend"
    assert after["verified_ok"] is True
    # the code-computed dining total must have grown by the added charge
    assert after["facts"]["total"] >= base["facts"]["total"] + 499.99


def test_reset_data_restores_seed_counts():
    seed = client.get("/dataset").json()["transactions"]
    _add()
    assert client.get("/dataset").json()["transactions"] == seed + 1
    r = client.post("/admin/reset_data").json()
    assert r["status"] == "reset" and r["user_added"] == 0
    assert client.get("/dataset").json()["transactions"] == seed
    assert client.get("/records").json()["totals"]["user_added"] == 0
