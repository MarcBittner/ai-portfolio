# quorum — Code Review

**Health: fair** — Well-structured demo with strong governance primitives, good test coverage, and no hardcoded secrets. Two real defects stand out: a thread-safety race in `AuditLog` that can corrupt the hash chain during every parallel fan-out, and an unguarded `/evals` endpoint that runs the full eval pipeline on every GET with no caching or rate limiting.

---

## Findings

| # | Severity | Category | File | Finding | Recommendation | UX Impact | Auto-fixable |
|---|----------|----------|------|---------|----------------|-----------|--------------|
| 1 | high | bug | `governance.py:91–96`, `orchestrator.py:124–129` | `AuditLog.append()` is not thread-safe. The compound read-seq-append is not atomic; threads in the parallel fan-out can interleave, producing two entries with the same `seq` and `prev_hash`. `verify()` then reports the chain broken, negating the tamper-evidence claim. | Add a `threading.Lock` to `AuditLog`; acquire it for the entire read-compute-append sequence in `append()` and `verify()`. | yes | yes |
| 2 | high | performance | `api.py:166–169`, `evaluate.py:35–77` | `GET /evals` runs the full multi-agent eval pipeline over all contracts synchronously on every request (21 agent offline calls). With no auth and no rate limiting, repeated requests exhaust a single worker. | Cache the result (e.g., `functools.lru_cache` or a module-level `_eval_cache` invalidated on restart); return cached result with an `age_s` field. | no | yes |
| 3 | medium | security | `api.py` (all POST endpoints) | No request-body size limit is enforced. FastAPI/uvicorn accept bodies of arbitrary size; a large `text` or `payload` will be fully buffered and processed before the LLM `max_tokens` cap limits output. | Add a `max_content_length` check in a dependency or use uvicorn's `--limit-concurrency` / a middleware that enforces a size cap (e.g., 512 KB). | no | yes |
| 4 | medium | bug | `llm.py:213–215` | `except Exception: fallbacks.append(provider); continue` silently discards all provider failures, including revoked keys, changed API schemas, and unexpected server errors. There is no logging. A broken paid provider silently falls through to the next tier with no operator visibility. | Log the exception at `WARNING` level (e.g., `logging.warning("provider %s failed: %s", provider, exc)`) before continuing. | no | yes |
| 5 | medium | security | `index.html:472` | `toast(msg)` sets `innerHTML` with an unescaped `msg` parameter. All current call sites pass static strings or server-returned numeric/boolean values, so there is no active exploit path. But adding a single call site with server-derived text (e.g., an error message) would be XSS. | Change the function to set `textContent` for the message part, or escape `msg` with the existing `esc()` helper before insertion. | no | yes |
| 6 | medium | security | `api.py:31–33`, `api.py:153–163` | Run traces (with redacted prompt summaries) are stored in a shared global `_RUNS` dict with no per-user isolation. Any caller who knows or correctly guesses a `run_id` can retrieve another session's trace. Run IDs are short UUIDs (`hex[:10]` = 40 bits), which reduces the search space. | Use full UUIDs (`uuid4().hex` = 128 bits) for run IDs, or add session tokens if multi-tenant use is anticipated. | no | yes |
| 7 | low | performance | `api.py:40` | `_RUN_ORDER.pop(0)` on a plain `list` is O(n). At `_MAX_RUNS=50` this is negligible, but it is semantically a queue. | Replace `_RUN_ORDER: list[str]` with `collections.deque(maxlen=_MAX_RUNS)` and drop the `while` eviction loop. | no | yes |
| 8 | low | performance | `workflows.py:373–381` | `registry()` and `get_spec()` reconstruct all `WorkflowSpec` and `Agent` objects (including closure allocation) on every call. They are invoked on every `/health`, `/workflows`, `/run`, `/review`, and `/plan` request. | Module-level constants: `_REGISTRY = {"contract-review": _contract_review_spec(), "policy-qa": _policy_qa_spec()}` and expose `registry()` / `get_spec()` as thin wrappers. | no | yes |
| 9 | low | quality | `workflows.py:268–270` | In `_terms()`, the set comprehension already filters `w not in _STOPWORDS`; the trailing `- _STOPWORDS` set-difference is redundant. | Remove `- _STOPWORDS` from the end of the expression. | no | yes |
| 10 | low | quality | `workflows.py:38`, `governance.py:134` | `stages: list` (WorkflowSpec) and `def rollup(steps: list)` use bare `list` instead of typed generics, reducing static analysis value. | `stages: list[Agent \| list[Agent]]` and `steps: list[StepResult]` (with `StepResult` from `quorum.agent`). | no | yes |
| 11 | low | quality | `orchestrator.py:162–176` | In `plan_prompts()`, each agent's prompt is computed twice per parallel stage: once to build the plan output, and once to advance shared state via the offline fallback. | Compute and cache the prompt once per agent, then reuse it for both the plan entry and the state-advance step. | no | yes |

---

## Notes

**What is well done:**
- PII redaction runs in the orchestrator _before_ every model call and again before every audit write — it is a property of the engine, not of any workflow, and is thoroughly tested.
- The hash-chained `AuditLog` is correctly structured; `verify()` detects both broken links and content edits. The `demo_tamper()` method is useful and correctly scoped.
- The `offline` fallback makes every agent deterministic with zero keys — the eval numbers reproduce exactly, which is a strong demo discipline.
- The LLM routing chain is clean: one file, stdlib-only HTTP, no hidden globals, and the `_available()` probe-cache avoids hammering Ollama.
- Test coverage is solid: unit, governance, orchestrator, security (with secret canaries and adversarial inputs), and live smoke are all present.
- No hardcoded secrets anywhere; `.env.example` is explicit about never committing keys.

**Thread-safety detail (finding #1):**
In `AuditLog.append()` the sequence `prev = self._entries[-1]["hash"]; seq = len(self._entries); ...; self._entries.append(entry)` is not atomic. Under `ThreadPoolExecutor` with multiple parallel risk scorers, two threads can both read the same `prev` and the same `seq`, producing duplicate `seq` values and a broken `prev_hash` chain. CPython's GIL makes the individual `list.append` safe but does not protect the compound read-modify-append. The fix is one `threading.Lock` on the `AuditLog`.

**`/evals` detail (finding #2):**
With the offline fallback the eval completes in milliseconds, but it still involves full JSON parsing, hashing, and Python-level object construction for 21 agent invocations × chain-hash verification per request. A simple module-level cache (reset on process start) eliminates the redundant work without changing the API contract.
