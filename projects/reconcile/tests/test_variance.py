from reconcile.data import SAMPLES
from reconcile.evaluate import run_eval
from reconcile.extract import parse_table
from reconcile.review import build_queue
from reconcile.variance import reconcile_items


def _analyze(name):
    return reconcile_items(parse_table(SAMPLES[name]))


def test_overcharged_flags_three_lines_with_recovery():
    r = _analyze("change-order-overcharged")
    assert r["summary"]["flagged_over"] == 3
    assert r["summary"]["recoverable_total"] > 0
    overs = [ln for ln in r["lines"] if ln["verdict"] == "over"]
    assert {ln["csi"] for ln in overs} == {"03 30 00", "04 20 00", "23 05 00"}


def test_clean_change_order_is_all_ok():
    r = _analyze("change-order-clean")
    assert r["summary"]["flagged_over"] == 0
    assert r["summary"]["recoverable_total"] == 0
    assert all(ln["verdict"] in ("ok", "new_scope") for ln in r["lines"])


def test_ambiguous_yields_new_scope_and_unknown():
    lines = _analyze("change-order-ambiguous")["lines"]
    verdicts = {ln["csi"]: ln["verdict"] for ln in lines}
    assert verdicts["31 23 16"] == "new_scope"   # added excavation, within market
    assert verdicts["32 13 13"] == "over"        # paving above market high
    assert verdicts["07 21 00"] == "over"        # insulation doubled vs contract
    assert verdicts["09 99 99"] == "unknown"     # no contract/market reference


def test_recoverable_lines_always_need_review():
    # cardinal money-path invariant: any recoverable dollars must be human-reviewed
    for name in SAMPLES:
        for ln in _analyze(name)["lines"]:
            if ln["recoverable"] > 0:
                assert ln["needs_review"] is True


def test_review_queue_is_sorted_by_recoverable_desc():
    reconciled = _analyze("change-order-overcharged")
    q = build_queue(reconciled)
    amounts = [it["recoverable"] for it in q["queue"]]
    assert amounts == sorted(amounts, reverse=True)
    assert q["recoverable_total"] == reconciled["summary"]["recoverable_total"]


def test_eval_recall_below_one_due_to_hidden_prose_line():
    agg = run_eval()["aggregate"]
    assert agg["precision"] == 1.0       # never invents a line
    assert agg["recall"] < 1.0           # misses the prose-hidden item → metric has teeth
    assert 0.0 < agg["f1"] < 1.0
