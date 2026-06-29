# txn-ledger — Code Review

> **Remediation status — 4 of 8 findings auto-remediated & verified (2026-06-29).**
> Applied safe, non-UX fixes; re-verified independently (pytest green + ruff clean) and pushed per project.
>
> **Remediated (verified ✅):**
> - `TXN-01` — guard_sql() table-whitelist misses JOIN and comma-joined tables
> - `TXN-02` — PRAGMA query_only toggle is not thread-safe on the shared connection
> - `TXN-03` — _offline_sql builds SQL by f-string interpolation instead of parameterized queries
> - `TXN-08` — AskRequest.mode accepts arbitrary strings without enum validation
>
> **Verification proof:** `136 passed, 11 skipped, 1 warning in 6.24s` · ruff clean.
> Remaining findings in the table below were not auto-applied (UX-impacting or needing a design decision) — open for manual triage.


**Health:** fair — the core data pipeline is solid and the NL→SQL safety guard has good depth, but it has two confirmed bypass vectors (JOIN and comma-joined tables) that defeat the table-whitelist check, plus a thread-safety gap around the `PRAGMA query_only` toggle.

---

## Findings

| # | Severity | Category | File : line | Finding | Recommendation | UX impact | Auto-fixable |
|---|----------|----------|-------------|---------|----------------|-----------|--------------|
| 1 | high | security | `src/txn_ledger/nl2sql.py:114` | `guard_sql()` table-whitelist check uses `re.findall(r"\bFROM\s+tablename")` but misses tables introduced via `JOIN` and comma-separated `FROM t1, t2` syntax. Confirmed: `SELECT * FROM contributions JOIN sqlite_master ON 1=1` and `SELECT c.id FROM contributions c, sqlite_master s` both pass the guard. An adversarial `client_sql` or a prompt-injected LLM response can reach system tables. | Extend the table-name regex to also match `\bJOIN\s+([A-Za-z_][\w]*)` and comma-list items after `FROM`, or parse with a proper SQL AST library (e.g. `sqlglot`). Alternatively, block any token in `_ALLOWED_TABLE` by scanning the full stripped SQL for any word that is a known SQLite internal table (`sqlite_master`, `sqlite_schema`, etc.). | false | true |
| 2 | medium | bug | `src/txn_ledger/nl2sql.py:130–134` | `PRAGMA query_only = ON/OFF` is toggled around a single query on a shared `sqlite3.Connection` without a lock. With `check_same_thread=False` and FastAPI's default thread-pool workers, a concurrent `/ask` can race: Thread B's `finally: PRAGMA query_only = OFF` disables the protection mid-execution for Thread A. The guard is the primary control, but this undermines defense-in-depth. | Wrap the `PRAGMA query_only = ON … execute … PRAGMA query_only = OFF` block in a `threading.Lock`. Alternatively, open a new read-only connection per call using `sqlite3.connect("file::memory:?mode=ro", uri=True)` (not viable for the current in-memory approach) or keep the lock but document the contention. | false | true |
| 3 | medium | quality | `src/txn_ledger/nl2sql.py:155–195` | `_offline_sql()` constructs SQL by f-string interpolation (e.g. `f"WHERE cycle = {cycle}"`, `f"LIMIT {n}"`) rather than parameterized queries. Values are safe here (cycle comes from the fixed CYCLES list, n is `int()`-cast), but the practice diverges from the parameterized pattern used everywhere else and will be a footgun if the function is extended. | Replace inline literal injection with parameterized placeholders and return `(sql, params)`, or document explicitly that the values are integer-safe constants. | false | true |
| 4 | low | security | `src/txn_ledger/api.py:77` | No rate limiting on `POST /ask`. The endpoint calls external LLM providers (potentially paid) and runs a SQLite query per request. There is no per-IP cap, burst limit, or concurrency guard. A sustained burst would inflate cloud LLM costs and saturate the single-connection SQLite DB. | Add a simple token-bucket or fixed-window rate limit (e.g. `slowapi` for FastAPI) on `/ask`. Even a generous 10 req/min/IP prevents abuse without affecting normal use. | false | false |
| 5 | low | security | `src/txn_ledger/static/index.html:599` | `r.name` and `r.committee_id` from the `/aggregate` response are inserted into `innerHTML` without `escHtml()` escaping (unlike `r.sql`, `r.provider`, and `r.error` which do use `escHtml`). In this demo the values come from a static dict and are harmless. If the API is ever extended to accept user-supplied committee metadata, this becomes stored XSS. | Apply `escHtml(r.name)` and `escHtml(r.committee_id)` at line 599, consistent with the rest of the template. | true | true |
| 6 | low | quality | `src/txn_ledger/static/index.html:537–540` | `colorPlan()` escapes `<` (`replace(/</g,"&lt;")`) but not `>` or `&`. Plan text from SQLite's `EXPLAIN QUERY PLAN` won't contain these characters in practice, but the escaping is incomplete and breaks the "always HTML-escape server data" discipline. | Use the already-defined `escHtml()` helper (or replicate its `[&<>]` replacement) inside `colorPlan()`. | true | true |
| 7 | low | quality | `src/txn_ledger/api.py:24` | `db.build()` is called at module scope during import, triggering a 60,000-row insert synchronously. This makes the module non-trivially importable (slow on any cold import, causes test setup races if the module is re-imported), and defers startup errors silently. | Move `db.build()` into a FastAPI lifespan event (`@asynccontextmanager`) so it runs after the app object is constructed and errors surface cleanly at startup. | false | false |
| 8 | low | quality | `src/txn_ledger/models.py:12` | `AskRequest.mode` is typed as `str | None` with a comment listing valid values, but no enum or `Literal` constraint. Any string (e.g. `"turbo"`, `"gpt4"`) is accepted without a 422. The code handles unknown modes gracefully (falls back to "auto"), but the API contract is weaker than it appears. | Change to `mode: Literal["auto","paid","local","free","offline"] | None = None` for Pydantic to validate and document. | false | true |

---

## Notes

**What is well-done:**

- The guard's core logic (empty check, comment rejection, semicolon stripping, _FORBIDDEN keyword list, SELECT-only requirement) is solid and tested adversarially in `test_security.py`.
- `PRAGMA query_only = ON` as a second line of defense is a good pattern; it just needs thread-safety.
- Parameterized queries are used correctly everywhere the DB layer accepts external values (`cycle`, `committee`, `AGG_SQL`).
- The Dockerfile runs non-root (`uid 1001`), only copies `src/`, and pins `--no-cache-dir` — no secrets leak via the image.
- API key material is never echoed in any response; `test_security.py` plants canary tokens and verifies they don't appear.
- The `client_sql` browser path still runs through `guard_sql()`, correctly not trusting the browser.

**Finding 1 in context:** The practical impact in this demo is leaking `sqlite_master` (which already shows the same schema as `/schema`). In a production Postgres deployment this bypass would be critical — any table reachable by the DB user could be read. The fix is mechanical and the test suite already covers the table check for the `FROM table` pattern; tests for `JOIN table` and `FROM t1, t2` patterns should be added.

**Finding 2 in context:** The guard is the real write-prevention control; the `query_only` race can only remove a redundant safety net, not introduce a new write path. Under normal (low-concurrency demo) usage the race is unlikely to trigger. It becomes more relevant under the `/loadtest` surge pattern which hits the same connection concurrently.
