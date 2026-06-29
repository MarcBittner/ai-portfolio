# Last-Known-Good Log

Each entry records a verified-good repository state: the git version, what was proven,
and the test proofs that demonstrate why it's known good. Newest first.

A state is "known good" only with reproducible test evidence attached. Projects that
cannot be verified in this environment (missing toolchain, or tests that need network /
external services) are listed as **review-only** and are NOT auto-modified.

---

## v2 — code-review safe-fixes `75a09c8` (2026-06-29)

Applied **132 auto-fixable, non-UX** code-review findings across **23 verifiable Python
projects** (security hardening, bug fixes, dead-code/quality, perf). Each project was
fixed, then **independently re-run** (pytest + ruff) and **committed + pushed per project**
only after passing. No user-facing behavior change. Review-only projects (persona-twin,
vigil, maskline, perimeter, cycleledger, relaytoken, trueline, tanglement-showcase) were
reviewed (`docs/code-reviews/`) but NOT modified — not verifiable in this env.

Index of all reviews + findings: `docs/code-reviews/README.md`.

**Verified GREEN after fixes (proof = pytest tail; ruff clean):**

| project | fixes | pytest proof | lint |
|---|---|---|---|
| agent-factory | 4 | 85 passed, 8 skipped, 1 xfailed, 1 warning in 0.61s | ruff clean |
| agent-sandbox | 5 | 52 passed, 8 skipped, 1 xfailed, 1 warning in 0.38s | ruff clean |
| arbiter | 7 | 58 passed, 5 skipped, 1 warning in 0.45s | ruff clean |
| attack-surface | 6 | 60 passed, 14 skipped, 1 warning in 0.88s | ruff clean |
| baseplate | 5 | 63 passed, 9 skipped, 1 warning in 0.40s | ruff clean |
| burnrate | 7 | 71 passed, 4 skipped, 1 xfailed in 0.75s | ruff clean |
| counsel | 9 | 89 passed, 9 skipped, 1 warning in 0.68s | ruff clean |
| doc-extract | 6 | 43 passed, 7 skipped, 1 warning in 0.23s | ruff clean |
| evalkit | 7 | 48 passed, 8 skipped, 1 warning in 0.30s | ruff clean |
| field-vault | 7 | 75 passed, 13 skipped, 1 warning in 0.87s | ruff clean |
| forecast | 5 | 51 passed, 9 skipped, 1 warning in 3.90s | ruff clean |
| llm-gateway | 8 | 62 passed, 10 skipped, 1 warning in 0.26s | ruff clean |
| multimodal-ocr | 3 | 45 passed, 8 skipped, 1 warning in 1.05s | ruff clean |
| pii-redactor | 4 | 64 passed, 10 skipped, 2 warnings in 0.34s | ruff clean |
| postureline | 5 | 79 passed, 10 skipped, 1 warning in 3.21s | ruff clean |
| promptguard | 5 | 39 passed, 8 skipped, 1 warning in 0.22s | ruff clean |
| quorum | 10 | 59 passed, 10 skipped, 1 warning in 0.25s | ruff clean |
| rate-atlas | 3 | 54 passed, 11 skipped, 1 warning in 0.79s | ruff clean |
| reconcile | 3 | 46 passed, 11 skipped, 1 warning in 0.28s | ruff clean |
| rtc-guard | 8 | 74 passed, 13 skipped, 1 warning in 0.93s | ruff clean |
| slo-kit | 5 | 56 passed, 12 skipped, 1 warning in 3.50s | ruff clean |
| synth-data | 5 | 47 passed, 8 skipped, 1 warning in 0.21s | ruff clean |
| txn-ledger | 4 | 136 passed, 11 skipped, 1 warning in 6.24s | ruff clean |

---

## v1 — baseline `35e96f6` (2026-06-29)

Pre-code-review baseline captured before any automated fixes, as the regression oracle.

**Verified GREEN (23 Python projects)** — `PYTHONPATH=src python3 -m pytest -q`:

| project | proof | project | proof |
|---|---|---|---|
| agent-factory | 85 passed, 8 skip | multimodal-ocr | 45 passed, 8 skip |
| agent-sandbox | 52 passed, 8 skip | pii-redactor | 64 passed, 10 skip |
| arbiter | 58 passed, 5 skip | postureline | 79 passed, 10 skip |
| attack-surface | 60 passed, 14 skip | promptguard | 39 passed, 8 skip |
| baseplate | 63 passed, 9 skip | quorum | 59 passed, 10 skip |
| burnrate | 71 passed, 4 skip | rate-atlas | 54 passed, 11 skip |
| counsel | 89 passed, 9 skip | reconcile | 46 passed, 11 skip |
| doc-extract | 43 passed, 7 skip | rtc-guard | 74 passed, 13 skip |
| evalkit | 48 passed, 8 skip | slo-kit | 56 passed, 12 skip |
| field-vault | 75 passed, 13 skip | synth-data | 47 passed, 8 skip |
| forecast | 51 passed, 9 skip | txn-ledger | 128 passed, 11 skip |
| llm-gateway | 61 passed, 10 skip | | |

Test deps required (installed in this env): `pyyaml flask pydantic-settings duckdb
itsdangerous prometheus-client numpy`.

**REVIEW-ONLY (not auto-modified — cannot verify here):**
- `persona-twin` — pytest has real failures/errors here (33 failed / 76 errors; needs full
  app env). Reviewed, not auto-fixed.
- `vigil` — test suite hangs (live network probes). Reviewed, not auto-fixed.
- `maskline`, `perimeter` — no source test files present (only stale `.pyc`). Reviewed only.
- `cycleledger` (Ruby), `relaytoken` (Go), `trueline` (Node) — toolchain not available here.
- `tanglement-showcase` — pitch deck + demo-site; no backend test suite.

**Links/fleet gate:** `scripts/check-links.py` → 27/29 live, 0 drift (cycleledger + trueline
infra-down, links correct).
