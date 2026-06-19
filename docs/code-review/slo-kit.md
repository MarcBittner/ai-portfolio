# slo-kit — Code Review

## Summary

`slo-kit` is a compact, well-organized FastAPI reference service for RED metrics, SLOs/error budgets, fault-injection incident drills, an in-process Prometheus exposition, and an OTel-style span recorder. The code is clean (ruff passes, 32 tests green), readable, and the layering (`metrics` → `slo` → `service`/`incident` → `api`) is sound. The main issues are a confirmed dead-branch / boundary bug in the error-budget status logic, a doc-vs-code mismatch between the advertised "multi-window burn-rate" alerting and the single-window ratio actually computed, fully unauthenticated `/admin/*` mutation endpoints, and process-global mutable state that makes the service single-worker-only.

## Architecture notes

- Clean module boundaries: `metrics.py` is a lock-guarded in-process registry, `slo.py` is a pure function over a snapshot, `service.py` is the instrumented workload + fault switch, `incident.py` layers a deterministic classifier + LLM-narrative drafter on top, and `api.py` is a thin HTTP surface. Pure-function `slo.compute` and `incident.classify` are easy to test and are the trust-critical paths.
- State lives in three module-level singletons: `service.fault`/`service._n`/`service._outbox` (`service.py:26-28`), `registry` (`metrics.py:100`), and `tracer` (`tracing.py:52`). Fine for the stated single-uvicorn-worker scope, but it is shared mutable global state with no per-request isolation — it precludes `--workers > 1` and is why the test suite must `service.reset()` between cases.
- Determinism is a deliberate, documented design goal (`service.py:7`, `incident.py:16-19`) and it mostly holds — severity is always computed from the numbers, never the LLM (`incident.py:286-287`).
- The Prometheus exposition is hand-rolled (`metrics.py:76-97`) rather than using `prometheus_client`; acceptable and documented as a no-dependency choice, though it omits a real histogram and the summary quantiles are point-in-time gauges.

## Findings

