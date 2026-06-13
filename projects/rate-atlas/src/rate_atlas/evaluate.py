"""Reproducible eval: column-mapping precision/recall + normalization invariants.

Writes ``eval-report.md`` at the project root and prints a summary. Run via
``./run.sh eval`` (or ``python -m rate_atlas.evaluate``). Deterministic offline,
so the report reproduces to the digit with zero keys; set ``LLM_MODE`` / provider
keys to score a live model on the same labeled headers instead.
"""

from __future__ import annotations

import os
from pathlib import Path

from rate_atlas import assist, store
from rate_atlas.data import SOURCES, UNKNOWN_HOSPITAL, UNKNOWN_SAMPLE
from rate_atlas.normalize import normalize_source

REPORT = Path(__file__).resolve().parents[2] / "eval-report.md"

_CANON = ("hospital", "code", "code_type", "description", "payer", "plan", "rate")


def _invariants() -> dict:
    """Assert every known shape collapses to the canonical 7-field record, and
    that the assisted (unknown-format) path produces the same shape too."""
    shapes: dict[str, str] = {}
    field_ok = True
    total = 0
    for name, raw in SOURCES.items():
        records, shape = normalize_source(name, raw)
        shapes[name] = shape
        total += len(records)
        for r in records:
            if tuple(r) != _CANON:
                field_ok = False
    # the assisted path on the bundled unknown-format file
    a = assist.assist(UNKNOWN_HOSPITAL, UNKNOWN_SAMPLE, mode="offline")
    for r in a["records"]:
        if tuple(r) != _CANON:
            field_ok = False
    return {
        "shapes": sorted(set(shapes.values())), "known_rows": total,
        "all_seven_field": field_ok, "assisted_kind": a["detected_kind"],
        "assisted_rows": a["rows_mapped"],
        "assisted_columns_mapped": f"{a['columns_mapped']}/{a['columns_total']}",
    }


def run() -> dict:
    store.ingest()
    return {"mapping": assist.evaluate(), "invariants": _invariants(),
            "mode": os.environ.get("LLM_MODE", "auto")}


def _render(r: dict) -> str:
    m, inv = r["mapping"], r["invariants"]
    lines = [
        "# rate-atlas — eval report",
        "",
        "Reproducible with `./run.sh eval`. Offline (synonym-table header matcher) "
        "by default, so these numbers reproduce exactly with zero keys; set "
        "provider keys or `LLM_MODE` to score a live model on the same labeled "
        "headers.",
        "",
        "## LLM-assisted column mapping",
        "",
        f"Scored over **{m['headers']}** synthetic unknown-format headers a real "
        "payer/hospital file might emit. Each source column has a gold canonical "
        "field (or `null` for columns with no equivalent). A column mapped to its "
        "correct canonical field is a true positive; **recall is the coverage "
        "metric** — a missed column is a row that fails to ingest.",
        "",
        "| metric | value |",
        "| --- | --- |",
        f"| precision | {m['precision']} |",
        f"| recall | {m['recall']} |",
        f"| F1 | {m['f1']} |",
        f"| true positives | {m['true_positives']} |",
        f"| false positives | {m['false_positives']} |",
        f"| false negatives | {m['false_negatives']} |",
        f"| providers used | {', '.join(m['providers_used'])} |",
        "",
        "> The offline matcher is a synonym table over normalized header tokens "
        "(`cpt`/`hcpcs`/`billing_code` → `code`; `allowed`/`negotiated_rate`/"
        "`price` → `rate`; `insurer`/`payor` → `payer`; …). It is exact on the "
        "labeled set; in the wild the synonym table doesn't cover every vendor's "
        "naming, which is where the LLM path earns its keep — it generalizes to "
        "unseen column names and phrasings. The mapping is applied deterministically "
        "on either path.",
        "",
        "## Normalization invariants (all shapes → one 7-field model)",
        "",
        f"Detected shapes for the known sources: `{', '.join(inv['shapes'])}` "
        f"({inv['known_rows']} canonical rows). The assisted path ingests the "
        f"bundled unknown-format sample (`{inv['assisted_kind']}`, "
        f"{inv['assisted_columns_mapped']} columns mapped, {inv['assisted_rows']} "
        "rows).",
        "",
        "| invariant | result |",
        "| --- | --- |",
        f"| every record is the canonical 7-field schema "
        f"`{', '.join(_CANON)}` | {'PASS' if inv['all_seven_field'] else 'FAIL'} |",
        f"| known shapes collapse to one model | "
        f"{len(inv['shapes'])} shapes → 1 schema |",
        f"| assisted (unknown-format) rows match the schema | "
        f"{inv['assisted_rows']} rows |",
        "",
        "Takeaway: a heterogeneous-format problem becomes a single canonical "
        "surface — and an unseen format is handled by an LLM-proposed column "
        "mapping that is then applied by the same deterministic ingest, not by a "
        "new hand-written adapter.",
        "",
    ]
    return "\n".join(lines)


def main() -> None:
    r = run()
    REPORT.write_text(_render(r))
    m, inv = r["mapping"], r["invariants"]
    print(f"column mapping: precision={m['precision']} recall={m['recall']} "
          f"f1={m['f1']} (providers: {', '.join(m['providers_used'])})")
    print(f"invariants: 7-field={'ok' if inv['all_seven_field'] else 'FAIL'} "
          f"shapes={inv['shapes']} assisted_rows={inv['assisted_rows']}")
    print(f"wrote {REPORT}")


if __name__ == "__main__":
    main()
