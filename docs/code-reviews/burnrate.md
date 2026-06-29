# burnrate — code review

> **Remediation status — 7 of 10 findings auto-remediated & verified (2026-06-29).**
> Applied safe, non-UX fixes; re-verified independently (pytest green + ruff clean) and pushed per project.
>
> **Remediated (verified ✅):**
> - `BR-03` — O(n) list.pop(0) and sort-while-locked in the hot metrics path
> - `BR-04` — Unguarded json.loads in Worker.run() crashes the drain loop on corrupt Redis entries
> - `BR-05` — Provider call failures silently swallowed with no logging in llm.complete()
> - `BR-06` — Overly broad `except Exception` in incident._parse() masks unexpected errors
> - `BR-07` — _backend_cache written without a mutex — benign race in threaded deployments
> - `BR-09` — p99_ms computed on every snapshot() call but never consumed
> - `BR-10` — evaluate.py REPORT path breaks when installed as a package
>
> **Verification proof:** `71 passed, 4 skipped, 1 xfailed in 0.75s` · ruff clean.
> Remaining findings in the table below were not auto-applied (UX-impacting or needing a design decision) — open for manual triage.


**Health: fair** — well-structured demo service with solid test coverage and a clean security model, but carries one known and unfixed server-crash bug (non-string `mode` → 500), unauthenticated admin endpoints that are genuinely exploitable on the live public deployment, and an O(n) list mutation held under the metrics lock that will degrade under sustained load.

---

## Findings

