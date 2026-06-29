# Code Review: llm-gateway

> **Remediation status — 8 of 10 findings auto-remediated & verified (2026-06-29).**
> Applied safe, non-UX fixes; re-verified independently (pytest green + ruff clean) and pushed per project.
>
> **Remediated (verified ✅):**
> - `LLM-GW-001` — Audit log stores raw secrets when GATEWAY_REDACT_INPUT=False
> - `LLM-GW-002` — Thread-safety: AuditLog and CircuitBreaker lack locking under FastAPI threadpool
> - `LLM-GW-003` — Unauthenticated /v1/audit/_demo_tamper exposes audit mutation in production
> - `LLM-GW-004` — XSS: user-supplied model field reflected into innerHTML without HTML-escaping
> - `LLM-GW-007` — No HTTP security headers (CSP, X-Content-Type-Options, X-Frame-Options)
> - `LLM-GW-008` — IP_ADDRESS regex matches invalid octets (false-positive redaction)
> - `LLM-GW-009` — CompleteRequest.system field has no max_length constraint
> - `LLM-GW-010` — complete_json() in llm.py is dead code
>
> **Verification proof:** `62 passed, 10 skipped, 1 warning in 0.26s` · ruff clean.
> Remaining findings in the table below were not auto-applied (UX-impacting or needing a design decision) — open for manual triage.


**Health:** fair — solid governance architecture and well-exercised deterministic guardrails, but sync FastAPI endpoints share mutable state without locking, the audit log stores raw secrets under a known misconfiguration, and the frontend reflects user-controlled fields into innerHTML without HTML-escaping.

---

## Findings

