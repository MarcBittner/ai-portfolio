# slo-kit

A small **instrumented reference service** that shows how I run boring, dependable
systems: an outreach-API wrapped in **RED metrics**, **SLIs/SLOs with an error
budget**, **OpenTelemetry-style traces**, an on-demand **incident** you can inject
to watch the budget burn and recover, and the deploy/alerting artifacts around it
(**Terraform multi-window burn-rate alerts**, a **GitHub Actions** pipeline gated
on a post-deploy smoke check, and a one-page **runbook**).

It's a "this is how I'd operate it" repo — reliability treated as an artifact, not
an afterthought.

> Offline, deterministic, no secrets. Traffic and faults are simulated, so the
> dashboard, SLO math, and the burn/recover demo are fully reproducible.

## The loop

```
POST /v1/messages ─▶ instrument (RED metric + trace span) ─▶ /slo computes SLIs,
error budget, burn rate ─▶ dashboard / Prometheus / alerts
        ▲                                                         │
        └────────── /admin/fault injects an incident ◀───────────┘  (burn, then recover)
```

- **SLOs:** availability 99.5% (error budget 0.5%), latency 95% under 250 ms.
- **Error budget + burn rate:** how much slack is left and how fast it's going —
  the number that decides whether you ship or freeze.
- **Multiwindow burn-rate alerts** (`deploy/terraform/`): page on fast burn
  (14.4× / 1h), ticket on slow burn (6× / 6h) — the canonical SRE pattern.
- **Smoke as a deploy gate** (`deploy/github-actions/`): the same suite that runs
  locally verifies the live contract before a rollout is "done."
- **Runbook** (`docs/runbook.md`): confirm → triage → mitigate → verify → comms.

## Quickstart

```sh
cd projects/slo-kit
./run.sh setup
./run.sh demo            # offline: steady traffic → incident burn → recovery
./run.sh serve           # dashboard at http://127.0.0.1:8011
./run.sh test            # unit suite
./run.sh smoke           # live smoke/regression (local server, or --url <deploy>)
```

In the dashboard: **Run load** for steady traffic, **Inject incident + load** to
burn the budget (watch availability go `burning`/`exhausted` and latency
`violated`), then **Reset** to recover.

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | status, window request count, SLO status, fault active |
| POST | `/v1/messages` | the instrumented business call (200, or 500 under fault) |
| GET | `/v1/messages` | recently sent (outbox) |
| GET | `/metrics` | Prometheus exposition (RED) |
| GET | `/metrics/snapshot` | JSON metrics for the dashboard |
| GET | `/slo` | SLIs, SLOs, error budget, burn rate |
| GET | `/traces` | recent spans |
| POST | `/admin/fault` | inject error rate + added latency (the incident) |
| POST | `/admin/loadtest` | fire N synthetic requests |
| POST | `/admin/reset` | clear metrics/traces/fault |

Proprietary, offline-first, no secrets — conforms to the portfolio conventions
(CONV-1…5).
