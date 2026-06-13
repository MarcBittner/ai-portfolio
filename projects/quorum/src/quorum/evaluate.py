"""Reproducible eval: does contract-review flag the planted risky clauses?

Runs the contract-review workflow over the labeled synthetic contracts in
``data.py`` and scores precision / recall / F1 on exact (clause, risk_class)
matches against the gold labels. A missed planted risk is a **recall** miss —
the safety number for a review tool.

Also asserts the governance invariant: **no raw PII appears in any audit entry**
across every run. Writes ``eval-report.md`` and prints a summary. Deterministic
offline, so the numbers reproduce with zero keys; set provider keys / ``LLM_MODE``
to score a live model on the same labeled set.

Run via ``./run.sh eval`` (or ``python -m quorum.evaluate``).
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from quorum.data import RISK_CLASSES, RISK_LABELS, contract_text, contracts
from quorum.orchestrator import Orchestrator
from quorum.workflows import get_spec, tally_risks

REPORT = Path(__file__).resolve().parents[2] / "eval-report.md"

# Synthetic PII strings planted in the contracts — the audit must never leak them.
_PII_NEEDLES = (
    "legal@northwind-fictional.example", "+1 (415) 555-0142",
    "dpo@aurora-fictional.example", "415-555-0199", "4929114450021188",
)


def run(mode: str | None = None) -> dict:
    spec = get_spec("contract-review")
    tp = fp = fn = 0
    per_class_fn: dict[str, int] = {}
    providers: set[str] = set()
    pii_leaks = 0
    audit_ok = True

    for c in contracts():
        orch = Orchestrator()
        rr = orch.run(spec, {"text": contract_text(c)}, mode=mode)
        for s in rr.trace:
            providers.add(s.provider)
        audit_ok = audit_ok and rr.audit_verified

        # Governance assertion: scan every audit entry for raw PII.
        blob = json.dumps(rr.audit, default=str)
        for needle in _PII_NEEDLES:
            if needle in blob:
                pii_leaks += 1

        # Score flagged risks against gold labels (clause_id, risk_class).
        flagged = _flagged_pairs(rr)
        gold = {(cl["clause_id"], rc) for cl in c["clauses"] for rc in cl["risks"]}
        tp += len(flagged & gold)
        fp += len(flagged - gold)
        fn += len(gold - flagged)
        for miss in gold - flagged:
            per_class_fn[miss[1]] = per_class_fn.get(miss[1], 0) + 1

    precision = tp / (tp + fp) if tp + fp else 1.0
    recall = tp / (tp + fn) if tp + fn else 1.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    return {
        "contracts": len(contracts()),
        "risk_classes": list(RISK_CLASSES),
        "true_positives": tp, "false_positives": fp, "false_negatives": fn,
        "precision": round(precision, 3), "recall": round(recall, 3),
        "f1": round(f1, 3), "missed_by_class": per_class_fn,
        "providers_used": sorted(providers),
        "pii_leaks_in_audit": pii_leaks, "audit_verified": audit_ok,
        "mode": mode or os.environ.get("LLM_MODE", "auto"),
    }


def _flagged_pairs(run_result) -> set[tuple[str, str]]:
    """Re-run the deterministic tally over the parallel scorer outputs."""
    outputs = {s.step: s.output for s in run_result.trace}
    tallied = tally_risks(outputs)
    return {(str(f["clause_id"]), f["risk_class"]) for f in tallied["flagged"]}


def _render(r: dict) -> str:
    lines = [
        "# quorum — eval report",
        "",
        "Reproducible with `./run.sh eval`. Offline (deterministic risk scorers) "
        "by default, so these numbers reproduce exactly with zero keys; set "
        "provider keys or `LLM_MODE` to score a live model on the same labeled set.",
        "",
        "## Contract-review: does it flag the planted risky clauses?",
        "",
        f"The contract-review workflow ran over **{r['contracts']}** synthetic "
        "contracts with known planted risks, scored on exact "
        "`(clause, risk_class)` matches. A missed planted risk is a recall miss — "
        "**recall is the safety metric** for a review tool.",
        "",
        "| metric | value |",
        "| --- | --- |",
        f"| precision | {r['precision']} |",
        f"| recall | {r['recall']} |",
        f"| F1 | {r['f1']} |",
        f"| true positives | {r['true_positives']} |",
        f"| false positives | {r['false_positives']} |",
        f"| false negatives (missed risks) | {r['false_negatives']} |",
        f"| providers used | {', '.join(r['providers_used'])} |",
        "",
        "Risk classes scored (one parallel scorer per class): "
        + ", ".join(f"`{rc}`" for rc in r["risk_classes"]) + ".",
        "",
        "## Governance assertion (every run, every step)",
        "",
        "| check | result |",
        "| --- | --- |",
        f"| raw PII strings found in any audit entry | {r['pii_leaks_in_audit']} |",
        f"| audit hash-chain verified | {'yes' if r['audit_verified'] else 'NO'} |",
        "",
        "> Redaction runs in the orchestrator before the model call and again "
        "before the audit write, so neither a provider nor the tamper-evident "
        "trail ever sees raw PII. This is a property of the engine, not of the "
        "contract-review workflow — it holds for every spec.",
        "",
    ]
    if r["missed_by_class"]:
        lines += ["Missed by class: "
                  + ", ".join(f"{RISK_LABELS.get(k, k)}: {v}"
                              for k, v in r["missed_by_class"].items()), ""]
    return "\n".join(lines)


def main() -> None:
    r = run()
    REPORT.write_text(_render(r))
    print(f"contract-review: precision={r['precision']} recall={r['recall']} "
          f"f1={r['f1']} (tp={r['true_positives']} fp={r['false_positives']} "
          f"fn={r['false_negatives']})")
    print(f"governance: pii_leaks_in_audit={r['pii_leaks_in_audit']} "
          f"audit_verified={r['audit_verified']} "
          f"(providers: {', '.join(r['providers_used'])})")
    print(f"wrote {REPORT}")


if __name__ == "__main__":
    main()
