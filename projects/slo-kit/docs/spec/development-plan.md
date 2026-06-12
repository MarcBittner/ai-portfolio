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
