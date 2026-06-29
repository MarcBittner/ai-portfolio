# Code Review: cycleledger

> **Remediation status — review-only (not auto-modified).**
> Reason: Ruby toolchain not available in this environment. Findings below are documented for manual remediation; no code changes were applied so safety could not be proven here.


**Health: fair** — Strong SQL injection defense (SqlGuard + READ ONLY transaction) and good test coverage of the adversarial path, but the LLM-backed `/ask` endpoint lacks a database-error safety net, no row-limit enforcement leaves an unbounded-query DoS vector open, and the Ollama probe cache is thread-unsafe in a multi-threaded Puma environment.

---

## Findings

| # | Severity | Category | File | Finding | Recommendation | UX Impact | Auto-fixable |
|---|----------|----------|------|---------|----------------|-----------|-------------|
| 1 | high | bug | `app/services/query_copilot.rb:76` | `execute_readonly` is not wrapped in a rescue; if the DB raises `ActiveRecord::StatementInvalid` (LLM produced syntactically valid SQL that references a bad column / unsupported syntax), the exception propagates through `guard_and_run` and `ask` into `AskController`, which has no rescue for it, producing a 500 instead of a clean 4xx. | Wrap the `execute_readonly` call in `guard_and_run` with `rescue ActiveRecord::StatementInvalid => e` and return a rejected `Result` with `reason: e.message`. | true | true |
| 2 | high | performance | `app/services/query_copilot.rb:98-108` | No row limit is enforced on guard-approved SELECT queries. A caller submitting `SELECT * FROM contributions WHERE cycle = 2024` passes the SqlGuard and causes the full partition (~12 k rows in demo, potentially millions in production) to be buffered in memory via `.to_a`. The LIMIT instruction exists only in the LLM system prompt, not in any enforcement layer. | In `execute_readonly`, append `LIMIT <n>` to guard-approved queries before execution (or wrap them in `SELECT * FROM (<sql>) AS _q LIMIT 500`), and surface the cap in the API response. | true | false |
| 3 | high | bug | `app/services/llm_router.rb:65-83` | `@probe_cache` is a module-level instance variable mutated without a mutex. Puma runs with multiple threads (default 5). Two threads can simultaneously read `nil`, both initiate the Ollama probe, and then write concurrently — no synchronization on read or write. While MRI's GIL prevents true memory corruption, this is unsound and breaks under non-MRI Rubies. | Add a `Mutex` (e.g., `PROBE_MUTEX = Mutex.new`) and wrap the cache read/probe/write block with `PROBE_MUTEX.synchronize { ... }`. | false | true |
| 4 | medium | security | `app/services/llm_router.rb:96-103` | `LlmRouter.status` returns `ollama_url: ollama_url` verbatim in the `GET /llm` JSON response. If `OLLAMA_BASE_URL` contains an internal hostname/IP or embedded credentials, this leaks internal network topology to any caller. | Remove `ollama_url` from the public response or replace it with a sanitized boolean (`ollama_configured: available?("ollama")`). | false | true |
| 5 | medium | quality | `app/services/llm_router.rb:125-128` | `rescue StandardError` in `complete` catches all provider errors and silently appends the provider to `fallbacks`, with no log line. Persistent provider failures (auth error, rate limit, parse failure) are completely invisible in logs, making on-call debugging very difficult. | Add `Rails.logger.warn("[LlmRouter] provider=#{provider} error=#{$!.class}: #{$!.message}")` before the `next`. | false | true |
| 6 | medium | security | `app/controllers/ask_controller.rb` | `POST /ask` has no authentication, rate limiting, or per-caller budget cap. With a paid provider configured (Anthropic/OpenAI/OpenRouter), any internet client can trigger arbitrarily many LLM requests at the operator's cost. | For production deployments, add a request-signing header check or Rack middleware rate limiter (e.g., `rack-attack`) before the action. | false | false |
| 7 | low | bug | `app/services/rollup_query.rb:81-91` | `roll_totals` sums the per-committee `distinct_donors` count across all committees. A donor who contributed to two committees is counted twice. The resulting `totals.distinct_donors` is "sum of per-committee distinct donor counts", not a globally unique donor count, yet the field name implies global uniqueness. The test data does not catch this because all test contributions go to one committee. | Either rename the totals field to `donor_committee_pairs` / `per_committee_donor_count_sum`, or compute global uniqueness with a separate query (`COUNT(DISTINCT donor_id)`). | true | false |
| 8 | low | security | `config/initializers/filter_parameter_logging.rb` | The `:question` parameter (submitted to `POST /ask`) is not filtered from Rails request logs. User queries (which may include employer names, personal context, or probing text) are written to the log in plain text. | Add `:question` to the `filter_parameters` array. | false | true |
| 9 | low | security | `config/environments/production.rb:87-92` | When `APP_HOST` is unset, `config.hosts.clear` completely disables Rails' host-authorization (DNS rebinding protection). A production deployment that forgets to set `APP_HOST` silently runs with no host allowlist. The comment frames this as convenient for `docker run` testing, but a misconfigured deploy is left entirely unprotected. | Log a warning when `APP_HOST` is unset in production, or default to a narrow allowlist (e.g., `localhost`, `127.0.0.1`) and require explicit opt-out for the open case. | false | false |

---

## Notes

**What is strong:**
- The two-layer SQL injection defense (SqlGuard keyword scan + READ ONLY transaction) is well-designed and thoroughly tested. The adversarial test matrix in `security_test.rb` covers the expected attack shapes.
- `blank_string_literals` correctly strips single-quoted string content before keyword scanning, preventing false positives on committee names like "Update America PAC".
- The `cycle_param` helper validates the allowlist before touching the database, so cycle-based endpoints never receive an unexpected value.
- The Dockerfile runs as a non-root user, uses a slim base image, and the entrypoint pattern is correct.
- `filter_parameter_logging.rb` covers the major credential patterns.

**What needs attention:**
- Finding #1 is the most operationally visible: an LLM that generates a plausible but wrong column reference (very common) will surface as a 500 to the caller rather than a graceful error.
- Finding #2 is the most consequential at scale: the guard is intentionally permissive (any SELECT passes), so the only protection against a full-table dump is the LLM's LIMIT instruction — which applies only to model-generated queries, not the SQL passthrough path.
- Finding #3 affects correctness under concurrent load but is a small, mechanical fix.
- Findings #4 and #8 are hardening items with no normal-path impact.