| # | Severity | Category | File | Finding | Recommendation | UX Impact | Auto-fixable |
|---|----------|----------|------|---------|----------------|-----------|--------------|
| 1 | high | security | `gateway.py:92` | When `policy.redact_input=False`, the raw unredacted prompt (possibly containing API keys or PII) is written verbatim into the audit log's `request` field. The audit module's docstring explicitly guarantees entries hold only redacted text. Acknowledged as a known bug via an `xfail(strict=True)` test in `test_security.py:248`. | Before writing to the audit log, always run the redact pass on the stored text regardless of the `redact_input` policy flag. Separate the "what the provider sees" redaction from the "what is stored" redaction. | false | true |
| 2 | high | bug | `audit.py`, `llm.py` | All API endpoints are synchronous (`def`, not `async def`). FastAPI dispatches sync handlers to anyio's default thread pool (≈40 concurrent threads). `AuditLog._entries` (a plain list) and `CircuitBreaker._fail`/`_opened` (plain dicts) are module-level singletons mutated by every request — with no locking. This causes data races under concurrent load: duplicate `seq` values, lost failure counts, or list corruption. | Add `threading.Lock` to `AuditLog.append/verify/entries` and to `CircuitBreaker.record_success/record_failure/is_open`, or convert the handlers to `async def` (but then the blocking `urllib` calls must move to threads/async). | false | true |
| 3 | medium | security | `api.py:94-98` | `/v1/audit/_demo_tamper` is an unauthenticated POST endpoint that silently mutates an audit log entry without re-hashing. Any client can flip a logged governance decision to `allow` and corrupt the tamper-evident chain. Labeled "demo aid only" but enabled on all deployments including the live Render instance. | Gate the endpoint behind an env-var feature flag (`GATEWAY_DEMO_TAMPER=1`) and return `501 Not Implemented` otherwise. Better: remove it from the API entirely; call `demo_tamper()` only from the CLI demo script. | false | true |
| 4 | medium | security | `static/index.html:550` | The user-supplied `model` field from `CompleteRequest` is returned verbatim in the API response and interpolated into `innerHTML` without HTML-escaping: `` `/ ${r.model} ·` ``. A malicious value like `<img src=x onerror=...>` executes in the browser. This is self-XSS in the current single-user UI flow, but the pattern is unsafe and becomes exploitable if the app is extended (shared audit view, server-side session tokens, etc.). The output field escapes only `<` (`replace(/</g,"&lt;")`), leaving `>`, `"`, `'`, and `&` unescaped. | Add a minimal HTML-escape helper (`s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")`) and apply it to every server-returned field before inserting into innerHTML: `r.model`, `r.provider`, `r.routing_fallbacks`, `r.blocked`. Prefer `textContent` or `createElement` where no markup is needed. | false | true |
| 5 | medium | security | `api.py` (all endpoints) | No rate limiting on `/v1/complete` or `/v1/extract`. Any unauthenticated client can send an unlimited number of requests, running up LLM API quota/spend or causing CPU-bound DoS via the firewall regex engine on 100 KB payloads. | Add a rate-limiting middleware (e.g., `slowapi` + Redis, or a simple in-process token bucket) keyed on IP. For the demo tier, even a loose limit (e.g., 60 req/min/IP) closes the obvious abuse vector. | false | false |
| 6 | medium | performance | `audit.py`, `api.py:85-86` | `AuditLog._entries` grows without bound; the `/v1/audit` endpoint returns the entire list in a single response (`audit.log.entries()`). Under sustained traffic this causes unbounded memory growth and an increasingly large HTTP response payload. The UI itself only renders the last 12 entries. | Cap the in-memory log (e.g., `collections.deque(maxlen=10_000)`); add `?offset=&limit=` query parameters to `/v1/audit`. Note: a bounded deque breaks the hash-chain on eviction — document that only the live tail is verified. | false | false |
| 7 | medium | security | `api.py` | No HTTP security headers are set. There is no Content-Security-Policy, `X-Content-Type-Options`, `X-Frame-Options`, or `Referrer-Policy`. The absence of CSP makes the `innerHTML` XSS findings above more impactful. | Add a `SecurityHeadersMiddleware` (or use `starlette.middleware.base.BaseHTTPMiddleware`) that sets at minimum: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, and a `Content-Security-Policy` that restricts `script-src` and `default-src`. | false | true |
| 8 | low | quality | `redact.py:20` | The `IP_ADDRESS` regex `\b(?:\d{1,3}\.){3}\d{1,3}\b` does not validate that each octet is 0–255. It matches `999.999.999.999` and similar strings that are syntactically IP-shaped but not valid addresses, causing false-positive redactions. | Add an octet range check: either use a post-match validator (split on `.`, check all parts ≤ 255) or tighten the pattern to `\b(?:(?:25[0-5]|2[0-4]\d|1?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|1?\d\d?)\b`. | true | true |
| 9 | low | bug | `models.py:8` | `CompleteRequest.system` has no `max_length` constraint, unlike `prompt` and `client_completion` which cap at 100,000 chars. A caller can send a multi-megabyte system prompt, which is forwarded verbatim to every LLM provider call. | Add `system: str = Field(default="You are a precise assistant.", max_length=10_000)`. | false | true |
| 10 | low | quality | `llm.py:236-253` | `complete_json()` is defined in `llm.py` but is not imported or called from any other module in the codebase. It is dead code — it was likely scaffolded for the `/v1/extract` path but that endpoint calls `gateway.complete()` directly and does its own JSON extraction inline. | Either remove `complete_json()` and its test coverage gap, or extract and use it in `api.py`'s `/v1/extract` handler to remove the duplicate JSON-extraction logic there. | false | true |

---

## Notes

**Architecture:** The governance pipeline (firewall → redact → route → output-firewall → audit) is the right design: governance is structural, not optional. The deterministic regex firewall and Luhn-validated redaction engine produce perfectly reproducible results with no model or network dependency, which is a notable testing advantage.

**Tests:** Test coverage is thorough for the happy path and the security contract (no-leak invariant, tamper-evident audit, injection blocking). The `xfail(strict=True)` pattern in `test_security.py:248` is an honest way to document a known bug — the fix should now be implemented and the xfail removed.

**Thread-safety (finding #2)** is the highest-priority production risk. A quick mitigation is to add a single module-level `threading.Lock` to `AuditLog` and `CircuitBreaker`; the longer-term fix is making the hot path async and using `asyncio.Lock`.

**Audit raw-secret bug (finding #1)** is the highest-priority security issue. The fix is one line in `gateway.py`'s `_finalize`: always redact the stored text separately from the policy-gated redact-before-provider pass.

**Frontend XSS (finding #4):** A tiny utility function covers all cases:
```javascript
const esc = s => String(s ?? "")
  .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
```
Apply to `r.model`, `r.provider`, and other server-reflected strings before innerHTML insertion.
