# burnrate

[![CI](https://github.com/MarcBittner/ai-portfolio/actions/workflows/projects-ci.yml/badge.svg)](https://github.com/MarcBittner/ai-portfolio/actions/workflows/projects-ci.yml)
[![License: Proprietary](https://img.shields.io/badge/license-proprietary-red.svg)](LICENSE)
[![Python 3.11+](https://img.shields.io/badge/python-3.11+-blue.svg)](https://www.python.org)
[![Ruff](https://img.shields.io/badge/lint-ruff-261230.svg)](https://github.com/astral-sh/ruff)
[![Flask](https://img.shields.io/badge/api-Flask-000000.svg)](https://flask.palletsprojects.com)

**[▶ Live demo](https://burnrate-grza.onrender.com)**

A **Flask** outreach service built and operated the way an infrastructure SRE runs
boring, dependable systems. A simulated "outreach-send" API is wrapped in **RED
metrics** on the real `prometheus_client` (genuine Prometheus exposition at
`/metrics`), **SLIs/SLOs with an error budget**, and the canonical Google-SRE
**multiwindow, multi-burn-rate alerting policy** — *fast burn pages, slow burn
tickets* — as code. An on-demand **incident** can be injected to burn the budget
and watch it recover. Bursty work runs on **TaskTiger-shaped background tasks over
Redis** (degrading to inline when Redis is absent). Around the service sit the
artifacts that make reliability shippable on an **EKS + ArgoCD + GitHub Actions**
stack: an **ArgoCD Application**, **k8s Deployment/Service/HPA** with readiness/
liveness probes, **Prometheus burn-rate alert rules**, a **GitHub Actions pipeline
gated on a post-deploy smoke check with automatic rollback** (the merge→production→
rolled-back-in-10-minutes pattern), and a one-page **runbook**.

The dashboards already expose the raw telemetry; the job an on-call engineer
actually has at 3am is *compressing* it into a sentence. So burnrate adds an **LLM
incident-summary generator** — `POST /incident/summary` reads the live SLO snapshot
and returns a concise on-call summary, a severity, and the matching runbook steps.
The model writes the narrative; the **severity is classified deterministically from
the multiwindow burn-rate policy**, and the chain falls back to a deterministic
drafter so it runs with zero keys.

Reliability is treated as an artifact, not an afterthought. Everything is offline,
deterministic, and secret-free — traffic and faults are simulated, so the SLO math
and the burn/recover demo are fully reproducible.

> Sibling demo [`slo-kit`](../slo-kit) covers SLOs in **FastAPI** with OTel-style
> traces. burnrate is deliberately distinct: it is a **Flask** app, with a
> **multiwindow** burn-rate policy, **TaskTiger/Redis** background tasks, and a
> **GitOps (ArgoCD + GitHub-Actions)** deploy story — the framework + task-queue +
> GitOps angle is the point.

## What it is

A small, layered, single-instance reference service:

- **Flask** app (`app.py` factory) serving an instrumented business endpoint
  (`POST /v1/outreach`) plus the observability and operator surfaces.
- **RED metrics on `prometheus_client`** — Counter / Histogram / Gauge in a private
  `CollectorRegistry`, exposed at `/metrics` as the real exposition Grafana scrapes.
- **SLOs + multiwindow burn rate** (`slo.py`) — availability + latency SLIs, error
  budget, and the fast-burn-page / slow-burn-ticket alerting policy.
- **TaskTiger-shaped background tasks** (`tasks.py`) — a `@task`/`delay()`/`Worker`
  surface on Redis (an async batch + a periodic rollup), degrading to inline.
- **Injectable deterministic incident** (`service.py`) + load generator.
- **LLM incident summary** (`incident.py`) — deterministic severity, LLM prose,
  offline fallback.
- **GitOps artifacts** (`deploy/`) — ArgoCD Application, k8s manifests, Prometheus
  burn-rate rules, a smoke-gated GitHub Actions pipeline with rollback, a runbook.

## Architecture

The codebase is small and layered: a Flask surface over a deterministic workload, a
Prometheus instrumentation core, a pure SLO computation, and a task layer that
prefers Redis and degrades to inline. The instrumentation is the genuine
`prometheus_client`, so `/metrics` is byte-for-byte what a Grafana/Prometheus stack
scrapes.

| Module | Responsibility |
|---|---|
| `app.py` | Flask application factory: business endpoint, observability + task surfaces, operator controls, dashboard. WSGI app for gunicorn (`burnrate.app:app`). |
| `metrics.py` | RED metrics on real `prometheus_client` (Counter/Histogram/Gauge) in a resettable `CollectorRegistry`; SLO-derived budget/burn gauges; `/metrics` exposition. |
| `slo.py` | Pure functions: SLIs, error budget, instantaneous burn rate, and the **multiwindow, multi-burn-rate** alert policy (page / ticket / none). |
| `service.py` | The instrumented "outreach-send" workload: simulate + instrument, a **deterministic** fault switch, a load generator, and the short-window view for the multiwindow policy. |
| `tasks.py` | TaskTiger-shaped tasks on Redis (library or `redis-cli`), degrading to **inline** when Redis is absent: `process_batch` (async) + `rollup` (periodic). |
| `incident.py` | LLM incident-summary generator: deterministic severity from the burn policy + on-call narrative + matching runbook steps; offline drafter is the terminal fallback. |
| `llm.py` | Multi-provider routing (paid → local → free → deterministic offline); stdlib HTTP, self-selecting from the environment. |
| `evaluate.py` | Reproducible eval → `eval-report.md` (`./run.sh eval`): SLO invariants + incident-summary accuracy. |
| `demo.py` | Offline script: steady → injected incident → incident summary → recovery, via the background task path. |

```
app.py (Flask factory) ─▶ service.py (simulate + instrument, deterministic fault)
                              ├─ metrics.py  (prometheus_client RED → /metrics)
                              ├─ slo.py      (SLI/SLO/budget + multiwindow burn policy)
                              └─ tasks.py    (TaskTiger-shaped: Redis queue → inline)
incident.py (LLM summary, deterministic severity)   llm.py (provider routing)
deploy/argocd · deploy/k8s · deploy/github-actions (smoke-gated rollback) · docs/runbook.md
```

### A request → metrics lifecycle

```
POST /v1/outreach ─▶ app.outreach ─▶ service.send_outreach ─▶ _simulate(endpoint)
                                                                  │ status + duration
                                                                  ├─▶ metrics.record()  ── prometheus_client
                                                                  │      Counter(requests_total) + Histogram(duration)
                                                                  └─▶ short-window ring (for the page decision)
                                                                  │
                          service._publish() ─▶ metrics.publish_slo()  ── budget + burn Gauges
                                                                  │
   GET /slo  ─▶ slo.compute(long_snapshot, short_snapshot) ───────┘
       │  availability SLI, latency SLI, error budget, burn rate, page/ticket policy
       ▼
   dashboard ( / )   ·   /metrics (Prometheus, scraped)   ·   PrometheusRule alerts (deploy/k8s)
```

**Walkthrough.** A `POST /v1/outreach` lands in the Flask handler, which calls
`service.send_outreach`. That delegates to `_simulate`, the single instrumentation
choke point: it decides a status and a duration under the current fault, then
records exactly one Prometheus observation — `burnrate_requests_total{endpoint,
status}` increments and `burnrate_request_duration_seconds` observes the latency —
plus a bit into the bounded short-window ring used for the multiwindow page
decision. After each call (and each loadtest) `service._publish()` recomputes the
SLO and reflects budget + burn into the `burnrate_error_budget_remaining_ratio` and
`burnrate_burn_rate{window}` gauges, so a scraper sees the same numbers the
dashboard does.

Reads are derived, never stored twice. `GET /slo` calls `slo.compute` over a fresh
long-window snapshot plus the short window, so the SLIs, error budget, burn rate,
and the page/ticket decision are always computed from the same counters `/metrics`
exposes. The dashboard at `/` polls these JSON surfaces.

## SLOs & burn rate

Two SLOs are evaluated over the current window (`slo.py`):

- **Availability** — fraction of non-5xx requests. **SLO 99.5%** → error budget
  `1 − 0.995 = 0.5%`.
- **Latency** — fraction of requests under the **250 ms** target. **SLO 95%**.

Error-budget math (availability):

```
error_rate       = errors / total
budget           = 1 − 0.995 = 0.005
budget_remaining = max(0, 1 − error_rate / budget)
burn_rate        = error_rate / budget        # 1× = sustainable; 14.4× = gone in ~2 days
```

**Multiwindow, multi-burn-rate alerting** is the distinctive piece — the canonical
SRE Workbook policy as code. A single threshold forces a bad trade-off: tight enough
to catch slow burns means it flaps on blips; loose enough to ignore blips means it
misses slow leaks. Two windows resolve it, and an alert fires at a tier only when
**both** a long and a short window clear that tier's threshold (the long window
proves it's sustained, the short proves it's still happening):

| tier | threshold | windows | action |
|---|---|---|---|
| fast burn | **14.4×** the budget (7.2% errors) | 1h **and** 5m | **page** on-call (budget gone in ~2 days) |
| slow burn | **3×** the budget (1.5% errors) | 6h **and** 30m | **ticket** (chronic erosion) |

`slo.alert_policy()` returns the chosen `action` (`page` / `ticket` / `none`) plus
the long/short burn and per-tier firing flags, so the dashboard and runbook can show
*why*. The same policy is encoded cluster-side as a PrometheusRule
(`deploy/k8s/prometheusrule.yaml`) against the `burnrate_requests_total` counter —
in-app and in-Prometheus make the identical decision.

**The incident loop.** `POST /admin/inject` sets a deterministic error rate + added
latency; `POST /admin/loadtest` fires synthetic sends through the same `_simulate`
path, so the budget burns in a way you can watch. `POST /admin/reset` clears the
window and fault, and the budget recovers. Because nothing is random, every run
burns and recovers identically — which is what makes it usable as a demo and a test
fixture.

## Background tasks (TaskTiger/Redis)

Bursty work — "process a batch of outreach sends" — runs as background tasks shaped
like the production scheduler. `tasks.py` mirrors the **TaskTiger** surface: a
`@task` decorator, `delay()` to enqueue, a `Worker` that drains the queue, and a
declarative `PERIODIC` schedule for the rollup job. The backend self-selects:

| backend | when | behavior |
|---|---|---|
| `tasktiger` | the `tasktiger` library is installed **and** Redis is reachable | the real scheduler (this wrapper just adapts names) |
| `redis` | Redis reachable (via the `redis` library, else the `redis-cli` binary) | a genuine async round-trip: `delay()` pushes a JSON job, the `Worker` `LPOP`-drains and runs it |
| `inline` | Redis absent | `delay()` runs the task synchronously and returns its result — the capability still works, it just isn't deferred |

Two demo tasks: **`process_batch`** (async — drives N instrumented sends, counting
into the `burnrate_tasks_total` counter) and **`rollup`** (the periodic SLO rollup
that refreshes the budget/burn gauges). `GET /tasks` reports the live backend, queue
depth, and registered tasks. This is the exact shape of work an outreach pipeline
schedules — without requiring the library or a broker in the sandbox.

## GitOps (ArgoCD + smoke-gated rollback)

Reliability is shipped as version-controlled artifacts, not console clicks:

- `deploy/argocd/application.yaml` — the **ArgoCD Application**: git is the source of
  truth, `automated` sync with `prune` + `selfHeal` reconciles the EKS workload to
  the manifests, and a degraded sync (new pods never pass readiness) is the rollback
  signal.
- `deploy/k8s/deployment.yaml` — **Deployment / Service / HPA** with readiness +
  liveness probes. `RollingUpdate` with `maxUnavailable: 0` means a bad image never
  takes capacity down — the new pods fail readiness, the old ReplicaSet keeps
  serving, and nothing shifts traffic until `/healthz` is green. The HPA scales the
  slow path out before the latency SLO breaks.
- `deploy/k8s/prometheusrule.yaml` — the **multiwindow burn-rate alerts** (the
  cluster-side twin of `slo.alert_policy`): fast burn pages, slow burn tickets, off
  the scraped `burnrate_requests_total`.
- `deploy/github-actions/deploy.yml` — **merge → test → build → push → ArgoCD sync →
  post-deploy smoke gate → rollback**. The same smoke suite that runs locally
  verifies the *live* deployment's contract; a failed gate (or a failed health wait)
  runs `argocd app rollback` to the last healthy revision — the
  **merge→production→rolled-back-in-10-minutes** guardrail, with no human in the 3am
  loop.
- `docs/runbook.md` — a one-page, curl-driven incident runbook (confirm → triage →
  mitigate → verify → comms), executable against `/slo`, `/metrics`, and `/tasks`.

## Incident summary (LLM)

`/slo` and `/metrics` expose the raw telemetry. At 3am the on-call engineer's real
job is compressing it: *what's burning, how fast, who's affected, what to do next.*
`POST /incident/summary` is that capability:

```
live SLO snapshot (availability, multiwindow burn policy, latency, budget)
                      │
                      ▼
        incident.classify(state)   ── DETERMINISTIC severity from the burn POLICY
                      │  page → sev1 · ticket → sev2 · latency-only → sev3 · none
                      ▼
        llm.complete(SYSTEM, state, json_mode)
            Anthropic / OpenAI → Ollama → OpenRouter → deterministic drafter
                      │
                      ▼
        { summary, severity, suggested_steps[] }   ── steps mirror docs/runbook.md
```

The **severity decision never depends on the LLM** — it is computed in
`incident.classify()` from the same multiwindow burn-rate policy the dashboard and
the PrometheusRule use, then handed to the model as context. The model only writes
the narrative; the offline drafter templates the same `{summary, severity,
suggested_steps}` from the snapshot, so the capability (and its eval) reproduce
exactly with zero keys, while a live model turns the snapshot into fluent on-call
prose. The suggested steps are pulled from `docs/runbook.md`, so the draft a
responder gets matches the page they would open.

## Routing

The LLM layer (`llm.py`) is the portfolio-standard chain: a provider is *available*
only when its key is set (or, for Ollama, when a probe to `/api/tags` succeeds), so
the chain self-selects from the environment and `complete()` returns the first
success, recording which providers it fell through.

| mode | order |
|---|---|
| `auto` (default) | Anthropic → OpenAI → Ollama → OpenRouter → offline |
| `paid` | Anthropic → OpenAI → offline |
| `local` | Ollama → offline |
| `free` | OpenRouter → offline |
| `offline` | deterministic drafter only |

`GET /llm` reports which providers are reachable and the active mode. The offline
drafter is always terminal, so the service never fails for lack of a key — it
degrades to deterministic, not to an error.

## Evals

`./run.sh eval` (or `GET /evals`) writes `eval-report.md`. Two evals, both
reproducible offline:

- **SLO invariants** — the deterministic core. Driving 1000 requests per phase
  against the 0.5% budget, the multiwindow policy lands on the same decision every
  run: steady → `healthy`/`none`; **8% errors (16×) → `exhausted`/`page`**; **2%
  errors (4×) → `ticket`** (slow, not a page); after reset → `healthy`/`none`. This
  is the burn/recover loop and the page-vs-ticket distinction as a reproducible
  assertion, not a claim.
- **Incident-summary accuracy** — over labeled incident snapshots, does the generator
  pick the **right severity** and **runbook situation** with a non-empty summary and
  actionable steps? Severity is classified deterministically, so it is exact on
  either path (`1.0` offline); set provider keys or `LLM_MODE` to score a live
  model's narrative on the same snapshots.

| labeled snapshot | expected severity | situation |
|---|---|---|
| steady / healthy | none | healthy |
| budget draining but SLO still met | none | healthy |
| fast burn, both windows (page) | sev1 | availability |
| slow burn, both windows (ticket) | sev2 | availability |
| latency violation only | sev3 | latency |
| fast burn + latency | sev1 | both |
| no data | none | no_data |

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/healthz` | status, version, window request count, SLO + burn action, task backend, fault active |
| POST | `/v1/outreach` | the instrumented business call (200, or 500 under fault) |
| GET | `/v1/outreach` | recently sent (outbox) |
| GET | `/metrics` | Prometheus exposition (real `prometheus_client`) |
| GET | `/slo` | SLIs, error budget, burn rate, multiwindow page/ticket policy, status |
| GET | `/tasks` | task backend, queue depth, registered + periodic tasks |
| POST | `/tasks/process_batch` | enqueue the async batch task (deferred on Redis, inline otherwise) |
| POST | `/tasks/rollup` | run the periodic SLO rollup task |
| POST | `/incident/summary` | LLM on-call summary + severity + runbook steps from the live state |
| GET | `/evals` | incident-summary severity/situation accuracy over labeled snapshots |
| GET | `/llm` | configured/reachable providers + active routing mode |
| POST | `/admin/inject` | inject error rate + added latency (the incident) |
| POST | `/admin/loadtest` | fire N synthetic requests |
| POST | `/admin/reset` | clear metrics + fault |

## Code map

```
src/burnrate/
  app.py         Flask factory + routes (WSGI app: burnrate.app:app)
  metrics.py     prometheus_client RED registry + /metrics exposition
  slo.py         SLIs, error budget, multiwindow burn-rate policy
  service.py     instrumented workload + deterministic fault + loadtest
  tasks.py       TaskTiger-shaped tasks (Redis → inline)
  incident.py    LLM incident summary, deterministic severity, eval
  llm.py         multi-provider routing + deterministic offline fallback
  evaluate.py    reproducible eval → eval-report.md
  demo.py        offline burn → summary → recover walkthrough
  static/index.html   the dashboard
deploy/
  argocd/application.yaml          ArgoCD Application (GitOps source of truth)
  k8s/deployment.yaml              Deployment / Service / HPA + probes
  k8s/prometheusrule.yaml          multiwindow burn-rate alert rules
  github-actions/deploy.yml        smoke-gated pipeline with rollback
docs/runbook.md · docs/spec/spec.md
tests/  test_llm · test_slo · test_tasks · test_incident · test_metrics · test_api · test_live_smoke (opt-in)
```

## Quickstart

```sh
cd projects/burnrate
./run.sh setup
./run.sh demo            # offline: steady → incident burn → incident summary → recovery
./run.sh eval            # SLO invariants + incident-summary accuracy → eval-report.md
./run.sh serve           # dashboard at http://127.0.0.1:8023
./run.sh test            # unit suite (skips opt-in live smoke)
./run.sh smoke           # live smoke/regression (local server, or --url <deploy>)
```

Or off-sandbox without a venv: `PYTHONPATH=src python3 -m burnrate.demo`, and
`PYTHONPATH=src python3 -m pytest -q tests/ -k "not live_smoke"`.

## Env

Runs fully offline with no `.env` (the incident-summary chain falls back to a
deterministic drafter; the SLO math and metrics never depend on a provider, and
background tasks run inline when Redis is absent). Set any of these to route the
summary to a real model or defer tasks onto Redis; never commit real keys, and leave
them unset on a public host. See `.env.example`.

| var | purpose |
|---|---|
| `LLM_MODE` | `auto` (default) · `paid` · `local` · `free` · `offline` |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` | paid path (tried first in `auto`) |
| `OPENAI_API_KEY` / `OPENAI_MODEL` | paid path |
| `OLLAMA_BASE_URL` / `OLLAMA_MODEL` | local models, autodetected via `/api/tags` |
| `OPENROUTER_API_KEY` / `OPENROUTER_MODEL` | free-tier models |
| `REDIS_URL` | enable the deferred TaskTiger-shaped task path (default `redis://localhost:6379`) |
| `PORT` | serve port (default 8023) |

## Deploy

Containerized (`Dockerfile`), served by **gunicorn** (`burnrate.app:app`), non-root,
single worker. The live demo runs on Render; the EKS path is the GitOps artifacts in
`deploy/` (ArgoCD Application, k8s manifests + HPA, Prometheus burn-rate rules, the
smoke-gated GitHub Actions pipeline with rollback).

**Honest single-instance caveats.** This is a single-worker reference, not a fleet
service. The `prometheus_client` registry is per-process, so `/metrics`, `/slo`, and
the dashboard are one consistent source only at one replica (`--workers 1`); a real
deployment scrapes each pod and aggregates the SLIs in Prometheus over a sliding
time window, rather than the cumulative since-reset counters here. The
multiwindow-burn windows are modeled as a long (full-window) and short (last-N
requests) view for the demo; in production they are PromQL `rate()` over real time
windows (`deploy/k8s/prometheusrule.yaml`). Faults and traffic are simulated and
deterministic so the burn/recover demo is byte-reproducible.

Proprietary, offline-first, no secrets, synthetic traffic only — conforms to the
portfolio conventions (CONV-1…5).
