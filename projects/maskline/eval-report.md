# maskline — eval report

Reproducible with `./run.sh eval`. Offline (name/type heuristics + regex free-text detector) by default, so these numbers reproduce exactly with zero keys; set provider keys or `LLM_MODE` to score a live model on free-text classification.

## Column-sensitivity classification

Scored over **22** labeled synthetic columns on the binary sensitive-vs-not decision. **Recall is the safety metric** — a sensitive column scored non-sensitive is an unmasked-PHI miss.

| metric | value |
| --- | --- |
| precision | 1.0 |
| recall | 1.0 |
| F1 | 1.0 |
| exact-class accuracy | 1.0 |
| false negatives (missed sensitive) | 0 |
| providers used | offline, rule |

> The free-text `CLAIM_NOTE` column is the case name rules miss: it is non-obvious by name yet embeds names/emails/SSNs in prose. The LLM (or the regex fallback) is what classifies it sensitive.

## Policy coverage

Of **13** columns that require masking (direct/quasi), **12** are covered by a generated masking policy and **1** are not:

| table.column | class |
| --- | --- |
| CLAIMS.CLAIM_NOTE | direct |

The CI gate **fails** on this set — an uncovered sensitive column blocks the merge.

## Re-identification risk

On quasi-identifiers `['DOB', 'ZIP', 'GENDER']` the minimum **k = 1**: 12/12 rows are singletons, re-identifiable by linkage even with direct identifiers masked.

## Invariants

- **Every sensitive column maps to >= 1 SOC 2 / HIPAA control:** PASS
- **Control posture:** 18.2 (grade F), 1/4 controls pass.
