# arbiter — code review

> **Remediation status — 7 of 10 findings auto-remediated & verified (2026-06-29).**
> Applied safe, non-UX fixes; re-verified independently (pytest green + ruff clean) and pushed per project.
>
> **Remediated (verified ✅):**
> - `ARB-002` — toast() inserts server-controlled content into innerHTML without sanitizing
> - `ARB-003` — esc() does not escape double-quote or >, enabling attribute-context XSS
> - `ARB-004` — timeseries() issues up to 20 separate SQL queries per /report call
> - `ARB-005` — ResponseCache has no size limit and no active eviction — unbounded memory growth
> - `ARB-007` — Unbounded n on /simulate and /traffic enables DoS via API credit exhaustion
> - `ARB-009` — Store read methods do not acquire the write lock; SQLite not in WAL mode
> - `ARB-010` — Duplicated blend formula between judge() and score_from_texts()
>
> **Verification proof:** `58 passed, 5 skipped, 1 warning in 0.45s` · ruff clean.
> Remaining findings in the table below were not auto-applied (UX-impacting or needing a design decision) — open for manual triage.


**Health: fair** — well-structured proxy with clean separation of concerns; one exploitable auth gap, two XSS vectors in the console, a performance hot-spot in the analytics, and an unbounded cache/memory issue.

---

## Findings

| # | Severity | Category | File | Finding | Recommendation | UX Impact | Auto-fixable |
|---|----------|----------|------|---------|----------------|-----------|-------------|
| 1 | HIGH | security | `src/arbiter/api.py` (all routes) | No authentication on any endpoint. Any network-reachable client can call `POST /v1/chat/completions` (consuming the operator's API keys), `POST /reset` (destroy all telemetry), or `PUT /config` (change routing floors). Genuinely exploitable whenever API keys are set and the port is reachable. | Add API-key middleware (e.g., `X-Arbiter-Key` header checked against an env-var secret) or restrict ingress to localhost/VPN at the network layer. | false | false |
| 2 | MEDIUM | security | `src/arbiter/static/index.html:635` | `toast(msg)` writes `msg` directly into `innerHTML` without sanitizing. Two call sites include server-controlled values: `r.baseline` and `r.mode` from `/simulate` (line 891), and `execB`/`execC` from Ollama `/api/tags` (line 950). A malicious `mode` stored via `PUT /config` and then triggered by `POST /simulate` produces stored XSS in the console. | Replace with `t.textContent = msg` (no HTML needed in toasts) or create the span with `document.createElement` and set `textContent`. | false | true |
| 3 | MEDIUM | security | `src/arbiter/static/index.html:624` | The main `esc()` function (`const esc=s=>…replace(/&/…).replace(/</…)`) does not escape `"` or `>`. It is used in double-quoted attribute values (`value="${esc(s)}"` at line 801). A server-controlled value containing `"` breaks out of the attribute context. The launcher's shadow copy (line 1120) also omits `"`. | Add `.replace(/"/g, "&quot;").replace(/>/g, "&gt;")` to both `esc` definitions. | false | true |
| 4 | MEDIUM | performance | `src/arbiter/store.py:143–164` | `timeseries()` issues up to `buckets` (default 20) separate `SELECT` statements in a Python loop. Every call to `GET /report` — including the auto-refresh the console triggers — runs 20+ serial round trips to SQLite. | Replace with a single query that uses `(ts - min_ts) / width` integer division as the bucket key in a `GROUP BY`, then post-process in Python. | false | true |
| 5 | MEDIUM | bug | `src/arbiter/cache.py:73–103` | `ResponseCache` has no memory bound or active eviction. Expired entries are removed only when the same key is accessed again (`get()` path). Under sustained unique traffic within the 15-minute TTL window, `_d` grows without limit. | Add a `maxsize` and periodic or LRU eviction in `put()` (e.g., drop entries whose `expires <= now()` when `len(_d) > maxsize`). | false | true |
| 6 | MEDIUM | quality | `src/arbiter/models.py:34–42`, `src/arbiter/rules.py:27–44` | `ConfigUpdate` and `RouteConfig` do not validate numeric ranges. `floor` can be set to `-1` (silently disabling the quality gate), `shadow_sample` to values above 1.0, or `min_samples` to 0. The `mode` field is not constrained to the valid literals `"off"/"observe"/"route"`. | Add Pydantic `Field(ge=0, le=1)` on `floor`, `shadow_sample`, `route_shadow_sample`; `Field(ge=0)` on `rate`, `min_samples`; and `Literal["off","observe","route"]` on `mode`. | true | true |
| 7 | LOW | bug | `src/arbiter/api.py:153,167` | `SimulateRequest.n` and the `n: int` query parameter on `GET /traffic` have no upper bound. An unauthenticated client can send `n=1_000_000`, triggering millions of shadow-judging API calls and exhausting memory in the traffic list. | Add `n: int = Field(default=60, ge=1, le=2000)` on `SimulateRequest` and `n: int = Query(default=12, ge=1, le=500)` on the traffic endpoint. | false | true |
| 8 | LOW | bug | `src/arbiter/cache.py:34–35` | `_sha()` keeps only the first 16 hex characters of SHA-256, giving a 64-bit collision space. The birthday bound is ~2^32 entries — low in practice but not cryptographically negligible. A collision in the response cache serves the wrong cached answer silently. | Use 32 hex characters (128-bit) for cache keys, or use the full digest for the response ID. | true | true |
| 9 | LOW | bug | `src/arbiter/store.py:104–225` | Read methods (`summary()`, `by_task()`, `timeseries()`, `quality_stats()`, `task_counts()`) do not acquire `self._lock`. Python's GIL prevents torn C-level reads, but SQLite's default deferred-transaction mode means a read that spans a write commit can observe an intermediate state across two physical reads (e.g., `MIN(ts)` read, then write, then range queries). | Enable WAL mode (`self._db.execute("PRAGMA journal_mode=WAL")`) so readers never block writers and can see a consistent snapshot, or acquire `self._lock` for reads. | false | true |
| 10 | LOW | quality | `src/arbiter/quality.py:141–184` | `score_from_texts()` and `judge()` duplicate the blend formula (`0.65 * judge_score + 0.35 * heuristic_mean`) and the early-exit guard. Any future weight change must be made in two places. | Extract a `_combine(heur_mean, judge_score, ...)` helper and call it from both functions. | false | true |

---

## Notes

**What is clean:**
- SQL writes always use parameterized queries (`?` placeholders); no SQL injection.
- The quality floor is enforced as a hard gate in both `Proxy.handle()` and `generate_rules()`; tests cover the boundary conditions well.
- Provider API keys are never surfaced in any response (the `test_security.py` canary suite verifies this).
- The offline stub guarantees the proxy never raises even with no network, and correctly reports `saved=0`.
- `FastAPI`'s 422 error handler cleanly rejects malformed input without leaking tracebacks.

**Deployment note (finding 1):** the Dockerfile binds to `0.0.0.0` by default and is intended for cloud hosting (Render). Running with real provider keys set and no auth means any internet user who discovers the URL can drain API credits. This is the highest priority fix for a public deployment.

**Deployment note (finding 5):** the `ResponseCache` lives in-process. With `uvicorn --workers N`, each worker has its own cache, so the effective hit rate is divided by N; this is worth noting if moving to multi-worker mode.
