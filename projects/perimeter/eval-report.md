# perimeter — eval report

Reproducible with `./run.sh eval`. Deterministic offline (template board report + fixture posture) by default, so these numbers reproduce exactly with zero keys; set provider keys or `LLM_MODE` to generate the board narrative with a live model.

## Governed-evidence invariants

Asserted as measured facts over the **13** exposure findings, **6** in-scope controls, and **5** compliance frameworks of the fixture posture run.

| invariant | holds |
| --- | --- |
| every finding maps to ≥ 1 control | ✓ |
| every failing control traces to ≥ 1 finding | ✓ |
| every mapped control id exists in the catalog | ✓ |
| per-framework roll-up matches the per-control status | ✓ |
| posture = 100 / (1 + Σ severity penalty / K) | ✓ |
| severity counts sum to finding count | ✓ |

## Multi-framework coverage

One exposure finding, mapped through the crosswalk, lands on a control in each framework — so the same evidence is defensible to a SOC 2, ISO 27001, NIST 800-53/800-171, and CMMC assessor at once.

| framework | failing | total | failing control ids |
| --- | --- | --- | --- |
| SOC 2 | 6 | 6 | `CC6.1`, `CC6.6`, `CC6.7`, `CC6.8`, `CC7.1`, `CC7.2` |
| ISO 27001 | 6 | 6 | `A.8.16`, `A.8.20`, `A.8.24`, `A.8.3`, `A.8.8` |
| NIST 800-53 | 6 | 6 | `AC-3`, `RA-5`, `SC-7`, `SC-8`, `SI-2`, `SI-4` |
| NIST 800-171 | 6 | 6 | `3.1.1`, `3.11.2`, `3.13.1`, `3.13.11`, `3.14.1`, `3.14.6` |
| CMMC | 6 | 6 | `AC.L2-3.1.1`, `RA.L2-3.11.2`, `SC.L2-3.13.1`, `SC.L2-3.13.11`, `SI.L2-3.14.1`, `SI.L2-3.14.6` |

## Board report — top-risk coverage

The LLM board report writes posture prose plus a prioritized top-risk list over the *already-computed* report. **Coverage of every critical (and high) finding is the safety metric** — an uncovered critical is a gap in the board report.

| metric | value |
| --- | --- |
| criticals | ADMIN_EXPOSED, DB_EXPOSED |
| findings requiring coverage | 6 |
| covered in top risks | 6 |
| uncovered (gaps) | none |
| every critical covered | ✓ |
| provider | offline |

## Posture over time — remediation diff

Fixing the top exposures (`ADMIN_EXPOSED`, `DB_EXPOSED`, `EOL_SOFTWARE`, `TLS_EXPIRED`) lifts the posture and flips the controls and frameworks they hit fail → pass:

| state | score | grade | controls failing | frameworks failing |
| --- | --- | --- | --- | --- |
| before | 25/100 | F | 6/6 | 5/5 |
| after | 59/100 | D | 1/6 | 5/5 |

Posture moved **F → D** (+34 points); **5 control(s) remediated** (CC6.1, CC6.6, CC6.8, CC7.1, CC7.2).
