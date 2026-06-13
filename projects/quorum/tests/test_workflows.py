"""The shipped specs: contract-review flags planted risks; policy-qa is grounded."""

from quorum.data import contract_text, contracts, get_contract
from quorum.orchestrator import Orchestrator
from quorum.workflows import get_spec, registry, tally_risks


def _flagged(rr):
    tally = tally_risks({s.step: s.output for s in rr.trace})
    return {(str(f["clause_id"]), f["risk_class"]) for f in tally["flagged"]}


def test_registry_has_both_workflows():
    reg = registry()
    assert "contract-review" in reg
    assert "policy-qa" in reg


def test_contract_review_dag_shape():
    spec = get_spec("contract-review")
    names = spec.step_names()
    assert names[0] == "clause_extractor"
    assert names[-1] == "redline_drafter"
    # one parallel risk scorer per risk class
    assert sum(1 for n in names if n.startswith("risk_")) == 5


def test_contract_review_flags_all_planted_risks():
    spec = get_spec("contract-review")
    total_gold = total_tp = 0
    for c in contracts():
        rr = Orchestrator().run(spec, {"text": contract_text(c)})
        flagged = _flagged(rr)
        gold = {(cl["clause_id"], rc) for cl in c["clauses"] for rc in cl["risks"]}
        total_gold += len(gold)
        total_tp += len(flagged & gold)
        # recall is the safety metric: no planted risk is missed
        assert gold <= flagged, f"{c['id']} missed {gold - flagged}"
    assert total_tp == total_gold and total_gold > 0


def test_contract_review_does_not_flag_benign_clause():
    # saas-002 clause 4 is a liability CAP — must NOT be flagged as unlimited.
    c = get_contract("saas-002")
    rr = Orchestrator().run(get_spec("contract-review"), {"text": contract_text(c)})
    flagged = _flagged(rr)
    assert ("4", "unlimited_liability") not in flagged


def test_contract_review_synthesis_summary_present():
    c = get_contract("msa-001")
    rr = Orchestrator().run(get_spec("contract-review"), {"text": contract_text(c)})
    assert rr.result.get("summary")
    assert rr.result.get("redlines")


def test_policy_qa_same_engine_different_spec():
    rr = Orchestrator().run(
        get_spec("policy-qa"),
        {"question": "What is the refund window?"})
    assert [s.step for s in rr.trace] == ["retriever", "answerer", "citation_checker"]
    assert "refund" in rr.trace[1].output.get("cited", []) or \
        "30 days" in rr.result.get("answer", "")
    # citation check confirms the answer is grounded in retrieved passages
    assert rr.result.get("grounded") is True
