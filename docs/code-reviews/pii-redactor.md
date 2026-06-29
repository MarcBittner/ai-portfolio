# Code Review: pii-redactor

**Health: fair** — The deterministic core (regex + checksum detection, span-based redaction) is well-structured, thoroughly tested, and free of injection or secret-leakage risks. Seven concrete findings exist, none critical; the most impactful is a correctness bug where LLM NER only redacts the first occurrence of a repeated entity. The remaining issues are low-severity quality and security hardening items.

---

## Findings Table

| # | Severity | Category | File : Line | Finding | Recommendation | UX Impact | Auto-fixable |
|---|----------|----------|-------------|---------|----------------|-----------|--------------|
| 1 | medium | bug | `src/pii_redactor/llm_ner.py:35` `src/pii_redactor/api.py:63` | `text.find(value)` returns only the **first** occurrence of an LLM-identified entity. If the same name appears multiple times (e.g. "Jane called Jane"), only the first instance gets a span and is redacted. | Replace `text.find(value)` with `re.finditer(re.escape(value), text)` to emit a span for every occurrence. | true | true |
| 2 | medium | performance | `src/pii_redactor/detect.py:109` | The overlap guard `any(… for … in claimed)` is a linear scan that grows with every added span. For pathological input near MAX_TEXT (100 000 chars) with many short PII matches (e.g. 12 500 email addresses), this is O(n²) — ~78 M comparisons executed in the Python interpreter. | `claimed` is always appended in ascending-start order by `re.finditer`; replace the linear scan with a single check against the last claimed end: `if claimed and start < claimed[-1][1]: continue` (valid because patterns are tried in priority order and each pattern's own matches arrive in order). | false | true |
| 3 | low | security | `src/pii_redactor/static/index.html:743` | Ollama model names are interpolated into an HTML `<option value="…">` attribute without HTML-escaping: `'<option value="'+n+'">'`. A model name containing `"` or `>` (unlikely but possible) could break the attribute boundary. | Reuse the already-defined `esc()` helper: `'<option value="'+esc(n)+'">'`. | false | true |
| 4 | low | security | `src/pii_redactor/static/index.html:794` | Portfolio catalog entries loaded from an external CDN (`cdn.jsdelivr.net/gh/MarcBittner/ai-portfolio@main/catalog.json`) have their `url` field inserted directly into an `href` attribute without sanitisation: `href="'+a.url+'"`. A compromised CDN response or hijacked GitHub ref could inject `javascript:` or attribute-breaking URLs. | Validate that each `a.url` starts with `https://` before rendering; or add a Content Security Policy header that prohibits inline `javascript:` navigation (`Content-Security-Policy: default-src 'self'; navigate-to https:;`). | false | false |
| 5 | low | quality | `src/pii_redactor/detect.py:85` | `_ipv4_ok` accepts octets with leading zeros (`"001"` passes `isdigit()` and `int("001") == 1 <= 255`). POSIX and many network stacks treat a leading-zero octet as octal, so `010.0.0.1 = 8.0.0.1`. This can cause false-positive IP detections on version strings or similar numeric sequences. | Add `str(int(o)) == o` to the octet check so leading zeros are rejected: `all(o.isdigit() and str(int(o)) == o and int(o) <= 255 for o in value.split("."))`. | true | true |
| 6 | low | quality | `src/pii_redactor/redact.py:31` | The `hash` style truncates SHA-256 to 6 hex characters (24 bits, ~16.7 M values). The docstring says results are "re-identifiable only with the source text", but a 6-char hex hash of a known PII format (e.g. email) is trivially brute-forced. Collisions are also non-negligible with large documents. | Increase to 12 hex characters (48 bits) for meaningful collision resistance; update the docstring to accurately describe it as a "low-entropy pseudonym suitable for visual consistency, not for cryptographic unlinkability". | false | true |
| 7 | low | quality | `src/pii_redactor/tests/test_security.py:152` | `assert r.status_code in (200, 422)` — the oversized-text test accepts a 200 response, making it vacuous as a guard that `MAX_TEXT` is enforced. The text is 160 000 chars (> `MAX_TEXT = 100 000`) and does in fact return 422 today, but the test would pass even if the limit were removed. | Change to `assert r.status_code == 422, r.text` so the test actually enforces the constraint. | false | true |

---

## Notes

**What's working well**

- The regex + checksum pipeline (`detect.py`) is clean: Luhn, IBAN mod-97, and IPv4 range validation prevent most false positives for numeric types.
- The redaction engine (`redact.py`) is correct and covers all five styles with consistent per-value token assignment.
- The LLM fallback chain (`llm.py`) is robust: the mock provider is terminal, no call ever raises, and secrets are sourced only from env vars — never from request data.
- The security test suite (`test_security.py`) is unusually thorough for a demo project: canary secrets planted in env, prompt-injection inputs, offline-determinism checks, and the "redactor never leaks the detected value verbatim" invariant.
- The Dockerfile runs as a non-root user (uid 1001) with a minimal base image.

**Finding 1 (first-occurrence-only NER)** is the most user-visible defect: a document mentioning the same person three times will only suppress one occurrence, leaving two in plaintext after redaction.

**Finding 2 (quadratic overlap check)** is unlikely to matter for typical usage (documents are short and PII-dense inputs are rare) but is worth fixing before any high-volume or adversarial deployment.

**Findings 3–4** are security hardening items in the frontend. Finding 4 (CDN-sourced URLs in `href`) is the only supply-chain risk and depends on a third-party asset being compromised — low probability but high impact.

**No critical issues were found.** There is no SQL/command injection, no unsafe `eval`/`exec`, no secrets hardcoded in source, no path traversal, and no unsafe deserialization.
