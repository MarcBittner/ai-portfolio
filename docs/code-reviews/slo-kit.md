# slo-kit — Code Review

> **Remediation status — 5 of 11 findings auto-remediated & verified (2026-06-29).**
> Applied safe, non-UX fixes; re-verified independently (pytest green + ruff clean) and pushed per project.
>
> **Remediated (verified ✅):**
> - `F01` — Unescaped trace fields interpolated into innerHTML
> - `F05` — client_summary field has no server-side length limit
> - `F08` — O(n) list.pop(0) eviction in Metrics._durations
> - `F09` — O(n) list.pop(0) eviction in service._outbox
> - `F11` — GET /traces?limit has no upper bound in the API contract
>
> **Verification proof:** `56 passed, 12 skipped, 1 warning in 3.50s` · ruff clean.
> Remaining findings in the table below were not auto-applied (UX-impacting or needing a design decision) — open for manual triage.


**Health: fair** — well-structured core with good test coverage, but a handful of real correctness and security gaps across thread safety, metrics consistency, and front-end injection patterns.

---

## Findings

| # | Severity | Category | File | Finding | Recommendation | UX Impact | Auto-fixable |
|---|----------|----------|------|---------|----------------|-----------|--------------|
| 1 | medium | security | `static/index.html:728-731` | Trace table renders `s.name` and `s.status` from the server directly into `innerHTML` with no HTML escaping. Currently safe (both are internal constants), but any future extension of the tracer that surfaces user-controlled data would immediately become XSS. | Replace template-literal interpolation with `textContent` assignments or a local `esc()` call, matching the approach already used for `r.summary` and `r.steps` at line 774. | true | true |
| 2 | medium | security | `static/index.html:1111,1126` | The project launcher fetches `catalog.json` from `cdn.jsdelivr.net` (third-party CDN) and renders `a.url` directly as an unescaped `href` attribute: `'"href="'+a.url+'">'`. A compromised or malicious entry with `url: "javascript:alert(1)"` produces a clickable XSS link. `a.name` and `a.tag` are correctly escaped by the local `esc()` helper, but `a.url` is not. | Pass `a.url` through `esc()` before interpolation (same helper defined in the same IIFE at line 1123). Optionally validate that URLs start with `https://`. | true | true |
| 3 | medium | bug | `src/slo_kit/service.py:50-55` | All route handlers are synchronous (`def`, not `async def`). FastAPI/uvicorn runs sync handlers in a thread pool, so multiple concurrent requests can execute simultaneously. The module-level `_n` counter and `fault` dataclass are read and written without any lock inside `_simulate()`, `set_fault()`, and `reset()`. Under concurrent load the deterministic fault cadence (`_n % step`) is unreliable and `_n` can be double-incremented. | Add a `threading.Lock` around `_n` increments and fault reads in `_simulate()`, mirroring the lock already used in `Metrics.record()`. Or convert the handlers that need determinism to `async def` with a single-threaded event loop guarantee. | false | false |
| 4 | medium | bug | `src/slo_kit/metrics.py:48,67` | `dur_sum` accumulates the sum of every request's duration since startup and is never windowed, while `_durations` is capped at the last 5 000 samples. As a result `avg_ms` (derived from `dur_sum / total`) reflects a lifetime average, whereas `p50_ms`/`p95_ms`/`p99_ms` reflect only the recent window. The dashboard presents these side-by-side as if they describe the same population, which is misleading. | Either (a) cap `dur_sum` to match the `_durations` window using a `deque` and a parallel sum tracker, or (b) compute `avg_ms` from the same sorted list: `round(sum(s) / len(s), 1) if s else 0.0`. | true | true |
| 5 | low | security | `src/slo_kit/models.py:30` | `IncidentRequest.client_summary` has no `max_length` constraint. A caller can submit arbitrarily large strings (the test suite exercises 50 000 chars without issue). In practice FastAPI buffers the entire body before validation, so a very large payload consumes memory proportional to its size before any application check. | Add `max_length=20_000` (or similar) to the `Field(...)` call, matching the pattern used on `SendRequest.body`. | false | true |
| 6 | low | security | `src/slo_kit/api.py` (entire file) | No HTTP security response headers are set: no `Content-Security-Policy`, `X-Content-Type-Options`, `X-Frame-Options`, or `Referrer-Policy`. FastAPI's default responses carry none of these. | Add a lightweight middleware (or a custom `default_response_class` subclass) that injects `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, and a restrictive CSP. This is a single `app.add_middleware` call. | false | false |
| 7 | low | bug | `src/slo_kit/tracing.py:36-39` | `Tracer._seq` is incremented without a lock. Like `service._n`, this is accessed from sync route handlers running in uvicorn's thread pool. Two concurrent requests can receive the same `trace_id`/`span_id` pair. | Add a `threading.Lock` to `Tracer.record()`, or use `itertools.count()` (whose `__next__` is GIL-protected) for the sequence counter. | false | true |
| 8 | low | performance | `src/slo_kit/metrics.py:54-55` | `self._durations` is a plain `list`; evicting old entries uses `list.pop(0)` which is O(n) per call (shifts all remaining elements). With `_WINDOW = 5000`, each record call that triggers eviction does 5 000 element moves. Additionally, `snapshot()` calls `sorted(self._durations)` (O(n log n)) on every invocation, including every auto-refresh cycle. | Replace `list` with `collections.deque(maxlen=_WINDOW)`. The deque's fixed `maxlen` evicts automatically in O(1), and a pre-sorted structure or bisect-based insertion can eliminate the full re-sort. | false | true |
| 9 | low | performance | `src/slo_kit/service.py:73` | `_outbox.pop(0)` on a plain `list` is O(n) every time the outbox cap (500) is reached. | Replace `_outbox: list[dict]` with `collections.deque(maxlen=500)` and remove the manual `pop(0)` guard; the deque handles eviction automatically. | false | true |
| 10 | low | quality | `src/slo_kit/models.py:23-25` | `IncidentRequest.mode` is typed `str | None` with valid values documented only in the `description` string. An unknown mode (e.g. `"bogus"`) silently falls back to `"auto"` via `_CHAIN.get(resolved, _CHAIN["auto"])`. The API contract claims four specific values. | Change the type to `Literal["auto", "paid", "local", "free", "offline"] | None` so Pydantic validates the field and returns a clean 422 for bad values, instead of silently coercing them. | true | true |
| 11 | low | quality | `src/slo_kit/api.py:72` | `GET /traces?limit=N` accepts any integer with no upper bound; `tracer.recent()` slices from a 200-item deque so the actual cap is 200, but the API contract is undocumented and a caller sending `limit=999999` gets no validation feedback. | Add `limit: int = Query(default=25, ge=1, le=200)` to pin the contract explicitly. | false | true |

