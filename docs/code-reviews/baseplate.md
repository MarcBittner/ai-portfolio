# baseplate — code review

> **Remediation status — 5 of 10 findings auto-remediated & verified (2026-06-29).**
> Applied safe, non-UX fixes; re-verified independently (pytest green + ruff clean) and pushed per project.
>
> **Remediated (verified ✅):**
> - `BP-01` — trivy-action@master — mutable CI action pin propagates to all scaffolded pipelines
> - `BP-04` — catalog.py line 33: dataclasses.field() used outside a dataclass — misleading dead code
> - `BP-06` — innerHTML interpolations in SPA do not HTML-escape API-returned strings
> - `BP-07` — POST /ingest accepts an unbounded rows list — potential memory/CPU DoS
> - `BP-08` — ScaffoldRequest.mode is typed str | None — invalid modes are silently ignored
>
> **Verification proof:** `63 passed, 9 skipped, 1 warning in 0.40s` · ruff clean.
> Remaining findings in the table below were not auto-applied (UX-impacting or needing a design decision) — open for manual triage.


**Health: fair** — well-structured demo platform service with good test coverage and security awareness, but carries a handful of concrete bugs and quality issues worth fixing.

---

## Findings

| # | Severity | Category | File | Finding | Recommendation | UX Impact | Auto-fixable |
|---|----------|----------|------|---------|----------------|-----------|--------------|
| 1 | medium | security | `deploy/github-actions/golden-ci.yml:44`, `src/baseplate/templates.py:257` | `aquasecurity/trivy-action@master` — mutable tag reference in both the reference CI workflow and the scaffolder template. An attacker who pushes to the upstream `master` branch could inject malicious CI steps into every generated pipeline. | Pin to a specific commit SHA (e.g. `aquasecurity/trivy-action@a20c8b`) and update the template so all scaffolded services inherit the pin. | false | true |
| 2 | medium | security | `src/baseplate/api.py:163` | `POST /admin/reset` has no authentication, no middleware guard, and is publicly routable. Any caller can wipe the in-process service catalog to its seed state. | Add a secret token check (e.g. `X-Admin-Token` header matched against an env var) or restrict the route to localhost-only via a middleware dependency. | true | false |
| 3 | medium | bug | `src/baseplate/api.py:125`–`129` | `/catalog` calls `catalog.services()` twice — once to build the response body and once for the `count` key — while the catalog is mutable shared state with no lock. Between the two calls a concurrent `onboard` or `reset` can change the list, making `count` disagree with the length of `services`. | Cache the result of one `catalog.services()` call in a local variable and derive `count` from it: `svcs = catalog.services(); return {"services": svcs, "count": len(svcs)}`. | true | true |
| 4 | medium | bug | `src/baseplate/catalog.py:33` | `_catalog: list[CatalogEntry] = field(default_factory=list)` — `dataclasses.field()` outside a dataclass body returns a `Field` descriptor object, not a list. The line is immediately overwritten on line 34 so it does not cause a runtime error, but it is misleading dead code and will confuse any reader or IDE type-checker. | Remove line 33 entirely; line 34 (`_catalog = list(_SEED)`) alone correctly initialises the module-level list. | false | true |
| 5 | medium | security | `src/baseplate/api.py` (entire file) | No CORS middleware is configured. FastAPI defaults to blocking cross-origin requests, but the SPA served at `/` calls `/scaffold`, `/catalog`, `/slo`, etc. from the same origin, so this is not currently broken. However, no `Content-Security-Policy`, `X-Frame-Options`, or `X-Content-Type-Options` headers are emitted. If the service is ever embedded or accessed cross-origin, there is no defence. | Add `fastapi.middleware.cors.CORSMiddleware` with an explicit allowlist and set `X-Frame-Options: DENY` and `X-Content-Type-Options: nosniff` headers via middleware. | false | false |
| 6 | low | security | `src/baseplate/static/index.html:838,1041,1103` | Several `innerHTML` assignments interpolate `rt.model`, `r.result`, and `rt.provider` without HTML-escaping. `rt.provider` and `rt.mode` are hardcoded server strings and are safe; `rt.model` echoes back a model identifier that currently comes from operator-controlled env vars or the OpenRouter catalog — low-risk in a demo context. `r.result` in the benchmark table is assembled from server error strings, also currently safe. If the server ever reflects user-controlled strings through these fields (e.g. a description excerpt in an error message) the result would be stored XSS in the SPA. | Use `textContent` for plain-text insertions, or HTML-escape values before interpolation. A small `esc(s)` helper (`s.replace(/&/g,'&amp;').replace(/</g,'&lt;')…`) applied at every interpolation point is a safe mechanical fix. | false | true |
| 7 | low | performance | `src/baseplate/api.py:132`–`136` | `/ingest` accepts an unbounded `rows: list[dict]` body. A caller may POST millions of rows, causing unbounded memory allocation and CPU usage in `ingest.score()`. | Add a `max_items` constraint on `IngestRequest.rows` (e.g. `rows: list[dict] | None = Field(None, max_length=100_000)`) and return a 422 for oversized payloads. | false | true |
| 8 | low | quality | `src/baseplate/models.py:14` | `mode: str | None = None` accepts any string. An unsupported mode (e.g. `"bogus"`) silently falls back to `"auto"` in `llm.resolve_mode()`, making the field a no-op rather than an error for callers who mistype a mode. | Use a `Literal["auto","paid","local","free","offline"] | None` type annotation so FastAPI rejects invalid modes with a 422 before they reach the router. | false | true |
| 9 | low | quality | `src/baseplate/evaluate.py:27,173` | `evaluate.run()` is a pure, side-effect-free function invoked by `GET /evals`, but `evaluate.main()` writes `eval-report.md` to the project root at a path resolved at import time (`REPORT = Path(...).resolve().parents[2]`). If the package is installed in a read-only location (e.g. a container where `/app` is read-only after the `USER app` switch), `main()` will raise a `PermissionError` at runtime. The API only calls `run()` so this does not affect the service, but `./run.sh eval` would fail in that environment. | Write the report to a configurable path (env var `EVAL_REPORT`) that defaults to a writable location, or document that `./run.sh eval` must be run before `USER app` takes effect. | false | false |
| 10 | low | quality | `src/baseplate/llm.py:81,176,98` | `_COOLDOWN`, `_probe_cache`, and `_CATALOG` are module-level mutable dicts mutated from request handlers with no thread lock. Under multi-worker uvicorn (`--workers N`) each worker process has its own copy (safe), but under the default single-worker with multiple threads (e.g. FastAPI's async thread pool) concurrent updates to these dicts are not atomic in CPython's GIL-free slots (Python 3.13+) and could lose updates or corrupt iteration. | Wrap mutations with `threading.Lock` or switch to `asyncio`-safe state (e.g. `asyncio.Lock`) — or add a comment explicitly noting that the code relies on CPython's GIL and is not safe under free-threaded builds. | false | false |

---

## Notes

**What the project gets right:**
- `spec_from_raw()` is a genuine trust boundary: every spec (LLM output, browser-submitted `client_spec`, explicit params) flows through it, where name is slugged to `[a-z0-9-]`, language is clamped to the supported set, and booleans are coerced. The security test suite validates this.
- The offline fallback (`offline_parse`) is deterministic, always terminal, and tested end-to-end — the app never fails for lack of an API key.
- Generated files (Terraform, k8s manifests, CI) are produced by pure templating with no LLM involvement, making them reviewable and reproducible.
- The test suite is comprehensive: unit tests for each module, a focused security suite that plants canary secrets and runs adversarial inputs, and an optional live smoke suite.
- The Dockerfile follows best practice: non-root user, explicit UID, pinned slim base, no dev deps, PORT-driven cmd.
- The Terraform module uses `manage_master_user_password = true` (no DB password in state), IMMUTABLE ECR tags, IRSA (keyless pod identity), and `deletion_protection` in prod.

**Findings summary:**
- 0 critical
- 0 high
- 3 medium (unauthenticated admin reset, double-read race on catalog endpoint, `trivy-action@master` pin)
- 7 low (dead code, no input size limit, innerHTML without escaping, missing Literal type, thread-safety caveat, eval path, CORS/headers)
