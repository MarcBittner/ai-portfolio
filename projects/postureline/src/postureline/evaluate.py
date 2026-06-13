"""Reproducible eval over BOTH surfaces. Writes ``eval-report.md`` + prints a summary.

Run via ``./run.sh eval`` (or ``python -m postureline.evaluate``). Deterministic
offline by default, so the report reproduces to the digit with zero keys; set
provider keys / ``LLM_MODE`` to score a live model on the warehouse free-text
classification and the board narratives instead.

- **Warehouse:** column-classification precision/recall (recall is the safety
  metric — a missed sensitive column is unmasked PHI), masking-policy coverage, and
  k-anonymity.
- **Exposure:** fingerprint → control coverage and the remediation-diff posture
  delta.
- **Cross-surface invariants:** every finding maps to ≥ 1 control across the six
  frameworks; the per-framework roll-up matches the per-control status; the board
  report covers every critical (and high) finding.
"""

from __future__ import annotations

import os
from pathlib import Path

from postureline import (
    classify,
    controls,
    data,
    kanon,
    narrative,
    scan,
    warehouse_policy,
)
from postureline.posture import SEVERITY_WEIGHT, score_for

REPORT = Path(__file__).resolve().parents[2] / "eval-report.md"

# Ground-truth sensitivity class for every column in the synthetic warehouse.
# CLAIM_NOTE is labeled direct because it embeds names/emails/SSNs in free text —
# the case only the LLM (or the regex fallback) catches.
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
    """Precision/recall/F1 on the binary sensitive-vs-not decision."""
    tp = fp = fn = tn = 0
    class_correct = class_total = 0
    misses: list[str] = []
    for c in classified:
        gold = GOLD.get((c["table"], c["column"]))
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


def _invariants(report: dict) -> dict:
    """Cross-surface structural invariants, asserted as measured facts."""
    findings, control_rows = report["findings"], report["controls"]
    fw_rows = report["framework_rollup"]
    catalog_ids = {c["id"] for c in controls.catalog()}

    every_finding_mapped = all(f["control_ids"] for f in findings)
    controls_known = all(cid in catalog_ids
                         for f in findings for cid in f["control_ids"])
    failing_trace = all(
        c["finding_count"] == len(c["findings"]) >= 1
        for c in control_rows if c["status"] == "fail")
    penalty = sum(SEVERITY_WEIGHT.get(f["severity"], 0) for f in findings)
    posture_math = report["posture"]["score"] == score_for(penalty)
    sev_sum = sum(report["severity_counts"].values()) == len(findings)
    failing_controls = [c for c in control_rows if c["status"] == "fail"]
    fw_consistent = all(
        sum(1 for c in failing_controls if r["framework"] in c["frameworks"])
        == r["controls_failing"]
        for r in fw_rows)
    return {
        "every_finding_maps_to_a_control": every_finding_mapped,
        "every_failing_control_traces_to_findings": failing_trace,
        "all_mapped_controls_exist_in_catalog": controls_known,
        "framework_rollup_consistent": fw_consistent,
        "posture_math_checks_out": posture_math,
        "severity_counts_sum_to_findings": sev_sum,
    }


def run(mode: str | None = None) -> dict:
    data.reset()
    # --- warehouse surface --------------------------------------------------
    classified = classify.classify_all(mode=mode)
    sens = _score_sensitivity(classified)
    cov = warehouse_policy.coverage(classified)
    k = kanon.k_anonymity()
    wh = scan.run("warehouse", mode=mode)
    wh_inv = _invariants(wh)
    wh_narr = narrative.evaluate("warehouse", mode=mode)
    wh_diff = scan.diff("warehouse")
    providers = sorted({c["provider"] for c in classified})

    # --- exposure surface ---------------------------------------------------
    ex = scan.run("exposure", mode=mode)
    ex_inv = _invariants(ex)
    ex_narr = narrative.evaluate("exposure", mode=mode)
    ex_diff = scan.diff("exposure")

    return {
        "warehouse": {
            "sensitivity": sens, "coverage": cov, "kanon": k,
            "invariants": wh_inv, "narrative": wh_narr, "diff": wh_diff,
            "posture": wh["posture"], "framework_rollup": wh["framework_rollup"],
            "findings": len(wh["findings"]),
            "providers_used": providers,
        },
        "exposure": {
            "invariants": ex_inv, "narrative": ex_narr, "diff": ex_diff,
            "posture": ex["posture"], "framework_rollup": ex["framework_rollup"],
            "findings": len(ex["findings"]),
        },
        "frameworks": controls.frameworks(),
        "mode": mode or os.environ.get("LLM_MODE", "auto"),
    }


def _inv_table(inv: dict) -> list[str]:
    yes = "✓"
    label = {
        "every_finding_maps_to_a_control": "every finding maps to ≥ 1 control",
        "every_failing_control_traces_to_findings":
            "every failing control traces to ≥ 1 finding",
        "all_mapped_controls_exist_in_catalog":
            "every mapped control id exists in the catalog",
        "framework_rollup_consistent":
            "per-framework roll-up matches the per-control status",
        "posture_math_checks_out": "posture = 100 / (1 + Σ severity penalty / K)",
        "severity_counts_sum_to_findings": "severity counts sum to finding count",
    }
    rows = ["| invariant | holds |", "| --- | --- |"]
    rows += [f"| {label[k]} | {yes if inv[k] else 'FAIL'} |" for k in label]
    return rows