---

## Notes

**What works well:** The core SLO math in `slo.py` is clean and fully tested. The deterministic fault injection + burn/recover loop is a strong demo concept. The LLM routing chain (`llm.py`) is thoughtfully designed — the offline fallback is a true last resort, severity classification is correctly kept deterministic and never delegated to the LLM, and the `_parse` fallback in `incident.py` is robust. The security test suite (`test_security.py`) is notably thorough for a demo project: it pins to offline mode, plants secret canaries, and validates that `client_summary` cannot override severity. `Metrics.record()` is correctly locked. The Dockerfile runs as a non-root user.

**Thread safety gap (finding 3):** This is the most structural issue. Every sync route handler in `api.py` runs in uvicorn's thread pool (this is how FastAPI works for non-async handlers). The `service._n` counter, the `Fault` dataclass, and `tracer._seq` are all shared mutable state without locks. The `Metrics` class has a lock and is safe. Fixing this requires either adding a lock to `_simulate()` or converting the few stateful handlers to async (which would serialize them on the event loop).

**Metrics window inconsistency (finding 4):** `avg_ms` is a lifetime metric while percentiles are windowed. During a burn-then-recover demo, `avg_ms` will show a much higher value than the recovered p50/p95, which can confuse an operator reading the dashboard. A simple fix is to compute `avg_ms` from the already-sorted `_durations` list inside `snapshot()`.

**Front-end injection patterns (findings 1, 2):** The dashboard correctly escapes `r.summary` and `r.steps` via the `esc()` helper. The gap is specifically in the traces table (server constants today, risky pattern tomorrow) and in the catalog launcher's unescaped `a.url`. Both have mechanical one-line fixes.
