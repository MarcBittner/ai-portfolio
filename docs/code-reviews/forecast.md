# Code Review — forecast

**Health:** Fair — no critical/high findings; two medium XSS sinks and two medium O(n²) paths deserve attention before any production exposure, but the service is functionally solid.

**Reviewed:** 2026-06-29  
**Language:** Python 3.12 (FastAPI, Pydantic v2, stdlib-only LLM router)  
**Scope:** `src/forecast/`, `static/index.html`, `tests/`, `Dockerfile`, `run.sh`, k8s manifests

---

## Findings

| ID | Sev | Cat | File:Line | Finding | Recommendation | UX Impact | Auto-fix |
|----|-----|-----|-----------|---------|----------------|-----------|----------|
| F1 | medium | security | `static/index.html:571` | `fcData.summary` written to `innerHTML` verbatim — a hostile `client_narrative` becomes reflected DOM-XSS when it contains `<script>` or `<img onerror=…>` tags | Replace with `textContent` or a sanitizer (DOMPurify). One-char fix: `el.innerHTML = …` → `el.textContent = …` | Yes — visible JS execution in browser | Yes |
| F2 | medium | security | `static/index.html:572` | `fcData.routing.model` written to `innerHTML` — the server echoes `request.model` unchanged; a crafted `model` field injects HTML into the routing panel | Same: use `textContent` | Yes | Yes |
| F3 | low | security | `static/index.html:569` | `toast()` sets `innerHTML` with raw response text; FastAPI's 422 body includes user-supplied field values (e.g. `method`) and `json.dumps` does **not** escape `<`/`>`, so a value like `<img src=x onerror=alert(1)>` is injected into the toast overlay | Use `textContent` in `toast()` or HTML-escape before insertion | Yes | Yes |
| F4 | low | security | `models.py:15,21` | `client_narrative` and `model` have no `max_length` — a client can POST megabytes of text that will be stored in the response JSON and echoed to every subsequent UI render call | Add `Field(max_length=4096)` on `client_narrative` and `Field(max_length=200)` on `model` | No | Yes |
| F5 | medium | performance | `methods.py:26–28` | `mean()` fitted series uses a nested `sum(history[:i])` call — O(n²) total work. At the 10,000-point max the fitted loop does ~50M additions | Replace with a running cumulative sum: `total += history[i]; fitted.append(total / i)` — O(n) | No | Yes |
| F6 | medium | performance | `seasonality.py:37–40` | `detect_period()` calls `autocorrelation()` for each lag up to `n//2`; each call is O(n), giving O(n²) total. At n=10,000 this is ~25M additions per auto-selection request | Pre-compute the series mean and variance once, then accumulate the covariance with a sliding update — or use numpy FFT-based ACF if a dependency is acceptable | No | No |
| F7 | low | performance | `api.py:43` + `llm.py:201–208` | `llm.reachable()` issues a 1.5 s network call to Ollama on every `GET /health` — health checks from a load balancer or k8s probe fire frequently and each blocks a server thread | Cache the result with a short TTL (e.g. 10 s) using `time.monotonic()`, or run the probe in a background thread and serve the cached boolean | No | Yes |
| F8 | low | quality | `forecast.py:25` | `errors()` MAPE returns `0.0` when all actuals are zero (the guard `if nz else 0.0` masks division-by-zero). Callers see perfect accuracy rather than `None`/NaN | Return `None` (or `float("nan")`) when `nz` is empty so the caller can distinguish "undefined" from "zero error" | No | Yes |
| F9 | low | quality | `llm.py:117–118` | `_resolve_order("free")` always returns `["openrouter", "mock"]` regardless of whether `OPENROUTER_API_KEY` is set; if the key is absent the `openrouter` branch is silently skipped and every call degrades to mock with no log or warning | Gate the `"free"` path the same way `"paid"` does: only include `"openrouter"` in the chain when `OPENROUTER_API_KEY` is truthy; emit a warning log otherwise | No | Yes |

---

## Notes

### Security

All three XSS findings (F1–F3) are **same-origin, reflected, stateless** — there is no stored XSS surface and no authentication bypass possible because the app has no auth to bypass. The risk is a social-engineering attack where a crafted URL/POST body causes a victim's browser to execute injected JS. Switching the three `innerHTML` assignments to `textContent` (or adding DOMPurify) eliminates all three with minimal code churn.

No SQL injection, command injection, path traversal, or hardcoded secrets were found. The `client_narrative` trust-boundary design is deliberately documented and tested in `test_security.py:test_hostile_client_narrative_cannot_alter_the_math`.

The default Anthropic model string `"claude-haiku-4-5-20251001"` (llm.py:30) is a valid dated snapshot ID, but the alias `"claude-haiku-4-5"` is preferred to avoid drift when a new snapshot ships.

### Performance

F5 and F6 are the highest-impact items. An auto-selection request on a 10,000-point series can trigger the O(n²) `detect_period` path (~25M additions) **plus** multiple calls to `mean()` during `_select()`, each O(n²). Together they could produce multi-second latency with max-size series. Both are fixable with O(n) cumulative approaches (no new dependencies needed for F5; F6 benefits from numpy but can be partially improved with a pre-computed variance).

### Test coverage

`test_security.py` is thorough on the server side (secret leakage, trust boundary, input hardening). Client-side XSS is not testable with `TestClient` and would need a browser-level test (Playwright/Selenium) or static analysis.

### Non-findings

- No auth on demo endpoints — intentional by project design; not flagged.
- Synthetic/mock data — not flagged.
- No CORS misconfiguration — no `CORSMiddleware` registered; UI is same-origin.
