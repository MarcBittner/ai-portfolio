# burnrate — Specification

## Overview

A **Flask** outreach service demonstrating production operability on a Grafana/
Prometheus + EKS/ArgoCD/GitHub-Actions stack: RED metrics via the real
`prometheus_client`, SLIs/SLOs with an error budget and a **multiwindow,
multi-burn-rate alerting policy**, **TaskTiger-shaped background tasks on Redis**
(degrading to inline), an injectable deterministic incident to exercise the
budget, an LLM incident-summary surface, and the surrounding GitOps artifacts
(ArgoCD Application, k8s Deployment/Service/HPA, Prometheus burn-rate alert rules,
a smoke-gated GitHub Actions pipeline with rollback, a runbook). Offline and
deterministic; traffic and faults are simulated.

## Functional requirements

- **FR-1 Instrumented Flask workload.** An outreach-send API (`POST /v1/outreach`)
  where every call records a RED metric — the way a production handler would.
- **FR-2 RED metrics + Prometheus.** Rate/errors/duration on real `prometheus_client`
  Counter/Histogram/Gauge, exposed at `/metrics` in genuine Prometheus exposition.
- **FR-3 SLIs/SLOs + multiwindow burn rate.** Availability (99.5%) and latency
  (95% under 250 ms) SLIs; error budget consumed/remaining; the canonical
  multiwindow, multi-burn-rate policy (14.4× fast → page, 3× slow → ticket) at `/slo`.
- **FR-4 TaskTiger/Redis background tasks.** A `@task`/`delay()`/`Worker` surface
  shaped like TaskTiger: an async `process_batch` and a periodic `rollup`. Real
  Redis queue when reachable (library or `redis-cli`), inline otherwise.
- **FR-5 Incident injection.** `/admin/inject` sets a deterministic error rate +
  added latency; `/admin/loadtest` drives traffic; together they burn the budget
  and `/admin/reset` recovers it.
- **FR-6 Incident summary (LLM).** `POST /incident/summary` compresses the live SLO
  snapshot into an on-call summary + a deterministically-classified severity +
  matching runbook steps; offline drafter is the terminal fallback.
- **FR-7 Dashboard.** A Grafana-style UI: RED stat panels, availability + latency
  SLO panels with budget gauge and the page/ticket burn policy, operator controls.
- **FR-8 GitOps artifacts.** ArgoCD Application, k8s Deployment/Service/HPA with
  readiness/liveness probes, Prometheus multiwindow burn-rate rules, a GitHub
  Actions pipeline gated on a post-deploy smoke check with rollback, a runbook.
- **FR-9 Offline + safe.** No model, no network, no secrets required; deterministic.

## Architecture

```
app.py (Flask factory) ─▶ service.py (simulate + instrument, deterministic fault)
                              ├─ metrics.py  (prometheus_client RED → /metrics)
                              ├─ slo.py      (SLI/SLO/budget + multiwindow burn policy)
                              └─ tasks.py    (TaskTiger-shaped: Redis queue → inline)
incident.py (LLM summary, deterministic severity)   llm.py (provider routing)
deploy/argocd · deploy/k8s · deploy/github-actions (smoke-gated rollback) · docs/runbook.md
```

## Conventions

Proprietary, offline-first, no secrets, synthetic traffic only — conforms to the
portfolio's CONV-1…5. Company-neutral: the target stack is described generically and
the company is never named.
