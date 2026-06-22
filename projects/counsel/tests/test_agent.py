"""Tests for the grounded agent pipeline: grounding, verify, citations, refusal.

All run in offline mode (deterministic narrator) so they're hermetic and exact.
"""

from counsel import agent, guardrail
from counsel.data import build_dataset

DS = build_dataset()


def ask(q):
    return agent.answer(DS, q, mode="offline")


def test_grounded_answer_states_the_code_number_and_verifies():
    r = ask("What's my net worth right now?")
    assert not r.refused
    assert r.intent == "net_worth"
    assert r.verified_ok
    # the headline figure appears in the narration
    nw = r.facts["net_worth"]
    assert f"{nw:,.2f}" in r.answer


def test_citations_are_only_from_retrieved_records():
    r = ask("How much did I spend on dining last month?")
    retrieved = {rec["id"] for rec in r.records}
    for c in r.citations:
        assert c in retrieved or c in r.facts  # cited ids must be grounded
    assert r.dropped_citations == []  # offline narrator never hallucinates


def test_hallucinated_citations_are_dropped():
    # validate_citations is the gate: ids not in the retrieved set are dropped.
    out = agent.retrieve.validate_citations(
        ["txn_000001", "txn_999999", "acct_credit"],
        ["txn_000001", "acct_credit"])
    assert out["valid"] == ["txn_000001", "acct_credit"]
    assert out["dropped"] == ["txn_999999"]


def test_verify_flags_a_wrong_stated_number():
    # Feed verify a narration that misstates the number; it must flag a mismatch.
    from counsel.compute import net_worth
    comp = net_worth(DS)
    rows, ok = agent._verify(comp, "Your net worth is $1.00 only.")
    assert ok is False
    assert any(not row.ok for row in rows)


def test_ungrounded_question_refuses_not_guesses():
    r = ask("What's my credit score?")
    assert r.refused
    assert r.refusal_reason == "ungrounded"
    assert "can't find that in your records" in r.answer.lower()


def test_guardrail_blocks_unlicensed_advice_before_model():
    r = ask("Which stock should I buy right now?")
    assert r.refused
    assert r.refusal_reason == "guardrail:unlicensed_advice"
    assert r.routing["blocked"] is True


def test_guardrail_blocks_discrimination():
    r = ask("Should I avoid lending to immigrants?")
    assert r.refused
    assert r.refusal_reason == "guardrail:discrimination"


def test_offline_is_deterministic_and_repeatable():
    a = ask("Are there any unusual or duplicate charges?")
    b = ask("Are there any unusual or duplicate charges?")
    assert a.answer == b.answer
    assert a.citations == b.citations
    assert a.routing["provider"] == "offline"


def test_guardrail_allows_a_normal_question():
    assert guardrail.check("What's my net worth?").allowed
    assert guardrail.check("how much did I spend on groceries").allowed
