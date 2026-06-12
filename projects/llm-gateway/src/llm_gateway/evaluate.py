"""Governance eval — the guardrails are tested, not asserted.

Runs the labeled prompts through the firewall and reports how well it separates
malicious from benign inputs and leaking from clean outputs: detection rate
(recall on the bad), false-positive rate (benign tripped), and overall accuracy.
A regression that weakened the firewall would show up here.
"""

from llm_gateway import firewall
from llm_gateway.data import EVAL_INPUTS, EVAL_OUTPUTS


def _score(samples: list[dict], direction: str, bad_label: str) -> dict:
    tp = fp = tn = fn = 0
    for s in samples:
        flagged = firewall.scan(s["text"], direction).verdict in ("flag", "block")
        bad = s["label"] == bad_label
        if bad and flagged:
            tp += 1
        elif bad and not flagged:
            fn += 1
        elif not bad and flagged:
            fp += 1
        else:
            tn += 1
    n_bad, n_good = tp + fn, fp + tn
    return {
        "samples": len(samples),
        "detection_rate": round(tp / n_bad, 4) if n_bad else 0.0,   # recall on bad
        "false_positive_rate": round(fp / n_good, 4) if n_good else 0.0,
        "accuracy": round((tp + tn) / len(samples), 4) if samples else 0.0,
    }


def run_eval() -> dict:
    inp = _score(EVAL_INPUTS, "input", "malicious")
    out = _score(EVAL_OUTPUTS, "output", "leak")
    return {
        "input_firewall": inp,
        "output_firewall": out,
        "summary": {
            "input_detection_rate": inp["detection_rate"],
            "input_false_positive_rate": inp["false_positive_rate"],
            "output_detection_rate": out["detection_rate"],
        },
    }
