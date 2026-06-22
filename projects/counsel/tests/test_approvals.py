"""Tests for the trust-gated approval queue — the agency boundary.

The cardinal invariant: a proposal cannot reach ``applied`` without an explicit
approval, and applying is simulated (never mutates ground truth).
"""

import pytest

from counsel import approvals, compute
from counsel.approvals import ApprovalQueue
from counsel.data import build_dataset

DS = build_dataset()


def fresh():
    return ApprovalQueue()


def test_proposal_starts_pending_and_changes_nothing():
    q = fresh()
    built = approvals.build_flag_charge(DS)
    p = q.propose(*built)
    assert p.status == "pending"
    assert p.effect is None


def test_apply_only_after_approval_and_is_simulated():
    q = fresh()
    before = compute.net_worth(DS).answer_number
    p = q.propose(*approvals.build_flag_charge(DS))
    done = q.decide(p.id, approve=True, ds=DS)
    assert done.status == "applied"
    assert done.effect["real_money_moved"] is False
    # ground truth unchanged
    assert compute.net_worth(DS).answer_number == before


def test_decline_is_terminal():
    q = fresh()
    p = q.propose(*approvals.build_set_budget(DS))
    done = q.decide(p.id, approve=False, ds=DS)
    assert done.status == "declined"
    assert done.effect is None


def test_double_decide_is_refused():
    q = fresh()
    p = q.propose(*approvals.build_flag_charge(DS))
    q.decide(p.id, approve=True, ds=DS)
    with pytest.raises(ValueError):
        q.decide(p.id, approve=False, ds=DS)


def test_unknown_id_raises():
    q = fresh()
    with pytest.raises(KeyError):
        q.decide("prop_nope", approve=True, ds=DS)


def test_only_typed_action_kinds_can_be_proposed():
    q = fresh()
    with pytest.raises(ValueError):
        q.propose("transfer_all_funds", "evil", "", {}, [])


def test_builders_are_code_derived_and_cited():
    for builder in (approvals.build_flag_charge, approvals.build_set_budget,
                    approvals.build_recommend_rebalance):
        built = builder(DS)
        assert built is not None
        kind, title, rationale, params, cites = built
        assert kind in approvals.ACTION_KINDS
        assert title and rationale
        assert isinstance(cites, list)


def test_rebalance_proposal_is_mechanical_not_advice():
    built = approvals.build_recommend_rebalance(DS)
    _, _, rationale, params, _ = built
    assert "not investment advice" in rationale.lower()
    assert "drift_pct" in params
