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


def _table(fw: dict) -> str:
    return (
        "| metric | value |\n| --- | --- |\n"
        f"| samples | {fw['samples']} |\n"
        f"| detection rate (recall on bad) | {fw['detection_rate']} |\n"
        f"| false-positive rate | {fw['false_positive_rate']} |\n"
        f"| accuracy | {fw['accuracy']} |\n"
    )


def render_report() -> str:
    """Render the committed eval-report.md from a fresh run over the labeled set."""
    r = run_eval()
    return (
        "# llm-gateway — eval report\n\n"
        "Reproducible with `./run.sh eval`. The guardrails are deterministic "
        "(regex firewall + redaction detectors — no model, no network), so these "
        "numbers reproduce exactly with zero keys and zero cost.\n\n"
        "The labeled set in `data.py` is a **regulated advisor copilot**: benign "
        "advisor work vs. prompt-injection / jailbreak / exfiltration on the way "
        "in, and clean responses vs. client-PII or credential leaks on the way "
        "out. **Detection rate is the safety metric** — a missed malicious input "
        "or leaking output is a governance failure.\n\n"
        "## Input firewall (prompt-injection / jailbreak / exfiltration)\n\n"
        f"Scored over **{r['input_firewall']['samples']}** labeled prompts.\n\n"
        f"{_table(r['input_firewall'])}\n"
        "## Output firewall (client-PII / credential leakage)\n\n"
        f"Scored over **{r['output_firewall']['samples']}** labeled responses, "
        "reusing the redaction detectors (a secret hit is `critical`, PII is "
        "`medium`).\n\n"
        f"{_table(r['output_firewall'])}\n"
        "> The firewall is rules-based, so it is exact on this synthetic set; the "
        "value of the eval is as a **regression gate** — weakening a rule shows up "
        "here as a measurable drop, not a silent gap. Redaction findings carry "
        "only type + count, never the matched value, on every branch.\n"
    )


def main() -> None:
    from pathlib import Path
    out = Path(__file__).resolve().parents[2] / "eval-report.md"
    report = render_report()
    out.write_text(report)
    print(report)
    print(f"\nWrote {out}")


if __name__ == "__main__":
    main()
