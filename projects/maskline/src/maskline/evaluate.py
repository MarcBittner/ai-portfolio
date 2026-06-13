"""Reproducible eval: column-classification precision/recall + policy coverage +
the control-mapping invariant.

Writes ``eval-report.md`` at the project root and prints a summary. Run via
``./run.sh eval`` (or ``python -m maskline.evaluate``). Deterministic offline by
default, so the report reproduces to the digit with zero keys; set ``LLM_MODE`` or
provider keys to score a live model on free-text classification instead.
"""

from __future__ import annotations

import os
from pathlib import Path

from maskline import classify, controls, policy, risk, warehouse

REPORT = Path(__file__).resolve().parents[2] / "eval-report.md"

# Ground-truth sensitivity class for every column in the synthetic warehouse.
# A column is "sensitive" iff its label is not non_sensitive. CLAIM_NOTE is
# labeled direct because it embeds names/emails/SSNs in free text — the case only
# the LLM (or the regex fallback) catches.
GOLD: dict[tuple[str, str], str] = {
    ("CLAIMS", "CLAIM_ID"): "non_sensitive",
    ("CLAIMS", "MEMBER_ID"): "direct",
    ("CLAIMS", "PROVIDER_ID"): "non_sensitive",
    ("CLAIMS", "SERVICE_DATE"): "quasi",
    ("CLAIMS", "DX_CODE"): "clinical",
    ("CLAIMS", "PROCEDURE_CODE"): "clinical",
    ("CLAIMS", "ALLOWED_AMOUNT"): "financial",
    ("CLAIMS", "PAID_AMOUNT"): "financial",
    ("CLAIMS", "OUTCOME"): "clinical",
    ("CLAIMS", "CLAIM_NOTE"): "direct",
    ("MEMBERS", "MEMBER_ID"): "direct",
    ("MEMBERS", "MEMBER_NAME"): "direct",
    ("MEMBERS", "EMAIL"): "direct",
    ("MEMBERS", "PHONE"): "direct",
    ("MEMBERS", "SSN"): "direct",
    ("MEMBERS", "DOB"): "quasi",
    ("MEMBERS", "ZIP"): "quasi",
    ("MEMBERS", "GENDER"): "quasi",
    ("PROVIDERS", "PROVIDER_ID"): "non_sensitive",
    ("PROVIDERS", "PROVIDER_NAME"): "direct",
    ("PROVIDERS", "SPECIALTY"): "clinical",
    ("PROVIDERS", "NPI"): "direct",
}


def _score_sensitivity(classified: list[dict]) -> dict:
    """Precision/recall/F1 on the binary sensitive-vs-not decision.

    Recall is the safety metric: a sensitive column scored non_sensitive is an
    unmasked-PHI miss.
    """
    tp = fp = fn = tn = 0
    class_correct = class_total = 0
    misses: list[str] = []
    for c in classified:
        key = (c["table"], c["column"])
        gold = GOLD.get(key)
        if gold is None:
            continue
        pred_sensitive = c["sensitive"]
        gold_sensitive = gold != "non_sensitive"
        if pred_sensitive and gold_sensitive:
            tp += 1
        elif pred_sensitive and not gold_sensitive:
            fp += 1
        elif not pred_sensitive and gold_sensitive:
            fn += 1
            misses.append(f"{c['table']}.{c['column']}")
        else:
            tn += 1
        class_total += 1
        if c["class"] == gold:
            class_correct += 1
    precision = tp / (tp + fp) if tp + fp else 1.0
    recall = tp / (tp + fn) if tp + fn else 1.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    return {
        "columns": class_total, "true_positives": tp, "false_positives": fp,
        "false_negatives": fn, "true_negatives": tn,
        "precision": round(precision, 3), "recall": round(recall, 3),
        "f1": round(f1, 3),
        "class_accuracy": round(class_correct / class_total, 3) if class_total else 1.0,
        "misses": misses,
    }


def _invariant_every_sensitive_maps_to_control(classified: list[dict]) -> dict:
    """Invariant: every sensitive column maps to >= 1 SOC2/HIPAA control."""
    unmapped = [
        f"{c['table']}.{c['column']} ({c['class']})"
        for c in classified
        if c["sensitive"] and not controls.mapped_controls_for(c["class"])
    ]
    return {"holds": not unmapped, "unmapped": unmapped}


