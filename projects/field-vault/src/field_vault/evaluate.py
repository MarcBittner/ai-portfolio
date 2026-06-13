"""Reproducible eval: PHI-detection precision/recall + re-identification risk.

Writes ``eval-report.md`` at the project root and prints a summary. Run via
``./run.sh eval`` (or ``python -m field_vault.evaluate``). Deterministic offline,
so the report reproduces to the digit with zero keys; set ``LLM_MODE`` /
provider keys to score a live model instead.
"""

from __future__ import annotations

import os
from pathlib import Path

from field_vault import notes, privacy, store

REPORT = Path(__file__).resolve().parents[2] / "eval-report.md"


def run() -> dict:
    store.reset()
    det = notes.evaluate()
    kanon = privacy.k_anonymity(store.records())
    sweep = privacy.generalization_sweep(store.records())
    return {"detection": det, "kanon": kanon, "sweep": sweep,
            "mode": os.environ.get("LLM_MODE", "auto")}


def _render(r: dict) -> str:
    d, k = r["detection"], r["kanon"]
    lines = [
        "# field-vault — eval report",
        "",
        "Reproducible with `./run.sh eval`. Offline (regex + name roster) by "
        "default, so these numbers reproduce exactly with zero keys; set provider "
        "keys or `LLM_MODE` to score a live model.",
        "",
        "## PHI detection (free-text notes)",
        "",
        f"Scored over **{d['notes']}** labeled synthetic notes on exact "
        "(value, type) matches. A missed span is a leak, so **recall is the "
        "safety metric**.",
        "",
        "| metric | value |",
        "| --- | --- |",
        f"| precision | {d['precision']} |",
        f"| recall | {d['recall']} |",
        f"| F1 | {d['f1']} |",
        f"| true positives | {d['true_positives']} |",
        f"| false positives | {d['false_positives']} |",
        f"| false negatives (leaks) | {d['false_negatives']} |",
        f"| providers used | {', '.join(d['providers_used'])} |",
        "",
        "> The offline detector is regex (email/phone/SSN/date) + a name roster. "
        "It is exact on the synthetic set; in the wild the roster doesn't exist, "
        "which is where the LLM path earns its keep — it generalizes to unseen "
        "names and phrasings. Deterministic redaction + value-free audit are "
        "identical on either path.",
        "",
        "## Re-identification risk (k-anonymity) on the de-identified surface",
        "",
        f"Direct identifiers are tokenized, yet on quasi-identifiers "
        f"`{k['quasi_identifiers']}` the minimum **k = {k['k_min']}**: "
        f"**{k['singleton_count']}/{k['records']}** rows are singletons, "
        "re-identifiable by linkage against an external dataset.",
        "",
        "Coarser generalization is the lever:",
        "",
        "| generalization | k_min | singletons |",
        "| --- | --- | --- |",
    ]
    for row in r["sweep"]:
        lines.append(f"| {row['generalization']} | {row['k_min']} | "
                     f"{row['singletons']} |")
    lines += [
        "",
        "Takeaway: tokenization alone does not de-identify — quasi-identifier "
        "generalization must be tuned to a target k, trading analytic resolution "
        "for privacy.",
        "",
    ]
    return "\n".join(lines)


def main() -> None:
    r = run()
    REPORT.write_text(_render(r))
    d, k = r["detection"], r["kanon"]
    print(f"PHI detection: precision={d['precision']} recall={d['recall']} "
          f"f1={d['f1']} leaks={d['false_negatives']} "
          f"(providers: {', '.join(d['providers_used'])})")
    print(f"k-anonymity: k_min={k['k_min']} singletons="
          f"{k['singleton_count']}/{k['records']}")
    print(f"wrote {REPORT}")


if __name__ == "__main__":
    main()