def _render(r: dict) -> str:
    yes = "✓"
    w, e = r["warehouse"], r["exposure"]
    s, cov, k = w["sensitivity"], w["coverage"], w["kanon"]
    wd, ed = w["diff"], e["diff"]
    wb, wa = wd["before"]["posture"], wd["after"]["posture"]
    eb, ea = ed["before"]["posture"], ed["after"]["posture"]
    lines = [
        "# postureline — eval report",
        "",
        "Reproducible with `./run.sh eval`. Deterministic offline by default, so "
        "these numbers reproduce exactly with zero keys; set provider keys or "
        "`LLM_MODE` to score a live model on warehouse free-text classification and "
        "the board narratives.",
        "",
        "One posture/compliance engine, evaluated on **both** exposure surfaces. "
        f"Catalog spans **{len(r['frameworks'])}** frameworks: "
        f"{', '.join(r['frameworks'])}.",
        "",
        "## Surface: warehouse",
        "",
        "### Column-sensitivity classification",
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
        f"| providers used | {', '.join(w['providers_used'])} |",
        "",
        f"Masking-policy coverage: **{cov['covered_columns']}/"
        f"{cov['must_mask_columns']}** required columns covered; the CI gate "
        f"**{'passes' if cov['fully_covered'] else 'fails'}** (uncovered: "
        f"{', '.join(u['column'] for u in cov['uncovered_columns']) or 'none'}).",
        "",
        f"Re-identification risk: on quasi-identifiers `{k['quasi_identifiers']}` the "
        f"minimum **k = {k['k_min']}** ({k['singleton_count']}/{k['records']} "
        f"singletons), below the threshold k ≥ {k['k_threshold']} → the "
        "de-identification control (GV1.1) fails until generalization clears it.",
        "",
        "### Warehouse invariants",
        "",
    ]
    lines += _inv_table(w["invariants"])
    lines += [
        "",
        f"Board report covers every critical/high finding: "
        f"**{yes if w['narrative']['coverage_complete'] else 'FAIL'}** "
        f"(provider: {w['narrative']['provider']}).",
        "",
        "### Warehouse remediation diff",
        "",
        f"Masking the discovered PHI column and clearing the k threshold moves "
        f"posture **{wb['grade']} ({wb['score']}/100) → {wa['grade']} "
        f"({wa['score']}/100)** (+{wd['score_delta']}); remediates "
        f"{', '.join(wd['controls_remediated']) or 'none'}.",
        "",
        "## Surface: exposure",
        "",
        f"Fingerprint → control coverage over **{e['findings']}** exposure findings. "
        f"Posture **{e['posture']['score']}/100 (grade {e['posture']['grade']})**, "
        f"{e['posture']['controls_failing']}/{e['posture']['controls_total']} "
        f"controls and {e['posture']['frameworks_failing']}/"
        f"{e['posture']['frameworks_total']} frameworks failing.",
        "",
        "### Exposure invariants",
        "",
    ]
    lines += _inv_table(e["invariants"])
    lines += [
        "",
        f"Board report covers every critical/high finding: "
        f"**{yes if e['narrative']['coverage_complete'] else 'FAIL'}** "
        f"(criticals: {', '.join(e['narrative']['criticals'])}; "
        f"provider: {e['narrative']['provider']}).",
        "",
        "### Exposure remediation diff",
        "",
        "| state | score | grade | controls failing | frameworks failing |",
        "| --- | --- | --- | --- | --- |",
        f"| before | {eb['score']}/100 | {eb['grade']} | "
        f"{eb['controls_failing']}/{eb['controls_total']} | "
        f"{eb['frameworks_failing']}/{eb['frameworks_total']} |",
        f"| after | {ea['score']}/100 | {ea['grade']} | "
        f"{ea['controls_failing']}/{ea['controls_total']} | "
        f"{ea['frameworks_failing']}/{ea['frameworks_total']} |",
        "",
        f"Posture **{eb['grade']} → {ea['grade']}** (+{ed['score_delta']} points); "
        f"remediates {', '.join(ed['controls_remediated'])}.",
        "",
    ]
    return "\n".join(lines)


def main() -> None:
    r = run()
    REPORT.write_text(_render(r))
    w, e = r["warehouse"], r["exposure"]
    s = w["sensitivity"]
    print(f"[warehouse] classification: precision={s['precision']} "
          f"recall={s['recall']} f1={s['f1']} "
          f"(providers: {', '.join(w['providers_used'])})")
    gate_ok = "PASS" if w["coverage"]["fully_covered"] else "FAIL"
    print(f"[warehouse] coverage gate={gate_ok}; "
          f"k_min={w['kanon']['k_min']}; "
          f"invariants {sum(w['invariants'].values())}/{len(w['invariants'])}; "
          f"posture {w['posture']['score']} ({w['posture']['grade']})")
    print(f"[exposure]  findings={e['findings']}; "
          f"invariants {sum(e['invariants'].values())}/{len(e['invariants'])}; "
          f"posture {e['posture']['score']} ({e['posture']['grade']}); "
          f"criticals_covered={e['narrative']['criticals_covered']}")
    print(f"wrote {REPORT}")


if __name__ == "__main__":
    main()