def run(mode: str | None = None) -> dict:
    warehouse.reset()
    classified = classify.classify_all(mode=mode)
    sens = _score_sensitivity(classified)
    cov = policy.coverage(classified)
    inv = _invariant_every_sensitive_maps_to_control(classified)
    kanon = risk.k_anonymity()
    posture = controls.evaluate(classified, cov, kanon)
    providers = sorted({c["provider"] for c in classified})
    return {
        "sensitivity": sens, "coverage": cov, "invariant": inv,
        "kanon": kanon, "posture": posture, "providers_used": providers,
        "mode": mode or os.environ.get("LLM_MODE", "auto"),
    }


def _render(r: dict) -> str:
    s, cov, inv, k = r["sensitivity"], r["coverage"], r["invariant"], r["kanon"]
    lines = [
        "# maskline — eval report",
        "",
        "Reproducible with `./run.sh eval`. Offline (name/type heuristics + regex "
        "free-text detector) by default, so these numbers reproduce exactly with "
        "zero keys; set provider keys or `LLM_MODE` to score a live model on "
        "free-text classification.",
        "",
        "## Column-sensitivity classification",
        "",
        f"Scored over **{s['columns']}** labeled synthetic columns on the binary "
        "sensitive-vs-not decision. **Recall is the safety metric** — a sensitive "
        "column scored non-sensitive is an unmasked-PHI miss.",
        "",
        "| metric | value |",
        "| --- | --- |",
        f"| precision | {s['precision']} |",
        f"| recall | {s['recall']} |",
        f"| F1 | {s['f1']} |",
        f"| exact-class accuracy | {s['class_accuracy']} |",
        f"| false negatives (missed sensitive) | {s['false_negatives']} |",
        f"| providers used | {', '.join(r['providers_used'])} |",
        "",
        "> The free-text `CLAIM_NOTE` column is the case name rules miss: it is "
        "non-obvious by name yet embeds names/emails/SSNs in prose. The LLM (or "
        "the regex fallback) is what classifies it sensitive.",
        "",
        "## Policy coverage",
        "",
        f"Of **{cov['must_mask_columns']}** columns that require masking "
        f"(direct/quasi), **{cov['covered_columns']}** are covered by a generated "
        f"masking policy and **{len(cov['uncovered_columns'])}** are not:",
        "",
    ]
    if cov["uncovered_columns"]:
        lines.append("| table.column | class |")
        lines.append("| --- | --- |")
        for u in cov["uncovered_columns"]:
            lines.append(f"| {u['table']}.{u['column']} | {u['class']} |")
    else:
        lines.append("All required columns are covered.")
    lines += [
        "",
        f"The CI gate **{'passes' if cov['fully_covered'] else 'fails'}** on this "
        "set — an uncovered sensitive column blocks the merge.",
        "",
        "## Re-identification risk",
        "",
        f"On quasi-identifiers `{k['quasi_identifiers']}` the minimum "
        f"**k = {k['k_min']}**: {k['singleton_count']}/{k['records']} rows are "
        "singletons, re-identifiable by linkage even with direct identifiers "
        "masked.",
        "",
        "## Invariants",
        "",
        f"- **Every sensitive column maps to >= 1 SOC 2 / HIPAA control:** "
        f"{'PASS' if inv['holds'] else 'FAIL — ' + ', '.join(inv['unmapped'])}",
        f"- **Control posture:** {r['posture']['posture_score']} "
        f"(grade {r['posture']['grade']}), "
        f"{r['posture']['passed']}/"
        f"{r['posture']['passed'] + r['posture']['failed']} controls pass.",
        "",
    ]
    return "\n".join(lines)


def main() -> None:
    r = run()
    REPORT.write_text(_render(r))
    s, cov = r["sensitivity"], r["coverage"]
    print(f"classification: precision={s['precision']} recall={s['recall']} "
          f"f1={s['f1']} class_acc={s['class_accuracy']} "
          f"(providers: {', '.join(r['providers_used'])})")
    print(f"coverage: {cov['covered_columns']}/{cov['must_mask_columns']} masked; "
          f"gate={'PASS' if cov['fully_covered'] else 'FAIL'}; "
          f"uncovered={[u['column'] for u in cov['uncovered_columns']]}")
    print(f"invariant (sensitive→control): "
          f"{'PASS' if r['invariant']['holds'] else 'FAIL'}")
    print(f"posture: {r['posture']['posture_score']} grade {r['posture']['grade']}")
    print(f"wrote {REPORT}")


if __name__ == "__main__":
    main()
