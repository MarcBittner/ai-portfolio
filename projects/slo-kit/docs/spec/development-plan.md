# slo-kit — Development Plan

**Legend:** `[x]` complete · `[>]` in progress · `[ ]` pending

## Phase 0 — MVP (v0.1.0) ✅

- [x] Scaffold (pyproject, run.sh w/ smoke, Dockerfile, LICENSE)
- [x] RED metrics registry + Prometheus exposition (stdlib-only)
- [x] OpenTelemetry-style trace recorder (bounded ring buffer)
- [x] SLI/SLO + error-budget + burn-rate computation
- [x] Instrumented outreach service with deterministic fault injection + loadgen
- [x] FastAPI (`/v1/messages`, `/metrics[/snapshot]`, `/slo`, `/traces`,
      `/admin/{fault,loadtest,reset}`) + Grafana-style dashboard
- [x] IaC + ops artifacts: Terraform multiwindow burn-rate alerts, smoke-gated
      GitHub Actions pipeline, one-page incident runbook
- [x] Tests: metrics / slo / service / api + local+remote smoke
- [x] ruff clean, `./run.sh demo` offline (burn → recover), smoke green

## Roadmap

- [ ] Real OpenTelemetry SDK export (OTLP → Tempo/Jaeger) behind a flag
- [ ] Persisted/rolling time-window metrics (not just cumulative)
- [ ] Per-endpoint SLOs + a budget-policy "freeze releases when exhausted" hook
- [ ] Alertmanager/Grafana provisioning alongside the Terraform
- [ ] Deploy live on Render (free) + add to the portfolio "Live demos" table

---

## Code review backlog (from `/docs/code-review/slo-kit.md`, 2026-06-18) — NOT YET DONE

Grade **A−**. Prioritized fixes; full detail + `file:line` in the review.

- [ ] **MED — budget boundary bug.** In `slo.py`, at exactly the 0.5% budget the status reports `healthy` while `budget_remaining` is `0.0`, and the `"burning"` branch is effectively dead. Fix the boundary comparison and cover it with a test.
- [ ] **MED — single-window vs multi-window burn.** The service computes a single-window consumption ratio but the README/Terraform advertise a **multi-window burn rate**. Either implement the multi-window burn or correct the docs to match.
- [ ] **MED — ungated `/admin/*`.** `/admin/fault`, `/admin/loadtest`, `/admin/reset` are unauthenticated; add a guard/token (at least for non-demo deploys).
- [ ] **LOW — threshold mismatch.** Sev1 threshold (10×) disagrees with the runbook/Terraform fast-burn (14.4×); reconcile to one source of truth.
- [ ] **LOW — perf/concurrency.** O(n) `list.pop(0)` on the latency window (use a `deque`); the tracer is unlocked under concurrent requests.
