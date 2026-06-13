# rate-atlas — eval report

Reproducible with `./run.sh eval`. Offline (synonym-table header matcher) by default, so these numbers reproduce exactly with zero keys; set provider keys or `LLM_MODE` to score a live model on the same labeled headers.

## LLM-assisted column mapping

Scored over **5** synthetic unknown-format headers a real payer/hospital file might emit. Each source column has a gold canonical field (or `null` for columns with no equivalent). A column mapped to its correct canonical field is a true positive; **recall is the coverage metric** — a missed column is a row that fails to ingest.

| metric | value |
| --- | --- |
| precision | 1.0 |
| recall | 1.0 |
| F1 | 1.0 |
| true positives | 23 |
| false positives | 0 |
| false negatives | 0 |
| providers used | offline |

> The offline matcher is a synonym table over normalized header tokens (`cpt`/`hcpcs`/`billing_code` → `code`; `allowed`/`negotiated_rate`/`price` → `rate`; `insurer`/`payor` → `payer`; …). It is exact on the labeled set; in the wild the synonym table doesn't cover every vendor's naming, which is where the LLM path earns its keep — it generalizes to unseen column names and phrasings. The mapping is applied deterministically on either path.

## Normalization invariants (all shapes → one 7-field model)

Detected shapes for the known sources: `cms_nested_json, flat_json, pipe_csv` (18 canonical rows). The assisted path ingests the bundled unknown-format sample (`delimited:csv`, 6/6 columns mapped, 4 rows).

| invariant | result |
| --- | --- |
| every record is the canonical 7-field schema `hospital, code, code_type, description, payer, plan, rate` | PASS |
| known shapes collapse to one model | 3 shapes → 1 schema |
| assisted (unknown-format) rows match the schema | 4 rows |

Takeaway: a heterogeneous-format problem becomes a single canonical surface — and an unseen format is handled by an LLM-proposed column mapping that is then applied by the same deterministic ingest, not by a new hand-written adapter.
