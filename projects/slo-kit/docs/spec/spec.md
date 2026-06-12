# slo-kit — Specification

## Overview

An instrumented reference service demonstrating production operability: RED
metrics, SLIs/SLOs with an error budget and burn rate, OpenTelemetry-style traces,
an injectable incident to exercise the budget, and the surrounding deploy/alerting
artifacts (Terraform burn-rate alerts, a smoke-gated GitHub Actions pipeline, a
runbook). Offline and deterministic; traffic and faults are simulated.

## Functional requirements

- **FR-1 Instrumented workload.** An outreach-API (`POST /v1/messages`) where every
  call records a RED metric and a trace span — the way a production handler would.
- **FR-2 RED metrics + Prometheus.** Rate, errors, duration tracked in-process and
  exposed at `/metrics` in Prometheus text format.
- **FR-3 SLIs/SLOs + error budget.** Availability (99.5%) and latency (95% under
  250 ms) SLIs; compute error budget consumed/remaining and burn rate at `/slo`.
- **FR-4 Traces.** OpenTelemetry-style spans (trace/span id, duration, status,
  attributes) in a bounded buffer at `/traces`.
- **FR-5 Incident injection.** `/admin/fault` sets a deterministic error rate +
  added latency; `/admin/loadtest` drives traffic; together they burn the budget
  and `/admin/reset` recovers it.
- **FR-6 Dashboard.** A Grafana-style UI: RED stat panels, availability + latency
  SLO panels with budget gauge and burn rate, recent traces, operator controls.
- **FR-7 Deploy/alerting artifacts.** Terraform multiwindow burn-rate alerts
  (14.4×/1h page, 6×/6h ticket), a GitHub Actions pipeline gated on a post-deploy
  smoke check, and a one-page incident runbook.
- **FR-8 Offline + safe.** No model, no network, no secrets; deterministic.

## Architecture

```
api.py ─▶ service.py (simulate + instrument, deterministic fault)
              ├─ metrics.py  (RED registry → Prometheus)
              ├─ tracing.py  (span ring buffer)
              └─ slo.py      (SLI/SLO/error-budget/burn from the snapshot)
deploy/terraform (burn-rate alerts) · deploy/github-actions (smoke-gated) · docs/runbook.md
```

## Conventions

Proprietary, offline-first, no secrets, synthetic traffic only — conforms to the
portfolio's CONV-1…5.
