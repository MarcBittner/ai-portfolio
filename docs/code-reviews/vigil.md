# Code Review: vigil

> **Remediation status — review-only (not auto-modified).**
> Reason: test suite hangs on live network probes here. Findings below are documented for manual remediation; no code changes were applied so safety could not be proven here.


**Health:** fair — solid architecture and defence-in-depth overall; a handful of concrete XSS, SSRF, and missing-rate-limit issues need fixing before a public-facing production deployment.

---

## Findings

| # | Severity | Category | File | Finding | Recommendation | UX Impact | Auto-fixable |
|---|----------|----------|------|---------|----------------|-----------|--------------|
| 1 | medium | security | `static/index.html:607,629` | **Stored XSS — unescaped target `name` in status grid and dashboard.** `a.name` is interpolated directly into `innerHTML` template literals without `esc()`. An admin who sets a target name containing HTML (`<img onerror=…>`) gets XSS on every visitor, including unauthenticated guests on the public `/api/status` page. | Wrap `a.name` with the project's own `esc()` function in both the status grid and dashboard template literals. | true | true |
| 2 | medium | security | `static/index.html:641` | **Stored XSS / `javascript:` injection via target URL.** The detail-pane renders the target URL as both `href` and link text via `innerHTML` with no escaping or scheme allowlist. An admin can set `url = 'javascript:alert(1)'`, creating a clickable XSS vector visible to any registered user who opens the detail view. | Escape the URL with `esc()` in the template text; validate the scheme on write (restrict to `https?://`) in `models.py:TargetRequest`. | true | true |
| 3 | medium | security | `api.py:226-234` | **No rate limiting on `/auth/login`.** The signup endpoint is protected by a per-IP `TokenBucket`, but the login endpoint has no analogous guard. An attacker can make unlimited login attempts to brute-force any account's password with no server-side throttle. | Apply `signup_limiter` (or a dedicated `login_limiter` with tighter settings) to the `/auth/login` handler the same way it is applied to `/auth/signup`. | false | true |
| 4 | medium | security | `alerts.py:76-88` | **SSRF via unconstrained webhook `target_addr`.** `WebhookChannel.send()` calls `urllib.request.urlopen(addr, …)` where `addr` is the stored `target_addr` from an alert rule, creatable by any `elevated` user. No scheme or host validation is performed. An elevated user can route webhook deliveries to internal network services (AWS metadata endpoint, intranet APIs, etc.). | Validate `target_addr` against an allowlist of schemes (`https://` only in production) before issuing the request, and reject private/link-local IP ranges. | false | false |
| 5 | low | security | `config.py:104` | **Insecure default session `SECRET_KEY` without startup enforcement.** `SECRET_KEY` defaults to the literal `"dev-insecure-change-me"` when `VIGIL_SECRET` is unset. Sessions signed with this key can be forged by anyone who knows the default. The value is documented as NEEDS-CREDENTIAL, but no startup assertion or log warning fires when the default is in use. | Add a startup check in `lifespan` (or `auth.py`) that logs a loud `WARNING` (or refuses to start in a non-debug env) when `SECRET_KEY` matches the default literal. | false | true |
| 6 | low | quality | `api.py:823-826` | **Dead CSRF endpoint with no consumer.** `/api/csrf` generates and returns a `secrets.token_urlsafe(16)` token, but no endpoint validates a CSRF token. The comment admits it is "kept for completeness." It creates a false impression of CSRF protection. | Remove the endpoint, or implement actual CSRF validation in state-mutating routes. `samesite=lax` on session cookies mitigates browser-initiated CSRF for most cases, which may be sufficient. | false | true |
| 7 | low | quality | `models.py:39-45`, `api.py:647` | **`AlertRuleRequest.metric` and `comparator` lack validation against allowed values.** Any string is accepted. An unknown metric silently creates a no-op rule (always returns `False` in `_breached`); this is a silent foot-gun where `metric="response_time"` (vs the correct `"response_ms"`) would never fire, with no error. | Add a `Literal["availability","error_rate","response_ms","down"]` type for `metric` and `Literal["lt","gt"]` for `comparator` in the Pydantic model, or perform explicit validation in the handler. | false | true |
| 8 | low | quality | `promparse.py:107` | **Dead variable `_ = start`.** The comment says it is "kept for readability; start marks the value origin." `start` is set earlier in the same loop body but not used after this assignment. The comment is misleading — it reads as if the variable is used for something. | Remove the line. The `start` offset is already implicit from the `j + 1` assignment on the preceding line. | false | true |
| 9 | low | bug | `probe.py:263` | **`poller_loop` silently swallows unexpected poll-cycle exceptions.** `contextlib.suppress(Exception)` catches every unhandled exception from `probe_all()` without logging it. A bug that causes an unexpected exception during probing would cause the loop to skip that cycle silently, with no trace in logs or self-metrics. | Replace with an explicit try/except that logs the exception (e.g., `log.exception("poll cycle failed: %s", exc)`) before continuing, so silent failures don't hide bugs. | false | true |

---

## Notes

### What is clean

- **Auth implementation** is solid: `hashlib.scrypt` for password hashing with constant-time comparison (`hmac.compare_digest`), signed sessions via `itsdangerous`, a four-tier role ladder enforced server-side on every endpoint, and per-IP signup rate limiting.
- **GitHub webhook** uses proper HMAC-SHA256 verification and is secure-by-default (rejects all calls when the secret is unconfigured).
- **SQL injection** is not present: all SQLite queries use parameterized `?` placeholders; the dynamic column-name construction in `update_check` only uses keys from the hardcoded `_CHECK_UPDATABLE` dict.
- **Ingestion authorization** for logs/quality/scan is correctly guarded by either a constant-time token compare or a loopback allowlist.
- **Self-monitoring** (the `vigil` self-target) shares the identical probe code path as fleet targets.
- **Log and metrics ingestion** are capped per-target to prevent unbounded DB growth.
- **`esc()` function** is defined and used consistently for log messages, metrics names/labels, push metadata, and commit SHAs. The XSS findings are gaps in coverage of target `name` and target `url`.

### Context

- The project is a single-instance FastAPI service with SQLite (or MongoDB). There is no horizontal-scaling / session-sharing concern at this tier.
- The `client_summary` field on `/api/incident/summary` (a registered-user-controllable prose field) is parsed and returned as the narrative `summary`. The SPA renders `o.summary` via `innerHTML`. In normal UI flow, this field is not sent by the browser. However, the API schema documents it, so any authenticated registered user can supply HTML via a direct API call. This is a reflected-XSS path of lower urgency than the stored-XSS paths in findings 1 and 2, but worth noting.