| # | Severity | Location (file:line) | Issue | Suggested fix |
|---|----------|----------------------|-------|---------------|
| 1 | Medium | `slo.py:27-32` | Dead `"burning"` branch + boundary bug. `remaining > 0` is true iff `consumed < 1` iff `avail_sli > AVAILABILITY_SLO` — which already returned `"healthy"` at line 27. So the `elif remaining > 0` branch (`"burning"`) is **unreachable**; status only ever goes `healthy → exhausted`. Verified: `error_rate=0.0050001` reports `status="healthy"` with `budget_remaining=0.0`. | Give `"burning"` a reachable definition (e.g. `burn_rate > 1` while SLI still met) and reserve `"exhausted"` for `remaining == 0`. Compare on the raw (unrounded) SLI to avoid the rounding boundary. |
| 2 | Medium | `slo.py:23` vs `slo.py:27`, `metrics.py:20` | Rounding masks the boundary. `avail_sli` is rounded to 6 dp and then compared `>= AVAILABILITY_SLO`. At `error_rate=0.0050001` the SLI rounds to exactly `0.995` and reports healthy despite the budget being gone. | Keep an unrounded SLI for the status comparison; round only for display. |
| 3 | Medium | `api.py:115-130` | `/admin/fault`, `/admin/loadtest`, `/admin/reset` mutate global service state with **no auth/gating** — any caller can inject a 5xx storm or wipe metrics. The deploy is internet-exposed. | Gate the `/admin/*` router behind a shared-secret header / bearer token (env-configured), or bind admin routes off unless an `ENABLE_ADMIN` flag is set. |
| 4 | Medium | `deploy/terraform/main.tf:5,18-25`, `docs/spec/spec.md:26` vs `slo.py:16-22` | "Multiwindow, multi-burn-rate" alerting is advertised, but the service computes a **single-window** consumption ratio (`error_rate / budget`) over one rolling 5000-sample window (`metrics.py:14`). There is no 1h-vs-6h dual-window logic in-process; the Terraform declares only a single `fast_burn` alarm (slow-burn is a comment, never a resource). | Either implement an actual multi-window burn computation, or soften the wording to "single-window burn rate; multi-window alerting modeled in Terraform" and add the missing `slow_burn` resource. |
| 5 | Low | `incident.py:111` vs `deploy/terraform/main.tf:19`, `docs/runbook.md:7` | Sev1 fast-burn threshold is `burn >= 10` in code but the runbook/Terraform fast-burn page is `14.4×`. Two sources of truth disagree. | Define the fast-burn multiplier once and reference it. |
| 6 | Low | `service.py:53-55` | Error injection quantizes the rate: `step = round(1/error_rate)`, so requested rates that aren't `1/integer` are silently snapped (e.g. `0.07 → step 14 → 7.14%`), and any `error_rate > 0.5` collapses to `step=1` = **100% errors**. | Document the quantization, or use a carry accumulator for an accurate deterministic rate across 0..1. |
| 7 | Low | `service.py:38-41`, `set_fault` (`service.py:31-35`) | `set_fault` does not reset `_n`, but `reset()` does. Since injection keys off `_n % step`, the exact erroring indices depend on how many requests preceded `set_fault` — so the same fault at different times errors at different positions. | If positional determinism after a mid-stream `set_fault` matters, reset a fault-local counter; otherwise document that determinism is anchored to `reset()`. |
| 8 | Low | `metrics.py:46-47` | `by_endpoint` / `by_status` are unbounded-cardinality maps keyed by caller-supplied strings. Bounded in practice today, but the registry imposes no cap. | Note the cardinality contract, or whitelist/normalize labels before recording. |
| 9 | Low | `metrics.py:17-21` | Percentile uses nearest-rank with `int(q * len)` and no interpolation; coarse for small windows. Acceptable for a demo but diverges from Prometheus `histogram_quantile`. | Document the approximation, or interpolate. |
| 10 | Low | `metrics.py:54-55` | The latency window is a `list` with `pop(0)` on overflow — O(n) per record once full (5000 samples). | Use `collections.deque(maxlen=_WINDOW)` (as `tracing.py:32` already does); sort a copy in `snapshot`. |
| 11 | Info | `tracing.py:38` | Span/trace ids are a monotonic counter formatted as hex, not random — fine and documented as a stand-in for the OTel SDK, but predictable. | Documentation note only. |

## Test coverage

Coverage is good for a service this size: 32 passing tests across `metrics`, `slo`, `service`, `incident`, and `api` (12 live-smoke/LLM tests appropriately skipped offline). Strengths:

- The burn-then-recover incident flow is tested end-to-end through HTTP (`tests/test_api.py:37-46`).
- Deterministic fault injection is asserted exactly (`tests/test_service.py:13-18`, 50/100 errors).
- The trust-critical invariant — severity comes from `classify()`, never the LLM — is explicitly tested (`tests/test_incident.py:45-50`).

Gaps:

- **The boundary bug (Findings 1/2) is untested and the existing test hides it**: `tests/test_slo.py:26-31` asserts `status in ("burning", "healthy")` — which permits the buggy "healthy"-at-zero-budget result. Add a test pinning behavior exactly at and just above `error_rate == 0.005`.
- No test exercises `error_rate > 0.5` (Finding 6) or a non-`1/integer` rate.
- No test for `/admin/*` being callable without auth (Finding 3) — expected, since there is none.
- No concurrency test around the registry lock (acknowledged single-worker scope).

## Recommendations (prioritized)

1. **Fix the error-budget status logic (Findings 1, 2).** This is the core domain of the service; the `"burning"` state being unreachable and "healthy" being reported at zero remaining budget undermines the headline feature. Add a boundary test.
2. **Gate the `/admin/*` endpoints (Finding 3).** A live, internet-reachable deploy with unauthenticated fault-injection and metric-reset is the most serious operational issue.
3. **Reconcile the burn-rate story (Findings 4, 5).** Implement multi-window burn or align the docs/Terraform to the single-window reality, add the missing slow-burn resource, and unify the fast-burn threshold to one constant.
4. **Tighten fault-injection accuracy and document determinism anchoring (Findings 6, 7).**
5. **Housekeeping (Findings 8-11):** bound metric label cardinality, switch the latency window to a `deque`, note the percentile approximation and demo trace-id scheme.
