# Code Review: evalkit

> **Remediation status — 7 of 11 findings auto-remediated & verified (2026-06-29).**
> Applied safe, non-UX fixes; re-verified independently (pytest green + ruff clean) and pushed per project.
>
> **Remediated (verified ✅):**
> - `EK-02` — No max-length on prediction/reference fields — DoS and runaway LLM spend
> - `EK-06` — Metric names inserted into innerHTML without escaping — latent XSS
> - `EK-07` — CDN-supplied URL used verbatim in href — potential javascript: injection
> - `EK-08` — toast() message passed to innerHTML — latent XSS
> - `EK-09` — METRICS dict typed as dict[str, tuple] — callable signature invisible to type checkers
> - `EK-10` — token_f1 uses list.remove() in inner loop — O(n²) for large inputs
> - `EK-11` — _resolve_order has unreachable None in exclusion tuple
>
> **Verification proof:** `48 passed, 8 skipped, 1 warning in 0.30s` · ruff clean.
> Remaining findings in the table below were not auto-applied (UX-impacting or needing a design decision) — open for manual triage.


**Health:** fair — clean architecture with good offline-first design, strong test coverage (unit + security suite), and solid Pydantic validation; marred by a handful of concrete medium-severity issues (open API, unbounded field sizes, misleading boot overlay) and several low-severity latent-XSS and quality issues.

---

## Findings

| # | Severity | Category | File | Finding | Recommendation | UX Impact | Auto-fixable |
|---|----------|----------|------|---------|----------------|-----------|--------------|
| 1 | medium | security | `src/evalkit/api.py` | No authentication on any endpoint. Anyone who can reach the service can submit 2000-item batches that trigger paid LLM API calls. | Add an API key header check (FastAPI `Security`/`Depends`) or deploy behind an auth proxy. Even a shared static key stops casual abuse. | false | false |
| 2 | medium | security | `src/evalkit/models.py:19` | `EvalItem.prediction` and `EvalItem.reference` have no maximum string length. A single request can submit 2000 items of arbitrary size, causing unbounded CPU/memory usage in `semantic_similarity` and unbounded LLM token spend in `llm_judge`. | Add `Field(max_length=16_000)` (or similar) to both fields in `EvalItem`. | false | true |
| 3 | medium | bug | `src/evalkit/api.py:94-99` | In the server-side judge loop, `routing` is overwritten on every iteration. Only the **last** item's provider and fallbacks appear in the response. If earlier items used a different fallback chain, that information is silently discarded. | Accumulate unique fallback chains across items and surface a summary, or at minimum note when routing varied across items. | true | false |
| 4 | medium | bug | `src/evalkit/static/index.html:744-750` | The `boot()` loop polls `/health` up to 60 times (90 s total). After the loop exits — success **or timeout** — the code unconditionally sets the status dot to "ok" and text to "live". A server that never becomes healthy is silently misrepresented. | Check the `ready` flag after the loop; show a distinct error state and disable the Run button when `!ready`. | true | true |
| 5 | medium | performance | `src/evalkit/static/index.html:696-699` | `ollamaJudge()` calls `ollamaJudgeOne()` with `await` inside a `for...of` loop — strictly sequential. At a conservative 2 s/call and 2000 items, that is over an hour of browser-blocking work. | Fan out with `Promise.all` (or a small concurrency limit via a semaphore) to parallelise Ollama calls. | true | true |
| 6 | low | security | `src/evalkit/static/index.html:510,586,604` | Metric names from the API response are inserted into `innerHTML` template literals without escaping (`${m.name}`, `${m}`). Currently safe because metric names are server-side constants, but any future user-controlled metric name would be a stored XSS vector. | Escape metric names with the existing `esc()` helper (already used for descriptions on line 511). | false | true |
| 7 | low | security | `src/evalkit/static/index.html:809,824` | The portfolio launcher fetches `catalog.json` from `cdn.jsdelivr.net` and injects `a.url` verbatim into `href="'+a.url+'"`. A compromised CDN response could inject `javascript:` URLs. Names and tags are correctly escaped with a local `esc()`, but URLs are not validated. | Validate URLs before use: `if(!a.url.startsWith("https://")) return "";` or use `new URL(a.url).protocol === "https:"`. | false | true |
| 8 | low | security | `src/evalkit/static/index.html:474` | `toast(msg)` inserts `msg` via `innerHTML`. All current call sites pass literal strings, but any future caller passing user- or server-derived content would be XSS. | Use `textContent` for the message part, or sanitize; alternatively create the `<span>` element imperatively and append it. | false | true |
| 9 | low | quality | `src/evalkit/metrics.py:96` | `METRICS` is typed `dict[str, tuple]` — the callable signature `(str, str) -> float` is invisible to type checkers. A wrong metric function would only be caught at runtime. | Use `dict[str, tuple[Callable[[str, str], float], str]]`. | false | true |
| 10 | low | quality | `src/evalkit/metrics.py:48-53` | `token_f1` removes matched tokens from a list with `list.remove()` in O(n) per call inside a loop over all prediction tokens — O(n²) overall. Harmless for short strings but scales poorly for large texts. | Replace `ref_pool = list(ref)` with `Counter`-based intersection: `from collections import Counter; common = sum((Counter(pred) & Counter(ref)).values())`. | false | true |
| 11 | low | quality | `src/evalkit/llm.py:112` | `_resolve_order` checks `provider not in ("auto", "free", "paid", "offline", None)`. The `None` in the tuple is always unreachable when the guard `if provider` is true. | Remove `None` from the tuple; the condition is `if provider and provider not in ("auto","free","paid","offline")`. | false | true |

---

## Notes

**Strengths.** The project has an unusually strong security posture for its size: a dedicated `test_security.py` suite covering secret-leakage, input hardening, trust boundaries, and offline determinism; canary injection via `monkeypatch`; non-root Docker image; `set -euo pipefail` in run.sh; strict Pydantic input models; and a provider chain that is never allowed to raise (mock is terminal). The separation of `evaluate.py` (pure functions) from `api.py` (HTTP layer) makes correctness easy to verify.

**Top 3 to fix first.** (1) Finding #2 (unbounded field sizes) is a one-liner that prevents both DoS and runaway LLM spend. (2) Finding #3 (routing info only reflects last item) is a subtle data-integrity bug that affects every multi-item `llm_judge` response. (3) Finding #4 (boot overlay shows "live" on failure) misleads users operating against a down server.

**Out of scope / not flagged.** The absence of authentication (#1) is noted but may be intentional for a demo deployment; it requires a design decision rather than a mechanical fix. The sequential Ollama boot poll in `boot()` is deliberate cold-start tolerance. The 283 KB monolithic index.html is a maintainability concern but not a bug.
