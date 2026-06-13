# attack-surface — eval report

Reproducible with `./run.sh eval`. Deterministic offline (template narrative + fixture report) by default, so these numbers reproduce exactly with zero keys; set provider keys or `LLM_MODE` to generate the exec narrative with a live model.

## Governed-evidence invariants

Asserted as measured facts over the **9** findings and **8** in-scope controls of the fixture report.

| invariant | holds |
| --- | --- |
| every finding maps to ≥ 1 control | ✓ |
| every failing control traces to ≥ 1 finding | ✓ |
| posture = 100 − Σ severity penalty (clamped ≥ 0) | ✓ |
| severity counts sum to finding count | ✓ |

## Exec narrative — remediation coverage

The LLM exec narrative writes board-ready prose plus remediation guidance over the *already-computed* report. **Coverage of every critical (and high) finding is the safety metric** — an uncovered critical is a gap in the board report.

| metric | value |
| --- | --- |
| criticals | ADMIN_NO_AUTH, DB_EXPOSED |
| findings requiring guidance | 4 |
| covered by remediation | 4 |
| uncovered (gaps) | none |
| every critical covered | ✓ |
| provider | offline |

## Posture over time — remediation diff

Fixing the two critical findings (`ADMIN_NO_AUTH`, `DB_EXPOSED`) lifts the posture and flips the controls they hit fail → pass:

| state | score | grade | controls failing |
| --- | --- | --- | --- |
| before | 57/100 | D | 7/8 |
| after | 77/100 | B | 5/8 |

Posture moved **D → B** (+20 points); **2 control(s) remediated** (ISO:A.5.15, ISO:A.8.20).
