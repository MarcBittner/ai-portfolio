"""Tests for the browser→host Ollama bridge: prepare + finalize.

These are fully hermetic and offline — no real Ollama is touched. The browser's
narration is simulated by driving the finalize path (``client_summary``)
directly, which is the trust-critical surface: the server recomputes every fact
and verifies the client text against it. A correct narration verifies; a hostile
one (wrong number / hallucinated citation) is caught exactly as a cloud model's
would be.
"""

import json

import pytest
from fastapi.testclient import TestClient

from counsel import agent, data
from counsel.api import QUEUE, app
from counsel.data import build_dataset

client = TestClient(app)
DS = build_dataset()


@pytest.fixture(autouse=True)
def _offline_and_clean(monkeypatch):
    monkeypatch.setenv("LLM_MODE", "offline")
    QUEUE.reset()
    data.reset_dataset()
    yield
    QUEUE.reset()
    data.reset_dataset()


# --------------------------------------------------------------------------- #
# prepare: returns the prompt for a grounded ask, a refusal otherwise          #
# --------------------------------------------------------------------------- #

def test_prepare_returns_prompt_for_grounded_question():
    p = agent.prepare(DS, "What's my net worth right now?")
    assert p.refusal is None
    assert p.intent == "net_worth"
    assert p.system_prompt == agent.SYSTEM
    assert "FACTS" in p.user_prompt and "RECORD IDS" in p.user_prompt
    assert p.citation_ids  # something to cite
    d = p.to_dict()
    assert d["refused"] is False
    assert d["system_prompt"] and d["user_prompt"]


def test_prepare_endpoint_grounded_returns_prompt_no_narration():
    b = client.post("/ask/prepare",
                    json={"question": "What's my net worth right now?",
                          "mode": "local"}).json()
    assert b["refused"] is False
    assert b["intent"] == "net_worth"
    # the server returns the exact prompt — it did NOT narrate / call a provider
    assert "answer" not in b
    assert b["system_prompt"].startswith("You are counsel")


def test_prepare_refuses_guardrail_without_narration():
    p = agent.prepare(DS, "Which stock should I buy right now?")
    assert p.refusal is not None
    assert p.refusal.refusal_reason == "guardrail:unlicensed_advice"
    d = p.to_dict()
    assert d["refused"] is True
    assert "system_prompt" not in d  # nothing to narrate
    assert d["result"]["refused"] is True


def test_prepare_refuses_ungrounded_without_narration():
    b = client.post("/ask/prepare",
                    json={"question": "What's my credit score?",
                          "mode": "local"}).json()
    assert b["refused"] is True
    assert b["result"]["refusal_reason"] == "ungrounded"
    assert "user_prompt" not in b


# --------------------------------------------------------------------------- #
# finalize: client_summary is verified against server-recomputed facts         #
# --------------------------------------------------------------------------- #

def _good_summary(question):
    """The narration a faithful local model would return (right facts + ids)."""
    p = agent.prepare(DS, question)
    assert p.refusal is None
    # reuse the deterministic offline narrator as a stand-in for the host model
    r, comp = agent.retrieve.route(DS, question)
    text = agent._offline_narration(comp, r)
    return json.dumps({"answer": text, "citations": comp.citation_ids})


def test_finalize_with_good_client_summary_verifies():
    q = "What's my net worth right now?"
    r = agent.answer(DS, q, mode="local", client_summary=_good_summary(q),
                     client_model="llama3.1:8b")
    assert not r.refused
    assert r.intent == "net_worth"
    assert r.verified_ok is True
    assert r.routing["provider"] == "ollama (browser→host)"
    assert r.routing["model"] == "llama3.1:8b"
    assert r.dropped_citations == []


def test_finalize_endpoint_reports_browser_host_label():
    q = "What's my net worth right now?"
    b = client.post("/ask", json={"question": q, "mode": "local",
                                   "client_summary": _good_summary(q),
                                   "model": "qwen2:7b"}).json()
    assert b["routing"]["provider"] == "ollama (browser→host)"
    assert b["routing"]["model"] == "qwen2:7b"
    assert b["verified_ok"] is True


def test_finalize_catches_a_wrong_number_in_client_summary():
    # A hostile/garbled local narration states a bogus net worth. The server
    # recomputed the real figure, so verify must flag the mismatch — the client
    # text is never trusted blindly.
    q = "What's my net worth right now?"
    bad = json.dumps({"answer": "Your net worth is $1.00.", "citations": []})
    r = agent.answer(DS, q, mode="local", client_summary=bad)
    assert not r.refused
    assert r.verified_ok is False
    assert any(not row.ok for row in r.verify)
    # the code-computed value, not the client's bogus one, is what's shown
    assert r.facts["net_worth"] != 1.0


def test_finalize_drops_a_hallucinated_citation_in_client_summary():
    q = "How much did I spend on dining last month?"
    real = agent.prepare(DS, q)
    good_cites = real.citation_ids
    # client cites one real id and one fabricated id
    bad = json.dumps({"answer": good_cites and "ok" or "ok",
                      "citations": [*good_cites[:1], "txn_999999"]})
    r = agent.answer(DS, q, mode="local", client_summary=bad)
    assert "txn_999999" in r.dropped_citations
    assert "txn_999999" not in r.citations


def test_finalize_still_refuses_guardrail_even_with_client_summary():
    # Trust boundary: a client can't smuggle an answer past the guardrail by
    # supplying client_summary — the server re-runs the guardrail itself.
    bad = json.dumps({"answer": "Buy NVDA now.", "citations": []})
    r = agent.answer(DS, "Which stock should I buy right now?",
                     mode="local", client_summary=bad)
    assert r.refused
    assert r.refusal_reason == "guardrail:unlicensed_advice"
    # the client's smuggled narration never reaches the user
    assert "NVDA" not in r.answer


def test_finalize_still_refuses_ungrounded_even_with_client_summary():
    bad = json.dumps({"answer": "Your credit score is 800.", "citations": []})
    r = agent.answer(DS, "What's my credit score?", mode="local",
                     client_summary=bad)
    assert r.refused
    assert r.refusal_reason == "ungrounded"
    assert "800" not in r.answer
