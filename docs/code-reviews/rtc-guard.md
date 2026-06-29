# rtc-guard — Code Review

> **Remediation status — 8 of 11 findings auto-remediated & verified (2026-06-29).**
> Applied safe, non-UX fixes; re-verified independently (pytest green + ruff clean) and pushed per project.
>
> **Remediated (verified ✅):**
> - `RG-01` — Default signing key is publicly known; no startup warning if unset
> - `RG-02` — Module-level _seq counter is not thread-safe; duplicate JTIs possible
> - `RG-03` — SIGNING_KEY frozen as default argument at import time; runtime env-var changes are ignored
> - `RG-04` — GET /evals re-runs all 10 audit cases on every request with no caching
> - `RG-06` — External CDN fetch for app catalog lacks integrity check and URL scheme validation
> - `RG-07` — toast() sets msg via innerHTML without HTML-escaping
> - `RG-08` — _offline_audit re-parses the grant from the prompt string — fragile and silently wrong on format changes
> - `RG-09` — LLM provider failures silently swallowed with no logging in complete()
>
> **Skipped during auto-fix:**
> - `RG-05` — slowapi is not a project dependency and adding it would require a dependency change; the finding explicitly accepts a reverse-proxy (Nginx/Render) rule as an equivalent control, which is the appropriate solution at the infrastructure level for this deployed app.
>
> **Verification proof:** `74 passed, 13 skipped, 1 warning in 0.93s` · ruff clean.
> Remaining findings in the table below were not auto-applied (UX-impacting or needing a design decision) — open for manual triage.


**Health: fair** — Security core (HS256 JWT mint/verify + adversarial suite) is solid and well-tested; several correctness and hardening gaps exist in the surrounding service layer.

---

## Findings