| # | Severity | Category | File | Finding | Recommendation | UX impact | Auto-fixable |
|---|----------|----------|------|---------|----------------|-----------|--------------|
| 1 | high | bug | `src/burnrate/app.py:111` | `body.get("mode")` is passed directly to `incident.summarize()` → `llm.resolve_mode()` → `.lower()`. A non-string `mode` (e.g. a JSON array `["not","a","string"]`) raises `AttributeError` and returns a 500. This is explicitly documented as a known bug in `tests/test_security.py:127–137` via `xfail(strict=True)` but was never fixed. | Add a one-line guard: `mode=body.get("mode") if isinstance(body.get("mode"), str) else None`. Mirror the same guard already applied to `client_summary`. | true (500 vs clean response) | true |
| 2 | medium | security | `src/burnrate/app.py:135–151` | `/admin/inject`, `/admin/loadtest`, and `/admin/reset` carry no authentication. These endpoints can force a 100% error rate, saturate the metric window with synthetic load, or reset all SLO state. The app is deployed publicly (`burnrate-v8sp.onrender.com`), making these controls reachable by anyone. | Gate the `/admin/*` prefix behind an env-var token (`ADMIN_TOKEN`) checked via `Authorization: Bearer` or a secret query param; return 401 on mismatch. Document that the token is unset in the offline demo. | true (service state changed by external actors) | true |
| 3 | medium | performance | `src/burnrate/metrics.py:103–104` | Inside `Metrics.record()` (which holds `self._lock`), the window-bounded duration list is trimmed with `self._durations.pop(0)`, which is O(n) for a list (shifts all 5000 elements). Additionally, `snapshot()` sorts the entire list while also holding the lock (`s = sorted(self._durations)`). Under any real concurrency, these two hot-path operations serialize behind the lock and the O(n) pop adds ~5000-element copy work per request past the cap. | Replace `self._durations: list[float]` with `collections.deque(maxlen=5000)`. In `snapshot()`, convert to a sorted list once: `s = sorted(self._durations)`. This makes trim O(1) and moves the sort outside the critical section if the deque is copied first. | false | true |
| 4 | low | bug | `src/burnrate/tasks.py:199` | In `Worker.run()`, `json.loads(raw)` is unguarded. A corrupted or malformed Redis entry (truncated write, manual `RPUSH` of garbage, etc.) raises `json.JSONDecodeError` which propagates uncaught out of the `while` loop, aborting any further job processing and returning a 500 from the HTTP handler that drove the worker. | Wrap `json.loads(raw)` in a `try/except (json.JSONDecodeError, KeyError)` block; log a warning and `continue` to the next job. | false | true |
| 5 | low | quality | `src/burnrate/llm.py:211–213` | Provider call failures are silently swallowed (`except Exception: fallbacks.append(provider); continue`) with no log line. When a provider key is set but the call fails (rate-limit, bad model name, network blip), the router falls through to the next tier invisibly — the only signal is the `fallbacks` list in the response body. | Add `import logging; logger = logging.getLogger(__name__)` and emit `logger.warning("LLM provider %s failed: %r", provider, exc)` in the except block. | false | true |
| 6 | low | quality | `src/burnrate/incident.py:222–225` | `_parse()` catches `except Exception: obj = {}` — too broad. This masks unexpected errors (e.g., a `MemoryError` or `RecursionError`) from a malformed LLM response and silently substitutes the offline fallback, making bugs hard to detect. | Narrow to `except (json.JSONDecodeError, ValueError, KeyError)`. | false | true |
| 7 | low | quality | `src/burnrate/metrics.py:118–135` | `snapshot()` acquires `self._lock` and then calls `sorted(self._durations)` inside the lock, blocking all concurrent `record()` calls for the O(n log n) sort. For the default 5000-element cap this takes ~0.5 ms, but every `/slo` poll (every 4 s from the UI) and every `_publish()` call (every `send_outreach`) triggers it. | Copy the deque first (`s = sorted(self._durations)` after `s_copy = list(self._durations)`), release the lock, then sort outside: or use a read/write lock pattern. Simplest: copy list while locked, sort after releasing. | false | false |
| 8 | low | quality | `src/burnrate/tasks.py:83–93` | `_backend_cache` is a module-level global written without a mutex. Two concurrent requests arriving while `_backend_cache is None` can both enter the detection branches. The race is benign (both compute the same result) but technically unsound in a threaded deployment. | Add a `threading.Lock()` guard around the probe-and-set block, or use `functools.lru_cache` on a helper. | false | true |
| 9 | low | bug | `src/burnrate/metrics.py:142–146` | `_pct()` uses `int(q * n)` (truncation) rather than the standard nearest-rank formula. For n=100 at q=0.95 this returns index 95 (96th value) instead of index 94 (95th value). The discrepancy is visible at round multiples of n. The `/slo` endpoint reports this p95 directly to users and the dashboard, so the number is slightly inflated. | Use `i = min(n - 1, max(0, math.ceil(q * n) - 1))` for the standard nearest-rank p95/p99. | true (displayed metric is slightly wrong) | true |
| 10 | low | quality | `src/burnrate/metrics.py:130` | `p99_ms` is computed in every `snapshot()` call and included in the returned dict, but nothing in `slo.compute()`, `service.snapshot()`, or any API endpoint consumes it. It is pure dead computation. | Either remove the `p99_ms` field from `snapshot()` and the `_pct(s, 0.99)` call, or expose it in the `/slo` response for completeness. | false | true |

---

## Notes

**What works well.** The security model is thoughtful: severity classification is provably deterministic and the `client_summary` trust boundary is correctly enforced and tested. The multi-provider LLM routing chain with a deterministic offline fallback is production-quality. Tests cover the burn→recover contract end-to-end, and `test_security.py` is unusually thorough for a demo project (including adversarial input fuzzing and canary-secret leak detection).

**Finding 1 (mode bug)** is the most actionable: it is a one-line fix already articulated in the `xfail` comment, and any caller submitting a JSON array as `mode` will get a 500 today.

**Finding 2 (admin auth)** matters specifically because the app is live and publicly accessible. The endpoints were clearly designed as demo controls, but `/admin/inject {error_rate:1.0}` on the live URL is a denial-of-service with no barrier.

**Finding 3 (O(n) pop)** is worth fixing before any load-testing scenario: under the 5000-element cap, `pop(0)` shifts the entire list on every record call, and `snapshot()` re-sorts it under the lock on every SLO poll — both on the hot path.

**Findings 4–10** are all low-effort fixes that together improve robustness and correctness without touching the public API shape.
