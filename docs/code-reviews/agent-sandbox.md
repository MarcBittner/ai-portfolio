# Code Review — agent-sandbox

> **Remediation status — 5 of 7 findings auto-remediated & verified (2026-06-29).**
> Applied safe, non-UX fixes; re-verified independently (pytest green + ruff clean) and pushed per project.
>
> **Remediated (verified ✅):**
> - `F2` — XSS via unescaped a.url from CDN-fetched catalog
> - `F3` — esc() does not escape quote characters — unsafe for HTML attribute context
> - `F5` — toast(msg) uses innerHTML without escaping msg
> - `F6` — /health endpoint blocks up to 1.5 s on synchronous Ollama probe
> - `F7` — Container-level securityContext hardening fields missing
>
> **Verification proof:** `52 passed, 8 skipped, 1 xfailed, 1 warning in 0.38s` · ruff clean.
> Remaining findings in the table below were not auto-applied (UX-impacting or needing a design decision) — open for manual triage.


**Health summary:** Fair — one confirmed HTTP 500 bug (acknowledged/xfail'd in tests), two latent XSS vectors in the frontend, and a handful of low-severity hardening gaps; the Python core and its security posture are solid.

---

## Findings

| # | Severity | Category | File | Finding | Recommendation | UX Impact | Auto-fixable |
|---|----------|----------|------|---------|----------------|-----------|-------------|
| 1 | high | bug | `src/agent_sandbox/tools.py:45` / `agent.py:54-57` | `float(result).is_integer()` raises `OverflowError` for huge integer results (e.g. `9999 ** 9999`). `exec_tool` only catches `ToolError` and `TypeError`; the uncaught `OverflowError` propagates to FastAPI and returns HTTP 500. Already documented as `xfail(strict=True)` in `tests/test_security.py:120`. | Add `OverflowError` to the except clause on `tools.py:42` (alongside `ZeroDivisionError`), or catch it in `exec_tool` alongside the existing exceptions. | yes | yes |
| 2 | medium | security | `static/index.html:829` | The app-launcher widget builds card links with `href="'+a.url+'"` — `a.url` is inserted raw into the HTML string without sanitization. `APPS` is initially safe (hardcoded `https://` URLs), but a CDN fetch on line 814 can replace the entire array with content from `cdn.jsdelivr.net/gh/…/catalog.json`; a compromised CDN response or repo commit could supply `javascript:…` URLs, triggering XSS when a user clicks the card. | Validate each URL before inserting it as an href: only allow `https://` protocol (e.g. `if(!/^https:\/\//.test(a.url))return '';`). Use `document.createElement('a')` with `.href` assigned instead of string concatenation. | false | yes |
| 3 | medium | security | `static/index.html:483` | `esc()` only escapes `&`, `<`, `>` but not `"` or `'`. It is used inside double-quoted HTML attributes (`data-q="${esc(s)}"` on line 519). A value containing `"` would break out of the attribute boundary. Currently harmless because `SAMPLES` is a hardcoded array, but the function is incorrect for attribute context and a copy-paste risk. | Escape `"` → `&quot;` and `'` → `&#39;` in `esc()`, or use `document.createElement`+`.setAttribute` for attribute values. | false | yes |
| 4 | medium | quality | `src/agent_sandbox/api.py`, `llm.py` | No rate limiting on `/run` or `/tool`. Each `/run` call can trigger up to `MAX_STEPS=8` LLM calls at `LLM_TIMEOUT=45 s` each. A single client can hold many connections open indefinitely, effectively denying service to other users. | Add a per-IP or global rate limiter (e.g. `slowapi`) and cap `LLM_TIMEOUT` for the planner. For the K8s deployment, apply an Ingress rate limit annotation. | false | false |
| 5 | low | security | `static/index.html:486` | `toast(msg)` inserts `msg` via `innerHTML` without escaping. Currently all call sites pass string literals, so there is no exploitable path today. A future caller that passes server-derived text would create a stored/reflected XSS. | Change to `t.textContent = msg` (and keep the `<span class="tdot"></span>` as a sibling created with `createElement`), or at minimum escape `msg` with `esc()`. | false | yes |
| 6 | low | performance | `src/agent_sandbox/api.py:39`, `llm.py:201-208` | The `/health` endpoint calls `llm.reachable()` synchronously, which opens a socket to Ollama with a 1.5 s timeout on every request. The K8s manifest runs liveness probes every 15 s and readiness probes every 5 s; under Ollama unavailability each probe blocks for 1.5 s, inflating pod latency budgets. | Cache the Ollama reachability result with a short TTL (e.g. 10 s) in a module-level variable, or return it from a background task rather than on the hot health path. | false | yes |
| 7 | low | security | `deploy/k8s/agent-sandbox.yaml:29-37` | The pod-level `securityContext` sets `runAsNonRoot`/`runAsUser` but the container spec lacks `allowPrivilegeEscalation: false`, `readOnlyRootFilesystem: true`, and `capabilities: drop: [ALL]`. These are standard K8s hardening defaults for a stateless service that writes no files. | Add a container-level `securityContext` block with `allowPrivilegeEscalation: false`, `readOnlyRootFilesystem: true`, and `capabilities.drop: [ALL]`. | false | yes |

---

## Notes

**What works well:** The Python backend is well-structured. The AST-based calculator sandbox is correct and well-tested. `exec_tool` converts unknown-tool and bad-arg errors into `(observation, ok=False)` tuples rather than HTTP 500s — except for the `OverflowError` gap. The security test suite is unusually thorough for a demo app: it plants secret canaries, tests all adversarial inputs, and formally documents the known OverflowError bug with `xfail(strict=True)`, meaning the CI will alert if the bug is accidentally fixed or silently regressed.

**OverflowError fix (finding #1):** The one-line fix is to extend the `except` clause in `tools.py:42`:
```python
except (SyntaxError, TypeError, ZeroDivisionError, ValueError, OverflowError) as exc:
```
This catches the overflow before it reaches `is_integer()` and converts it into a `ToolError`, which `exec_tool` already handles correctly.

**CDN supply-chain XSS (finding #2):** The external CDN fetch is a reasonable UX choice but the missing URL-protocol check is a concrete XSS sink. The fix is a one-liner inside the `render()` function at line 828.

**Dependency pinning:** `pyproject.toml` uses `>=` bounds for all runtime deps (`fastapi>=0.115`, `pydantic>=2.7`, `uvicorn>=0.30`). No upper bound or lockfile is shipped. This is typical for a library-style project but could silently pick up a breaking major version in production. Consider adding a `requirements.lock` generated by `pip-compile` in CI.