| ID | Severity | Category | File | Finding | Recommendation | UX Impact | Auto-fixable |
|----|----------|----------|------|---------|----------------|-----------|--------------|
| RG-01 | high | security | `token.py:17` | Default signing key `"rtc-guard-demo-signing-key-v1"` is publicly known; if deployed without setting `RTC_GUARD_SIGNING_KEY`, any party with source access can forge valid tokens. No startup warning is emitted. | Add a startup `warnings.warn()` / log when the default key is active; document mandatory key rotation before any non-throwaway deployment. | false | true |
| RG-02 | medium | bug | `token.py:68–81` | `_seq` is a module-level int incremented with `global _seq; _seq += 1` inside `mint()`. FastAPI runs synchronous route handlers in a threadpool executor; concurrent `/v1/token` requests execute `mint()` in parallel threads, producing duplicate JTI values and defeating single-use replay protection (`jti_store`). | Replace with `threading.Lock` around the increment or use `itertools.count()` (atomic on CPython). | false | true |
| RG-03 | medium | bug | `token.py:17,45,52,71,85` | `SIGNING_KEY` is read from `os.environ` once at module import and frozen as the default argument to `encode()`, `decode()`, `mint()`, and `verify()`. Any runtime env-var change (e.g., `monkeypatch.setenv` in tests, or a secrets-manager refresh) is invisible to the defaults — the old key stays in effect until the process restarts. | Read `os.environ.get("RTC_GUARD_SIGNING_KEY", _DEFAULT_KEY)` lazily inside each function, or keep the module constant but always pass it explicitly rather than relying on the default arg. | false | true |
| RG-04 | medium | performance | `api.py:78–79`, `grant_audit.py:381–406` | `GET /evals` calls `grant_audit.evaluate()` which iterates all 10 labeled grants and runs `audit()` for each one synchronously. With a live LLM provider this is 10 external API calls per HTTP request; even offline it serializes 10 rule-evaluation rounds on every hit. No caching. | Compute once at startup (or cache with a short TTL); expose the cached result from `/evals`. | false | true |
| RG-05 | medium | security | `api.py` | No rate limiting on any endpoint. `/v1/token`, `/grant/audit`, `/adversary`, and `/evals` are all open and unbounded. The threat model acknowledges T8 (join flood) as "documented only." | Add `slowapi` (or a reverse-proxy rule) with per-IP token-bucket limits on at minimum `/v1/token` and `/evals`. | false | true |
| RG-06 | low | security | `static/index.html:875` | The portfolio app-catalog is fetched from `cdn.jsdelivr.net/gh/MarcBittner/...` without Subresource Integrity. Returned `url` values are used as bare `href` attributes without scheme validation — a compromised CDN could inject `javascript:` URLs. | Validate that fetched URLs start with `https://`; or pin a SRI hash; or host the catalog on the same origin. | false | true |
| RG-07 | low | security | `static/index.html:512` | `toast()` writes its `msg` argument via `innerHTML` (`t.innerHTML = \`<span ...></span>${msg}\``) without HTML-escaping. All current callers use static or numeric strings, but the interface invites XSS if any future caller passes server-reflected text. | Assemble the element with `document.createElement` + `textContent` for the message portion, or escape `msg` with the existing `esc()` helper. | false | true |
| RG-08 | low | bug | `grant_audit.py:83–86` | `_offline_audit` recovers the grant object by splitting the user-prompt string on newlines and JSON-parsing the last segment (`user.rsplit("\n", 1)[-1]`). Any trailing whitespace, extra newline, or prompt-format change causes silent parse failure — the except catches all errors and falls back to `{}`, producing an empty audit. | Pass the already-normalized `g` dict as a direct parameter rather than re-parsing it from the prompt string. | false | true |
| RG-09 | low | quality | `llm.py:215–216` | `except Exception: fallbacks.append(provider); continue` in `complete()` silently swallows every provider error — HTTP 4xx auth failures, timeouts, unexpected JSON shapes — without a log line. In production, silent fallbacks make provider outages invisible. | Add `logging.warning("provider %s failed: %s", provider, exc)` in the except branch. | false | true |
| RG-10 | low | quality | `models.py:6–10,22–46` | `TokenRequest.identity`, `TokenRequest.room`, and `ClientAudit.explanation` carry no `max_length` constraint. The security tests confirm no 500 on 50 KB identity strings, but the service encodes oversized values into signed tokens or echoes them in responses. `ClientAudit.explanation` with 100 KB of attacker text is accepted and reflected verbatim. | Add `Field(max_length=256)` (identity, room) and `Field(max_length=4096)` (explanation); document the limits. | true | true |
| RG-11 | low | quality | `models.py:10,37` | `TokenRequest.ttl` is validated `ge=1, le=86_400` (max 24 h) while `GrantAuditRequest.ttl` allows `ge=0, le=604_800` (max 7 days). A TTL of 0 in a grant audit is not flagged as a problem by the offline auditor, even though such a token would be immediately expired. | Align validation ranges or at minimum add an auditor rule that flags TTL=0 as misconfiguration. | false | true |

---

## Notes

**Token security core is well-built.** The hand-rolled HS256 JWT is correctly structured: constant-time `hmac.compare_digest`, rejection of `alg=none` (empty signature never matches a real HMAC), expiry/nbf window checks, room-scope enforcement, and an optional single-use `jti_store`. The eight-case adversarial suite is comprehensive and every attack is blocked.

**Test coverage is strong.** The `test_security.py` suite pins offline mode, plants secret canaries, and verifies that client-supplied narration cannot change a verify() verdict. The eval loop proves recall=1.0 on the offline auditor.

**Biggest live risk is RG-02 (`_seq` race).** Under concurrent load, duplicate JTIs silently undermine the only replay-prevention mechanism. The fix is a one-liner.

**RG-01 (default signing key)** is intentional for a zero-config demo but should be accompanied by a startup warning in any non-demo deployment path so operators notice immediately if the key is unset.

**RG-04 (`/evals` cost)** only bites with live LLM providers, but caching is trivially added and future-proofs the endpoint.
