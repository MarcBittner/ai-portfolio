# Code Review: reconcile

> **Remediation status — 3 of 5 findings auto-remediated & verified (2026-06-29).**
> Applied safe, non-UX fixes; re-verified independently (pytest green + ruff clean) and pushed per project.
>
> **Remediated (verified ✅):**
> - `REC-002` — No HTTP security headers (CSP, X-Frame-Options, X-Content-Type-Options)
> - `REC-003` — Magic constant duplication — review thresholds hardcoded in two files
> - `REC-005` — External CDN catalog fetch inserts unsanitized URL into href attribute
>
> **Verification proof:** `46 passed, 11 skipped, 1 warning in 0.28s` · ruff clean.
> Remaining findings in the table below were not auto-applied (UX-impacting or needing a design decision) — open for manual triage.


**Health:** fair — solid deterministic core with good test coverage; one confirmed exploitable XSS in the rendering layer, missing HTTP security headers, and two low-severity quality issues.

---

## Findings Table

| # | Severity | Category | File | Finding | Recommendation | UX Impact | Auto-fixable |
|---|----------|----------|------|---------|----------------|-----------|--------------|
| 1 | high | security | `src/reconcile/static/index.html:611,629` | **XSS via unescaped `description` in `innerHTML`** — `ln.description` (lines table) and `it.description` (review queue) are interpolated raw into template literals set via `innerHTML`. The regex for description matches `.+?`, so a submitted document with `<img src=x onerror=alert(1)>` as a description field produces confirmed XSS execution in the browser. `esc()` already exists in the file (used correctly in the portfolio launcher for `name`/`tag`) but is not applied here. | Wrap `ln.description` and `it.description` with the existing `esc()` helper before interpolating into the template literal. | true | true |
| 2 | medium | security | `src/reconcile/api.py` | **No HTTP security headers** — the API serves `index.html` and all API responses without `Content-Security-Policy`, `X-Frame-Options`, or `X-Content-Type-Options` headers. The absence of CSP amplifies the XSS risk (#1) and no header prevents the page from being embedded in a cross-origin iframe (clickjacking surface). | Add a FastAPI middleware that sets `Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline'; ...`, `X-Frame-Options: DENY`, and `X-Content-Type-Options: nosniff` on every response. | false | true |
| 3 | low | quality | `src/reconcile/review.py:38,40` | **Magic constant duplication** — `REVIEW_MONEY = 1000.0` and `REVIEW_CONFIDENCE = 0.70` are defined as named constants in `variance.py` but hardcoded again as literals `1000.0` and `0.70` in `review.py:_reason()`. If the thresholds are tuned in one file the `_reason()` function silently drifts. | Import `REVIEW_MONEY` and `REVIEW_CONFIDENCE` from `variance.py` and use them in `review.py`. | false | true |
| 4 | low | bug | `src/reconcile/variance.py:85` | **`benchmark == 0.0` silently suppresses `delta_pct`** — the guard `if benchmark` is falsy for both `None` and `0.0`. If a baseline item has `unit_cost = 0.0`, `delta_pct` is set to `None` instead of a meaningful value, and the column shows `—` in the UI. The `recoverable` calculation is not affected (uses `fair_ceiling` separately), but the percentage deviation display is wrong. The demo data has no zero-cost items so this is latent. | Change `if benchmark` to `if benchmark is not None` on line 85 (and similarly on line 84 for `delta_unit`). | true | true |
| 5 | low | security | `src/reconcile/static/index.html:762` | **External CDN catalog fetch with unsanitized `href`** — the portfolio launcher fetches `catalog.json` from `cdn.jsdelivr.net/gh/MarcBittner/ai-portfolio@main/catalog.json` and inserts `a.url` directly into an `href` attribute without validating the URL scheme. If the CDN content or the backing GitHub repo is compromised, a `javascript:` URL could execute on click. `name` and `tag` are correctly escaped with `esc()`. | Before inserting into `href`, validate the URL starts with `https://` or `http://`. Add `var safeUrl = /^https?:\/\//.test(a.url) ? a.url : '#';` and use `safeUrl`. | false | true |

---

## Notes

### What is clean

- **Deterministic core is solid.** `extract.py`, `variance.py`, `review.py` are well-structured, stateless, and the money-path invariant (any recoverable dollar always sets `needs_review`) is tested and holds.
- **No secrets in code.** API keys are read exclusively from environment variables; the `/providers` endpoint correctly returns booleans, never key values. The security test suite plants canary keys and verifies they never appear in responses — and it passes.
- **LLM provider chain never raises.** The mock is a guaranteed terminal; `complete_json` returns `(None, result)` on all parse failures so the deterministic fallback always wins.
- **Input size gated.** `text` is Pydantic-limited to 100,000 characters at the model layer.
- **Input injection safe at the Python level.** The regex for description matches `.+?`, which is correct for extraction, but the *rendering* layer is where the XSS occurs — the Python API itself does not execute the injected HTML.
- **Test coverage.** 46 tests across unit, security, and live smoke. The adversarial suite covers prompt injection, binary input, oversized payloads, and hostile LLM payloads. All pass.
- **Dockerfile is non-root** (`USER app`, uid 1001), slim base, no dev deps in the image.

### Key risk: XSS (#1) is the only exploitable issue

The `esc()` function already exists in the file and is used correctly for the portfolio card names and tags. The gap is that the same escaping discipline was not applied to the main reconciliation results table and review queue, where the `description` field comes directly from user-submitted document text. An attacker submitting `<script>...</script>` as a table-row description would get it reflected back via `innerHTML`. The fix is a one-liner per injection point.
