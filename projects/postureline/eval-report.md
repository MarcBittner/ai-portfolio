# postureline — eval report

Reproducible with `./run.sh eval`. Deterministic offline by default, so these numbers reproduce exactly with zero keys; set provider keys or `LLM_MODE` to score a live model on warehouse free-text classification and the board narratives.

One posture/compliance engine, evaluated on **both** exposure surfaces. Catalog spans **6** frameworks: SOC 2, HIPAA, ISO 27001, NIST 800-53, NIST 800-171, CMMC.

## Surface: warehouse

### Column-sensitivity classification

Scored over **22** labeled synthetic columns on the binary sensitive-vs-not decision. **Recall is the safety metric** — a sensitive column scored non-sensitive is an unmasked-PHI miss.

| metric | value |
| --- | --- |
| precision | 1.0 |
| recall | 1.0 |
| F1 | 1.0 |
| exact-class accuracy | 1.0 |
| false negatives (missed sensitive) | 0 |
| providers used | offline, rule |

Masking-policy coverage: **12/13** required columns covered; the CI gate **fails** (uncovered: CLAIM_NOTE).

Re-identification risk: on quasi-identifiers `['DOB', 'ZIP', 'GENDER']` the minimum **k = 1** (12/12 singletons), below the threshold k ≥ 2 → the de-identification control (GV1.1) fails until generalization clears it.

### Warehouse invariants

| invariant | holds |
| --- | --- |
| every finding maps to ≥ 1 control | ✓ |
| every failing control traces to ≥ 1 finding | ✓ |
| every mapped control id exists in the catalog | ✓ |
| per-framework roll-up matches the per-control status | ✓ |
| posture = 100 / (1 + Σ severity penalty / K) | ✓ |
| severity counts sum to finding count | ✓ |

Board report covers every critical/high finding: **✓** (provider: offline).

### Warehouse remediation diff

Masking the discovered PHI column and clearing the k threshold moves posture **C (71/100) → A (100/100)** (+29); remediates CC6.1, GV1.1.

## Surface: exposure

Fingerprint → control coverage over **13** exposure findings. Posture **25/100 (grade F)**, 6/7 controls and 6/6 frameworks failing.

### Exposure invariants

| invariant | holds |
| --- | --- |
| every finding maps to ≥ 1 control | ✓ |
| every failing control traces to ≥ 1 finding | ✓ |
| every mapped control id exists in the catalog | ✓ |
| per-framework roll-up matches the per-control status | ✓ |
| posture = 100 / (1 + Σ severity penalty / K) | ✓ |
| severity counts sum to finding count | ✓ |

Board report covers every critical/high finding: **✓** (criticals: ADMIN_EXPOSED, DB_EXPOSED; provider: offline).

### Exposure remediation diff

| state | score | grade | controls failing | frameworks failing |
| --- | --- | --- | --- | --- |
| before | 25/100 | F | 6/7 | 6/6 |
| after | 59/100 | D | 1/7 | 6/6 |

Posture **F → D** (+34 points); remediates CC6.1, CC6.6, CC6.8, CC7.1, CC7.2.
