# Code Review — doc-extract

> **Remediation status — 6 of 10 findings auto-remediated & verified (2026-06-29).**
> Applied safe, non-UX fixes; re-verified independently (pytest green + ruff clean) and pushed per project.
>
> **Remediated (verified ✅):**
> - `DE-01` — XSS via unsanitized href from CDN-fetched catalog
> - `DE-02` — Unescaped server-controlled field names and method in innerHTML
> - `DE-03` — Schema name and description unescaped in option elements
> - `DE-04` — Dockerfile CMD uses unquoted shell variable expansion for PORT
> - `DE-06` — complete_json() silently swallows responses with no closing JSON delimiter
> - `DE-10` — Missing return-type annotations on llm_fill() and client_fill()
>
> **Verification proof:** `43 passed, 7 skipped, 1 warning in 0.23s` · ruff clean.
> Remaining findings in the table below were not auto-applied (UX-impacting or needing a design decision) — open for manual triage.


**Health:** good — well-structured, well-tested, solid trust-boundary design; one medium security fix and a handful of low-severity polish items.

---

## Findings

| # | Severity | Category | File | Finding | Recommendation | UX Impact | Auto-fixable |
|---|----------|----------|------|---------|----------------|-----------|--------------|
| 1 | medium | security | `src/doc_extract/static/index.html` ~line 842 | App launcher fetches `catalog.json` from `cdn.jsdelivr.net` and interpolates `a.url` directly into an `href` attribute with no scheme check. A `javascript:` URL supplied by a compromised CDN or GitHub repo would execute when a user clicks the card. `a.name`/`a.tag` are correctly passed through `esc()`, but the URL is not. | Validate the scheme before use: `var safeUrl = /^https?:\/\//.test(a.url) ? a.url : '#';` and use `safeUrl` in the template. | false | true |
| 2 | low | security | `src/doc_extract/static/index.html` lines 590, 595, 599, 580 | `f.name` and `f.method` from the API response, and `s.name` in the `<mark title="…">` attribute, are interpolated into innerHTML without `esc()`. Currently harmless because field names are hardcoded identifiers ("invoice\_number", "label", etc.), but violates defense-in-depth. | Apply `esc()` to all server-derived values before inserting into HTML, including `f.name`, `f.method`, and attribute values derived from schema data. | false | true |
| 3 | low | security | `src/doc_extract/static/index.html` line 517 | Schema names and descriptions from `GET /schemas` are templated into `<option>` elements without HTML-escaping. Same root cause as finding 2; the current schema definitions are safe. | Wrap `s.name` and `s.description` in `esc()` when building the `opts` string. | false | true |
| 4 | low | security | `Dockerfile` line 14 | `CMD ["sh", "-c", "uvicorn … --port ${PORT}"]` expands `PORT` in a shell string. If `PORT` is set to a value containing shell metacharacters (e.g., by a misconfigured orchestrator), it is a command injection vector. In practice the platform supplies a numeric value. | Use an entrypoint script or Python: `CMD ["sh", "-c", "exec uvicorn doc_extract.api:app --host 0.0.0.0 --port \"${PORT}\""]` (quoting the expansion). Better yet, invoke uvicorn directly via a small wrapper that validates PORT is numeric first. | false | true |
| 5 | low | bug | `src/doc_extract/extract.py` lines 98-104 | `_global()` does not strip trailing punctuation (`.`, `,`, `;`) from captured values, while `_anchored()` does (`.rstrip(".,;")`). For URL-type fields the value pattern `[^\s,;]+` matches a trailing `.`, so a URL like `https://example.com.` is returned as-is; `_validate()` then marks it valid because `[^\s,;]+` in fullmatch also accepts the dot. The extracted URL value is incorrect. | Apply `.rstrip(".,;")` (and re-compute `end`) in `_global()` before returning, mirroring `_anchored()`. | true | true |
| 6 | low | bug | `src/doc_extract/llm.py` lines 193-195 | In `complete_json()`, when both `rfind("}")` and `rfind("]")` return -1 (no closing delimiter found), `end = max(-1, -1) = -1` and `raw[start:0]` is empty, causing `json.loads` to raise and the function to silently return `None`. This means LLM responses that happen to be missing a closing bracket are indistinguishable from mock responses. | Add an early guard: `if end == -1: return None, result` before the `json.loads` call, and consider logging the parse failure at DEBUG level for easier diagnosis. | false | true |
| 7 | low | quality | `pyproject.toml`, `Dockerfile` | Dependencies use only lower-bound version pins (`fastapi>=0.115`, etc.) with no lockfile. Docker image builds are not reproducible across time; a dependency update could silently break the service. | Generate and commit a `requirements.txt` (via `pip-compile`) or `uv.lock`, and reference it in the Dockerfile with `pip install --no-cache-dir -r requirements.txt`. | false | false |
| 8 | low | performance | `src/doc_extract/llm.py` lines 201-208, `src/doc_extract/api.py` line 39-40 | `reachable()` makes a blocking HTTP probe to Ollama (up to 1.5 s) on every call. It is invoked synchronously on every `GET /health` and `GET /providers` request. Under load, or when Ollama is slow, health checks will be artificially slow. | Cache the probe result with a short TTL (e.g., 5–10 s), similar to how the browser caches it with `_ollamaProbe`. | false | false |
| 9 | low | quality | `src/doc_extract/llm.py` lines 155-170 | The `else: continue` branch in `complete()` is dead code. `_resolve_order()` only includes a provider when its API key is present; the key-check guards in the `elif` branches are therefore always true for the providers that appear in the chain. | Remove the key-check guards from inside `complete()` (rely on `_resolve_order()` as the single source of truth) or document the defensive intent with a comment. Also add "skipped" entries to `fallbacks` for transparency. | false | false |
| 10 | low | quality | `src/doc_extract/llm_extract.py` lines 42, 55 | `llm_fill()` and `client_fill()` lack return-type annotations. Callers have to read the body to discover the return shape. | Add `-> tuple[list[Extracted], LLMResult | None]` and `-> list[Extracted]` respectively. | false | true |

---

## Notes

**What's done well.** The deterministic extraction core is thoroughly unit-tested including provenance spans, normalization, confidence scoring, and the trust-boundary invariant that the deterministic pass always wins over LLM fill. The security test suite (`test_security.py`) covers secret leakage, input hardening (22 adversarial cases), prompt injection, and the regex-wins-always contract. The server never returns API keys — only boolean availability flags. The `text` field has a `max_length=100_000` guard preventing unbounded regex execution. `_build_filled()` type-validates all LLM-supplied values. Non-root Docker image and k8s `runAsNonRoot` are correctly applied.

**XSS finding (1) is the only actionable security issue.** It requires compromise of the CDN or GitHub repo (`MarcBittner/ai-portfolio@main`) to exploit, but the fix is a one-liner.

**Findings 2–3** are defense-in-depth: no user input reaches those unescaped slots today, but a future schema addition with a description containing `<` would be a real XSS.

**Finding 5** (URL trailing dot) is a minor accuracy defect in the extractor, not a security concern.
