# Code Review — synth-data

> **Remediation status — 5 of 10 findings auto-remediated & verified (2026-06-29).**
> Applied safe, non-UX fixes; re-verified independently (pytest green + ruff clean) and pushed per project.
>
> **Remediated (verified ✅):**
> - `SD-02` — Portfolio launcher URL not HTML-escaped; supply-chain XSS via external CDN
> - `SD-03` — llm.reachable() makes a live HTTP call on every /health probe
> - `SD-05` — HTTP status code not preserved in LLM provider fallback trace
> - `SD-08` — gen_uuid does not set RFC 4122 version/variant bits
> - `SD-10` — Missing response_model on /generate leaves response shape undocumented
>
> **Verification proof:** `47 passed, 8 skipped, 1 warning in 0.21s` · ruff clean.
> Remaining findings in the table below were not auto-applied (UX-impacting or needing a design decision) — open for manual triage.


**Health:** fair — solid architecture, good test coverage, no hardcoded secrets or unsafe execution; 4 medium findings (2 security, 2 performance) and 6 low findings.

Reviewed: 2026-06-29  
Reviewer: Claude Sonnet 4.6 (automated)

---

## Findings Table

| ID | Severity | Category | File | Finding | Recommendation | UX Impact | Auto-fixable |
|----|----------|----------|------|---------|----------------|-----------|-------------|
| SD-01 | medium | security | `static/index.html:565` | Column names from API are interpolated directly into `<th>` elements without HTML-escaping. `data.columns.map(c => \`<th>${c}</th>\`)` — no call to `esc()`. A field named `<script>alert(1)</script>` executes in the renderer's browser. Since there is no auth this is self-XSS, but it is a real DOM injection. | Apply the already-present `esc()` helper: `` `<th>${esc(c)}</th>` `` | true | true |
| SD-02 | medium | security | `static/index.html:800` | Portfolio launcher builds anchor tags by string-concatenating `a.url` without HTML-escaping: `'href="'+a.url+'"'`. A catalog entry whose URL contains `"` breaks the attribute context. The catalog is fetched live from an external CDN (cdn.jsdelivr.net), so a compromised CDN or repo push to `ai-portfolio@main` yields stored XSS in every visitor's browser. | HTML-escape `a.url` before insertion, or use `document.createElement('a')` + `.href = a.url` + `.appendChild(...)` instead of innerHTML string concatenation. | false | true |
| SD-03 | medium | performance | `src/synth_data/api.py:40` | `health()` calls `llm.reachable()` on every invocation. `reachable()` makes a live HTTP GET to `OLLAMA_BASE_URL/api/tags` with a 1.5-second timeout. The Kubernetes manifest probes `/health` every 5 s (readiness) and 15 s (liveness). When Ollama is absent the probe blocks the single-worker uvicorn process for 1.5 s on every check — potentially starving real requests 30 % of the time. | Cache the reachability result with a short TTL (e.g., 10–30 s) using `functools.lru_cache` with a timestamp check, or move the ollama probe to its own `/providers` path and return a static boolean in `/health`. | false | true |
| SD-04 | medium | performance | `src/synth_data/api.py:82-103` | When a schema has multiple `llm`-typed fields, each is filled by a sequential blocking HTTP call inside a `for` loop. Three LLM fields with a 45-second timeout cap could block the request for 135 s. The app uses sync endpoints and `urllib.request`; there is no concurrency mechanism. | Use `concurrent.futures.ThreadPoolExecutor` to issue LLM calls in parallel, then merge results. Alternatively convert the endpoint to `async def` and use `asyncio.gather` once the HTTP layer is async. | true | false |
| SD-05 | low | bug | `src/synth_data/llm.py:173-174` | LLM provider failures are recorded as `f"{p}: {type(exc).__name__}"` in the fallback list. `urllib.error.HTTPError` (a subclass of `URLError`) is caught without preserving the HTTP status code. A 401 (bad key) and a 503 (provider overloaded) look identical in the routing info returned to the caller. | Change the fallback append to `f"{p}: {type(exc).__name__}({getattr(exc, 'code', '')})"` to surface the HTTP status when available. | false | true |
| SD-06 | low | quality | `src/synth_data/generators.py:87` | `gen_choice` replaces an empty `choices` list with `["a","b","c"]` via `spec.get("choices") or ["a","b","c"]`. An empty list is falsy, so the user receives unexpected output instead of a validation error. Every other constraint violation (unknown type, missing name, inverted int range) raises `ValueError` → 422; this one silently emits data. | Add `if not choices: raise ValueError("choice field requires at least one option")` before calling `rng.choice`. | true | true |
| SD-07 | low | bug | `src/synth_data/llm_gen.py:26` | `fill_column` returns `None` if the parsed list has fewer than `n` elements. A response of `n-1` items (LLM truncated the last entry) causes the entire column to fall back to the deterministic placeholder rather than using the partial result. | Accept partial results: return the parsed values for rows 0…len(parsed)-1 and keep the deterministic placeholder for the remaining rows, or at minimum allow a configurable threshold (e.g., ≥80 % of n). | true | true |
| SD-08 | low | quality | `src/synth_data/generators.py:49-51` | `gen_uuid` constructs UUID-like strings from a seeded `random.Random` but does not set the RFC 4122 version (4) or variant bits. The generated strings look like UUIDs but fail strict UUID parsers (e.g., `uuid.UUID(s)` in Python raises `ValueError` for wrong variant bits). | Apply the required bit masks: byte 6 `= (byte6 & 0x0f) | 0x40` (version 4) and byte 8 `= (byte8 & 0x3f) | 0x80` (variant 1). A simpler route is to seed a `random.Random`-backed `uuid.UUID` factory by monkey-patching `os.urandom` in a thread-local, or just store a deterministic hex string and note it is "UUID-shaped, not RFC 4122". | false | true |
| SD-09 | low | security | `src/synth_data/api.py:58` | `/generate` has no rate limiting. Every POST can trigger one or more outbound LLM calls (Anthropic, OpenAI, or OpenRouter) billed to the server's API keys. A burst of requests could exhaust API quota or run up costs. | Add a per-IP or global request-rate middleware (e.g., `slowapi` for FastAPI) or an upstream reverse-proxy rule. For the demo tier, even a simple in-process token bucket on the `use_llm=True` path is sufficient. | false | false |
| SD-10 | low | quality | `src/synth_data/api.py:59` | `/generate` has no `response_model`. FastAPI skips response validation and schema generation for this endpoint; the OpenAPI docs show no response shape. This is partly intentional (dual JSON/CSV return), but it means errors in the response dict are not caught at the boundary. | Use a `Union[GenerateResponse, Response]` response type annotation or document the CSV branch with `responses={200: {"content": {"text/csv": {}}}}` so the API schema is complete. | false | true |

---

## Notes

**What is clean:**
- No hardcoded API keys; all credentials come from environment variables.
- No `eval`, `exec`, `subprocess`, or `pickle` anywhere in the codebase.
- `FileResponse(STATIC_DIR / "index.html")` serves a fixed compiled path — no path-traversal risk.
- The `esc()` helper is correctly applied to all row *values* in the table body; only column *names* are missed (SD-01).
- `_post()` URL construction uses only fixed hosts from operator-controlled env vars, so SSRF is not user-reachable.
- Error handling in `api.py` wraps both `ValueError` from generators and unknown presets with explicit 422 responses; the server never returns a 500 on malformed input.
- The security test suite (`test_security.py`) is thorough: secret leakage, adversarial schemas, offline determinism, and PII-free guarantees are all covered at scale.
- Kubernetes manifest runs as non-root (uid 1001), has resource limits, and the image does not run as root.

**Areas not covered by existing tests:**
- Inverted `min`/`max` for `integer` type (produces opaque `ValueError: empty range for randrange()` rather than a friendly message).
- Column name HTML injection (SD-01) — the adversarial test set checks for 5xx but not XSS.
- Health-probe latency under Ollama absence is not measured.
