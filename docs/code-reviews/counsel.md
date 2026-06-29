# counsel — Code Review

> **Remediation status — 9 of 14 findings auto-remediated & verified (2026-06-29).**
> Applied safe, non-UX fixes; re-verified independently (pytest green + ruff clean) and pushed per project.
>
> **Remediated (verified ✅):**
> - `SEC-002` — No CORS or CSRF protection on mutating endpoints
> - `BUG-001` — Race condition: concurrent add_transaction calls produce duplicate IDs
> - `BUG-002` — Dataset cache initialisation is not thread-safe
> - `SEC-003` — Module-level cooldown and probe-cache dicts accessed concurrently without locks
> - `SEC-004` — Shell injection via unquoted --url flag in run.sh
> - `QUAL-001` — _round2 helper duplicated across data.py and compute.py
> - `QUAL-002` — Gratuitous identity dict copy in _build_user_prompt
> - `QUAL-003` — Bare except Exception: pass in _fetch_free_catalog silently swallows errors
> - `QUAL-004` — SPA esc() helper does not escape double-quotes
>
> **Verification proof:** `89 passed, 9 skipped, 1 warning in 0.68s` · ruff clean.
> Remaining findings in the table below were not auto-applied (UX-impacting or needing a design decision) — open for manual triage.


**Health:** fair — strong trust-gate architecture and good test coverage, held back by real concurrency bugs and unguarded admin endpoints.

---

## Findings Table

