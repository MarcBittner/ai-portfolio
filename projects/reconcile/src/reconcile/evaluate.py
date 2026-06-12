"""Extraction-accuracy eval — accuracy measured, not asserted.

Runs the deterministic extractor over the labeled sample documents and scores it
against the ground truth: line-level precision / recall / F1 (matched by CSI),
plus unit-cost exactness on matched lines. The ambiguous sample deliberately
hides one line item in prose, so recall is < 1.0 — proof the metric has teeth and
would catch an extractor regression.
"""

from reconcile.data import GROUND_TRUTH, SAMPLES
from reconcile.extract import parse_table

UNIT_COST_TOL = 0.01  # relative tolerance for "unit cost matches"


def _score_doc(name: str) -> dict:
    truth = {row["csi"]: row for row in GROUND_TRUTH[name]}
    extracted = {it.csi: it for it in parse_table(SAMPLES[name])}

    matched = set(truth) & set(extracted)
    correct_cost = 0
    for csi in matched:
        gt = truth[csi]["unit_cost"]
        got = extracted[csi].unit_cost
        if gt == 0:
            correct_cost += int(got == 0)
        elif abs(got - gt) / gt <= UNIT_COST_TOL:
            correct_cost += 1

    precision = len(matched) / len(extracted) if extracted else 0.0
    recall = len(matched) / len(truth) if truth else 0.0
    f1 = (2 * precision * recall / (precision + recall)) if (precision + recall) else 0.0
    return {
        "document": name,
        "ground_truth_lines": len(truth),
        "extracted_lines": len(extracted),
        "matched_lines": len(matched),
        "missed": sorted(set(truth) - set(extracted)),
        "precision": round(precision, 4),
        "recall": round(recall, 4),
        "f1": round(f1, 4),
        "unit_cost_accuracy": round(correct_cost / len(matched), 4) if matched else 0.0,
    }


def run_eval() -> dict:
    """Score extraction over every labeled sample; return per-doc + aggregate."""
    per_doc = [_score_doc(name) for name in GROUND_TRUTH]
    tp = sum(d["matched_lines"] for d in per_doc)
    gt = sum(d["ground_truth_lines"] for d in per_doc)
    ex = sum(d["extracted_lines"] for d in per_doc)
    precision = tp / ex if ex else 0.0
    recall = tp / gt if gt else 0.0
    f1 = (2 * precision * recall / (precision + recall)) if (precision + recall) else 0.0
    return {
        "documents": per_doc,
        "aggregate": {
            "documents": len(per_doc),
            "precision": round(precision, 4),
            "recall": round(recall, 4),
            "f1": round(f1, 4),
        },
    }
