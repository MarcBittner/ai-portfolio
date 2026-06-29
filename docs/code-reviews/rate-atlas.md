# rate-atlas — Code Review

**Health: fair** — well-structured Python/FastAPI service with good test coverage, clean SQL parameterization, and a thoughtful LLM routing chain, but two correctness bugs are significant (a health check that destroys user data and a non-atomic reingest), and a stored XSS vector exists due to an incomplete HTML-escaping function in the frontend.

---

## Findings

| # | Severity | Category | File | Finding | Recommendation | UX Impact | Auto-fixable |
|---|----------|----------|------|---------|----------------|-----------|--------------|
| 1 | high | bug | `src/rate_atlas/api.py:30` | `health()` calls `store.ingest()` — this drops and recreates the table on **every health check**, wiping any user-submitted LLM-assisted records in seconds (K8s probe hits every 5–15 s). Makes the `/normalize/assist ingest=True` feature non-persistent in production. | Replace `store.ingest()` in the health handler with a lightweight `store._row_count()` or a dedicated stats accessor that does not mutate state. | yes | yes |
| 2 | high | security | `src/rate_atlas/static/index.html:599` | `x.code` is interpolated directly into both `value="${x.code}"` (attribute) and element text content without any HTML escaping. A user who submits a sample with a malicious code value (e.g. `"><img src=x onerror=alert(1)>`) via `/normalize/assist` stores it in SQLite and it is rendered unescaped in the procedures `<select>` for all subsequent visitors — stored XSS. `x.rate_count` is also unescaped but is always an integer from SQL `COUNT(*)`, so safe in practice. | Apply the existing `esc()` helper (or a corrected version, see finding 5) to `x.code` in the option value and text: `` `<option value="${esc(x.code)}">${esc(x.code)} — ${esc(x.description)} (${x.rate_count})</option>` `` | yes | yes |
| 3 | medium | bug | `src/rate_atlas/store.py:26-43` | `ingest()` is not wrapped in a transaction: it executes `DROP TABLE`, `CREATE TABLE`, `CREATE INDEX`, then `executemany` as separate statements with a single `commit()` at the end. Between the DROP and the final commit, concurrent readers see an empty or missing table and get SQLite errors. | Wrap the body of `ingest()` in an explicit `BEGIN EXCLUSIVE` / `COMMIT` (or use `with db:`) so the table is never visible in an intermediate empty state. | yes | yes |
| 4 | medium | security | `src/rate_atlas/api.py:95-97` | `POST /admin/reingest` is unauthenticated. Any actor with network access can wipe and reload the canonical rate store. In the demo context this is low-harm, but as the comment notes "swap the connection string for Postgres in production" — if that transition happens without auth, this becomes a privileged destructive operation with no guard. | Add at minimum a static bearer token check (from an env var) on this endpoint, or restrict it to localhost. | no | no |
| 5 | medium | quality | `src/rate_atlas/static/index.html:549` | The `esc` function only escapes `<` (`replace(/</g,"&lt;")`), leaving `"`, `'`, `>`, and `&` unescaped. Several `innerHTML` assignments pass server-supplied strings through this function into HTML attribute contexts (e.g. `class="shape ${esc(s.shape)}"` at line 709), where a `"` in the value breaks attribute boundaries. Shape values are hardcoded server-side today, keeping actual risk low, but the helper is structurally wrong and will silently pass through injections as the codebase grows. | Replace with a full-coverage escaper: `s => String(s==null?"":s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c])` | no | yes |
| 6 | low | quality | `src/rate_atlas/llm.py:211` | `except Exception: continue` in `complete()` silently swallows all provider errors (network timeouts, malformed responses, auth failures) without logging. Diagnostics of LLM routing problems are impossible. | Add at minimum `import logging; logging.getLogger(__name__).debug("provider %s failed: %s", provider, exc, exc_info=True)` inside the except block. | no | yes |
| 7 | low | performance | `src/rate_atlas/api.py:84-85` | `GET /evals` calls `assist.evaluate()` which runs `propose_mapping()` five times (one per labeled case) synchronously on every HTTP request. With a live provider this makes 5 LLM calls per request. Results are deterministic for a given mode and provider state; they should be cached. | Cache the result per `(mode, provider_fingerprint)` with `functools.lru_cache` or a simple module-level dict, invalidating on provider config change. | no | no |
| 8 | low | quality | `src/rate_atlas/api.py:52` | `threshold: float = 2.0` has no validation. Values ≤ 0 flag every row; very large values flag nothing silently; negative values are semantically nonsensical. FastAPI's `Query(gt=0.0)` would enforce this at the framework level. | Change to `threshold: float = Query(default=2.0, gt=0.0, le=10.0)` with an appropriate import. | no | yes |
| 9 | low | bug | `src/rate_atlas/store.py:19-20` | A single SQLite `:memory:` connection is shared across FastAPI's sync thread-pool workers (`check_same_thread=False`) with no explicit lock. Concurrent `POST /admin/reingest` and `GET /compare` calls can interleave mid-transaction. SQLite serializes writes at the engine level but Python's GIL does not fully cover multi-statement sequences. | Either acquire a `threading.Lock` around multi-statement operations or switch to `sqlite3.connect` per-request (connection is cheap for `:memory:` with WAL off). | no | no |

---

## Notes

**What works well**
- All SQL queries use parameterized statements throughout `store.py` — no SQL injection surface.
- `apply_mapping` validates the client-supplied `client_mapping` against `CANONICAL_FIELDS` before use, neutralizing prototype-pollution and field-injection attempts.
- The LLM routing chain has a safe deterministic offline fallback; `complete()` never raises.
- The test suite (`test_security.py`) is unusually thorough — it plants API key canaries in env vars and asserts they never appear in any response, tests prompt-injection payloads, and verifies the offline fallback is terminal.
- The Dockerfile runs as a non-root user (`uid=1001`); K8s manifest sets `runAsNonRoot: true`.
- Parameterized SQL is used everywhere; the search endpoint is protected by LIMIT 50.

**Priority fixes**
1. Finding 1 (health endpoint) is the most impactful: it renders the `/normalize/assist ingest=True` flow silently useless and will confuse demo visitors who submit a file and then see it disappear.
2. Finding 2 (stored XSS) is straightforward to fix and protects all future users of any shared deployment.
3. Finding 5 (incomplete `esc()`) should be fixed alongside finding 2 to prevent future attribute-injection bugs as the UI grows.