| ID | Severity | Category | File | Finding | Recommendation | UX Impact | Auto-fixable |
|----|----------|----------|------|---------|----------------|-----------|--------------|
| SEC-001 | medium | security | `src/counsel/api.py:258-272` | `POST /admin/reset_data` and `POST /admin/reset_queue` have no authentication. Any caller can wipe the approval queue or restore the dataset to seed state. | Add a shared-secret header check or a simple token env-var guard, even for a demo. In production, move these behind proper authz. | true | true |
| SEC-002 | medium | security | `src/counsel/api.py` (all mutating routes) | No CORS policy is configured. FastAPI defaults to allow-all origins, so any webpage can POST to `/ask`, `/propose`, `/decide`, and `/transactions` via CORS fetch. | Add `fastapi.middleware.cors.CORSMiddleware` with an explicit `allow_origins` list. | false | true |
| SEC-003 | low | security | `src/counsel/data.py:256-263` | `add_transaction` computes the user-transaction counter (`n_user`) and then appends in two non-atomic steps. Concurrent POST `/transactions` requests can both observe the same `n_user` and create two transactions sharing the same `txn_user_NNN` ID. `ds.txn()` returns only the first match, silently masking the second. | Protect `add_transaction` with a module-level `threading.Lock`, or replace the sequential counter with `uuid.uuid4().hex[:8]`. | false | true |
| SEC-004 | low | security | `src/counsel/llm.py:84,179` | `_COOLDOWN` and `_probe_cache` are module-level dicts written without a lock. The `/diagnostics` endpoint fans out into a `ThreadPoolExecutor`, so concurrent reads and writes race. CPython's GIL makes individual dict operations safe, but compound check-then-write is not atomic. | Wrap both dicts in a `threading.Lock`, or use `threading.local()` for per-thread caching. | false | true |
| SEC-005 | low | security | `run.sh:113` | The `$url` value (from `--url` CLI flag) is interpolated directly into a Python one-liner executed via `-c`: `urlopen('$url/health', ...)`. A URL containing a single quote breaks the Python expression, and a sufficiently crafted value could inject arbitrary Python. | Pass the URL via an env var instead: `HEALTH_URL="$url/health" py -c "import os,urllib.request; urllib.request.urlopen(os.environ['HEALTH_URL'],timeout=2)"`. | false | true |
| BUG-001 | medium | bug | `src/counsel/data.py:196-203` | `build_dataset()` checks `if _CACHE is None` and assigns `_CACHE` in two separate steps with no lock. Under concurrent requests (possible when FastAPI starts), two threads can both see `None` and both build — typically harmless since both builds are deterministic, but not guaranteed. `reset_dataset()` sets `_CACHE = None` then calls `build_dataset()`, creating a wider race window. | Add a `threading.Lock` around the cache check-and-set in `build_dataset()` and `reset_dataset()`. | false | true |
| BUG-002 | low | bug | `src/counsel/agent.py:186-187` | `_parse()` falls back to using the raw LLM text verbatim as the `answer` when the model returns non-JSON prose. This is documented, but the fallback also skips citation extraction, so any citations the prose contained are silently lost rather than surfaced as `dropped_citations`. | On prose fallback, attempt a secondary regex-based citation scan before giving up; or at minimum record in `dropped_citations` that citations were unextractable. | false | false |
| BUG-003 | low | bug | `src/counsel/agent.py:139` | `_offline_narration` returns the generic string `"Here is what your records show."` for any intent not explicitly handled (e.g. a future intent added to `compute.py` but not yet to `_offline_narration`). Silent fallback makes the omission hard to notice. | Raise `NotImplementedError` or return a clearly labelled placeholder to make new-intent gaps visible during development. | true | true |
| QUAL-001 | low | quality | `src/counsel/data.py:114` and `src/counsel/compute.py:52` | `_round2(x)` is defined identically in two modules (`round(x + 1e-9, 2)`). | Move to a single shared utility module (e.g., `counsel/math_utils.py`) imported by both. | false | true |
| QUAL-002 | low | quality | `src/counsel/agent.py:157` | `facts = {k: v for k, v in comp.facts.items()}` is an identity copy that adds no value before `json.dumps(facts)`. | Replace with `comp.facts` directly (JSON serialisation does not mutate the input). | false | true |
| QUAL-003 | low | quality | `src/counsel/llm.py:133` | `except Exception: pass` in `_fetch_free_catalog()` silently swallows all errors — network timeouts, JSON parse failures, and unexpected API shape changes are all indistinguishable. | At minimum `log.debug(exc, exc_info=True)` so transient catalog failures are visible in logs without surfacing to users. | false | true |
| QUAL-004 | low | quality | `src/counsel/static/index.html:514` | The `esc()` helper escapes `&`, `<`, `>` but not `"`. Values interpolated into HTML attribute contexts (`data-q="${esc(x.q)}"`, `title="${x.kind}"`) are currently safe because they come from hardcoded server data, but the omission is a fragile defence-in-depth assumption. | Add `"` → `&quot;` to the replacement map. | false | true |
| PERF-001 | low | performance | `src/counsel/retrieve.py:113-134` | `_records_for()` calls `ds.txn(cid)` for every citation ID. `ds.txn()` is a linear scan of `ds.transactions`. For a large citation set (e.g., spend-breakdown over a full year) this is O(n × m). Similarly, `account_balance()` rescans all transactions per account, called once per account in `net_worth()`. | Build an index dict `{id: txn}` at `Dataset` construction time (or lazily on first access) to make lookups O(1). | false | false |

---

## Notes

### What is solid

- **Trust-gate architecture** is well-designed and thoroughly tested: the copilot can only propose; humans approve; approval is simulated and never mutates ground truth. The invariant is tested at the unit, integration, and security levels.
- **Guardrail is pre-model and deterministic**: discriminatory / unlicensed-advice questions are refused before any provider call, regardless of which model is active, with no reliance on model goodwill.
- **Verify gate**: the LLM's stated numbers are extracted and compared against code-computed facts. A wrong number is flagged; the code value is always shown as authoritative. Hallucinated citations are dropped before the response is returned.
- **Test coverage** is comprehensive: unit, API (TestClient), security, browser-host bridge, and live smoke tests. The `test_security.py` suite is particularly thorough.
- **Offline fallback**: the full pipeline runs with zero API keys; the eval reproduces to the digit. The deterministic path is the design centre, not a hack.

### Priority fixes

1. **SEC-003 (concurrent add_transaction)** is the only race condition with a concrete, demonstrable duplicate-ID outcome. Add a module-level lock to `add_transaction`.
2. **SEC-001 (unauthenticated admin resets)** should be gated behind at minimum a shared-secret header before the app is exposed beyond localhost.
3. **SEC-002 (CORS)** should be configured explicitly for any deployment — the current allow-all-origins default is fine for local dev but not for a deployed instance.
