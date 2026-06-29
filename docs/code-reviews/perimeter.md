# Code Review: perimeter

> **Remediation status — review-only (not auto-modified).**
> Reason: no source test files present (only stale .pyc). Findings below are documented for manual remediation; no code changes were applied so safety could not be proven here.


**Health:** Fair — well-structured demo with solid test coverage; one high-severity correctness bug in the core evidence export, two medium issues, four low issues.

---

## Findings Table

| # | Severity | Category | File | Finding | Recommendation | UX Impact | Auto-fixable |
|---|----------|----------|------|---------|---------------|-----------|-------------|
| 1 | HIGH | bug | `src/perimeter/evidence.py:24` | `bundle()` keys `by_id` dict by `rule_id` alone; when the same rule fires on multiple assets (e.g. two DB_EXPOSED hosts), only the last finding's raw evidence dict survives. All earlier hits in the audit export carry the wrong IP, port, and exposure details. `title` and `remediation` are same-per-rule so those are masked, but the machine-readable `evidence` object is wrong per-asset. | Key `by_id` by `(rule_id, asset)` or just by `asset`, then look up by `hit['asset']` when building the evidence list. | yes | yes |
| 2 | MEDIUM | bug | `src/perimeter/api.py:78` | `control_catalog()` returns HTTP **200** with `{"error": "unknown framework ...", "frameworks": [...]}` when an unknown framework is requested. REST clients cannot distinguish this from a successful response by status code alone. The test for this endpoint (`test_controls_unknown_framework`) checks the error body but does not assert on status code. | Raise `HTTPException(status_code=400, detail=...)` (import from `fastapi`) and remove the manual error-dict return. Update the test to assert `resp.status_code == 400`. | yes | yes |
| 3 | MEDIUM | performance | `src/perimeter/api.py` (all endpoints) | Every API endpoint calls `scan.scan()` unconditionally, which re-fingerprints every host, re-evaluates every control, and re-computes all scores on every request. `/evals` calls `narrative.evaluate()` which calls `scan.scan()` internally, and `narrative.generate()` also calls it — so a single `/evals` request runs the pipeline twice. At demo scale this is negligible, but the architecture has no memoization layer. | Add a module-level `functools.lru_cache(maxsize=2)` (keyed on `remediated`) to `scan.scan()`, or compute and cache the two report variants at startup. For the LLM path, the narrative already does not re-derive findings, so only the posture run needs caching. | no | yes |
| 4 | LOW | bug | `src/perimeter/llm.py:211` | `complete()` catches bare `except Exception` for every provider call. `AttributeError`, `NameError`, or other programming bugs in `_call()` are silently consumed, logged as a `fallbacks` entry, and the chain continues. The symptom is unexpected fallback telemetry with no stacktrace. | Narrow to `(urllib.error.URLError, urllib.error.HTTPError, json.JSONDecodeError, KeyError, ValueError)` or re-raise non-network exceptions after logging. | no | yes |
| 5 | LOW | bug | `src/perimeter/llm.py:77` | `_probe_cache` is an unsynchronized module-level dict. Under FastAPI's thread-pool (sync handler execution), concurrent requests can simultaneously read a stale cache entry, both perform the Ollama probe, and both write the result. Python's GIL makes individual `dict` assignments atomic, but the read-check-write sequence is not. The worst case is duplicate probes (not a correctness hazard), but it is a threading anti-pattern. | Guard the probe and cache-write with a `threading.Lock` initialized alongside `_probe_cache`. | no | yes |
| 6 | LOW | quality | `src/perimeter/fingerprint.py:50` | `_version_tuple()` extracts all digit characters from each dotted segment and joins them: `''.join(c for c in chunk if c.isdigit())`. A version segment like `"6p1"` or `"3b2"` becomes `"61"` or `"32"`, not `"6"` or `"3"`. Pre-release markers inflate the numeric value, which could produce false-positive or false-negative EOL comparisons. The current synthetic data uses clean dotted versions so this is not triggered, but callers using real scanner data would be affected. | Split on the first non-numeric character in each segment: `int(re.match(r'\d+', chunk).group() or '0')`. | no | no |
| 7 | LOW | quality | `src/perimeter/fingerprint.py:58` | `_days_until()` catches `ValueError` from `date.fromisoformat()` and silently returns `9999` (treated as "far future"). A malformed `not_after` field is therefore silently ignored — no certificate findings fire, no warning is produced. | Log a warning (`logging.warning("unparseable tls.not_after %r; skipping cert checks", not_after)`) before returning the sentinel so bad data is observable. | no | yes |

---

## Notes

### Architecture

The project is a stateless FastAPI service wrapping a pure-Python GRC posture engine. There is no database, no user input reaching any unsafe API (`eval`, `exec`, `subprocess`), and no user-controlled URL or file path. API keys are read from environment variables, never hardcoded. The offline deterministic fallback guarantees the service always returns the expected JSON shape even with zero LLM provider keys, which is clean design.

### Security

No injection vectors, no path traversal, no secrets in code. The `OLLAMA_BASE_URL` env var is trusted and used as a URL prefix; an operator who can set env vars can already do anything, so this is not SSRF. CORS is not configured (FastAPI defaults to no CORS headers), which is conservative and correct for a backend that serves its own static UI from the same origin. No findings here.

### Test Coverage

Unit tests cover fingerprinting, risk scoring, control evaluation, and framework rollup. API tests cover all endpoints including the unknown-framework path. The live smoke tests are correctly gated behind `PERIMETER_LIVE=1`. Gap: `test_controls_unknown_framework` (api.py:43) does not assert `status_code`, so the HTTP 200 on error goes undetected.

### Top Priority Fix

Finding #1 (`evidence.bundle()` dict collision) is the highest-priority fix: the evidence export is the primary deliverable that auditors consume, and wrong asset-specific evidence in the bundle undermines the traceability chain from "internet-exposure finding" to "the control it affects." The fix is mechanical (change the dict key) and safe.
