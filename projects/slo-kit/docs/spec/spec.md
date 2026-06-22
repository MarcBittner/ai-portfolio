# slo-kit — Specification

## Overview

slo-kit is an **instrumented SRE reference service**. A simulated workload is wrapped
in the signals a reliability team actually runs on — **RED metrics** (rate / errors /
duration), **availability & latency SLOs** with an **error budget** and **multiwindow
burn rate**, and **OpenTelemetry-style traces** — and surrounded by the artifacts that
make reliability shippable: **Terraform multiwindow burn-rate alerts**, a smoke-gated
**GitHub Actions** pipeline, and a one-page **runbook**.

On top of that telemetry sits one LLM surface. The dashboards already expose the raw
numbers; at 3am the on-call job is *compressing* them into a sentence. `POST
/incident/summary` reads the live SLO snapshot, RED metrics, and recent error spans and
returns an on-call summary, a severity, and the matching runbook steps. **The model
writes the narrative; the severity is classified deterministically from the SLO math** —
exactly the trust boundary trueline draws around money (the model reads; deterministic
code decides).

Built on the signals an SRE shop runs on — Prometheus / **Grafana LGTM** (Loki / Tempo /
Mimir), OpenTelemetry, Terraform, Kubernetes-style ops — and it runs with **zero paid
accounts**: local Ollama (reached from the browser), a free hosted model, or a
deterministic offline drafter. The live link is in [`../../README.md`](../../README.md);
deeper docs: the [`runbook`](../runbook.md), the in-repo [`README`](../../README.md)
(architecture, design decisions, evals), and the [`development plan`](./development-plan.md).

## Goals

- Demonstrate how a reliability team runs a service: RED metrics, SLOs + error budget +
  burn rate as the ship/freeze signal, traces, and an incident you can burn and recover.
- Treat reliability as an artifact, not an afterthought — Terraform alerts, a CI smoke
  gate, and a runbook ship alongside the service.
- Demonstrate a trustworthy LLM-in-the-loop on-call workflow where the model never
  decides the severity — the classification is deterministic, testable code.
- Run for a reviewer with **no keys** and **no network**: the SLO core is offline and
  deterministic, and the summarizer falls back to a deterministic drafter.

## Non-goals (current scope)

- Not a fleet service — a single-worker reference. Cumulative in-process counters
  (since reset), not rolling time-window metrics scraped by a real client.
- Not a real OTel exporter — spans are OTel-*shaped* in a bounded ring buffer, not OTLP
  to Tempo/Jaeger (the call sites are written so that swap is a drop-in).
- Synthetic traffic and deterministic faults only — there is no real upstream to fail.
- The LLM writes prose only; it is never on the path that decides severity, budget, or
  any number.

## Functional requirements

- **FR-1 — Instrumented workload.** `POST /v1/messages` simulates an outreach call;
  every call records exactly one RED metric and one trace span at a single
  instrumentation choke point, the way a production handler would.
- **FR-2 — RED metrics + Prometheus.** Rate, errors, duration tracked in-process and
  exposed at `/metrics` in Prometheus text format; JSON at `/metrics/snapshot`.
- **FR-3 — SLIs/SLOs + error budget.** Availability (**99.5%**) and latency (**95%
  under 250 ms**) SLIs; error budget consumed/remaining and burn rate at `/slo`. Burn
  rate > 1× means the budget exhausts before the window resets — the ship/freeze signal.
- **FR-4 — Traces.** OpenTelemetry-style spans (trace/span id, name, duration, status,
  attributes) in a bounded ring buffer at `/traces`.
- **FR-5 — Incident injection.** `/admin/fault` sets a deterministic error rate + added
  latency; `/admin/loadtest` drives traffic; together they burn the budget, and
  `/admin/reset` recovers it. Because faults are deterministic, burn/recover is
  reproducible to the digit.
- **FR-6 — Dashboard.** A Grafana-style console: RED stat panels, availability + latency
  SLO panels with a budget gauge and burn rate, recent traces, and operator controls
  with an inline guided **demo path** (run load → inject → summarize → reset).
- **FR-7 — Incident summary (LLM).** `POST /incident/summary` compresses the live state
  into `{summary, severity, suggested_steps[]}`. The severity is classified
  deterministically in `incident.classify()` from the SLO numbers; the steps mirror
  `docs/runbook.md`; the model only writes the narrative.
- **FR-8 — LLM routing + graceful degradation.** local Ollama (browser→host) → paid →
  free → deterministic offline drafter. Provider / model / latency / cost are surfaced
  honestly; the offline drafter is a true last resort (only when no model is usable),
  not the design centre.
- **FR-9 — Observability (Diagnostics).** A Diagnostics view shows the resolved
  provider/model, the active routing chain, live provider status, and a **model
  benchmark** that runs one fixed incident snapshot through every routing mode and
  compares provider/model/latency/severity (`GET /diagnostics/benchmark`). The `local`
  row is exercised in the browser via the browser→host bridge.
- **FR-10 — Evals.** `GET /evals` / `./run.sh eval` scores SLO invariants (deterministic
  burn/recover numbers) and incident-summary accuracy (severity/situation over labeled
  snapshots) and writes `eval-report.md`.
- **FR-11 — Ops artifacts.** Terraform multiwindow burn-rate alerts (14.4×/1h page,
  6×/6h ticket + a p95 alarm), a GitHub Actions pipeline gated on a post-deploy smoke
  check, and a one-page incident runbook.

## Non-functional requirements

- **Trust boundary in code.** Severity is computed in `incident.classify()` from the SLO
  math, never read back from the model; the offline drafter and the LLM path return the
  same shape, so the eval reproduces with zero keys.
- **One source of truth.** `/metrics`, `/slo`, and the dashboard are all derived from one
  `registry.snapshot()`; the numbers can never disagree.
- **Determinism.** Faults inject on a fixed cadence (`_n % step == 0`), not random
  sampling; latency is `base + small jitter + injected`. Burn and recover are
  byte-for-byte reproducible — usable as both a live demo and a test fixture.
- **Bounded memory.** Latency window (5000 samples) and trace buffer (200 spans) are
  bounded; memory is constant regardless of traffic volume.
- **No heavy deps.** The RED registry, Prometheus exposition, and OTel-shaped spans are
  reproduced in ~stdlib so the instrumentation contract is explicit and the install tiny.
- **Tested.** pytest over metrics / SLO math / service / API / incident classifier / the
  benchmark endpoint, plus a live smoke suite (`tests/test_live_smoke.py`) gated on
  `SLO_KIT_LIVE`. `./run.sh check` = lint (ruff) + test.

## Architecture (summary)

```
api.py ─▶ service.py (simulate + instrument, deterministic fault)
              ├─ metrics.py   (RED registry → Prometheus exposition)
              ├─ tracing.py   (OTel-shaped span ring buffer)
              └─ slo.py       (SLI / SLO / error-budget / burn rate from one snapshot)
incident.py ── deterministic severity (classify) + on-call narrative + runbook steps
llm.py      ── routing: anthropic → openai → ollama → openrouter → deterministic offline
deploy/terraform (multiwindow burn-rate alerts) · deploy/github-actions (smoke-gated)
docs/runbook.md (confirm → triage → mitigate → verify → comms)
```

Full module table, the request/burn/recover walkthrough, and the design decisions live in
[`../../README.md`](../../README.md).

## Security model

No secrets and no required network: the SLO core, metrics, and traces never depend on a
provider, and the summarizer degrades to a deterministic drafter. Provider keys, when
set, live **server-side** only; the cloud path never holds a model key in the browser.
The one browser-side call is the local-Ollama bridge — the browser (which can reach
`localhost`, unlike the cloud server) calls the operator's own host model and posts back
**only the narrative prose**; the server keeps severity + steps deterministic.

**Known gaps (tracked in the plan):** `/admin/{fault,loadtest,reset}` are
unauthenticated (fine for a synthetic demo, gate them on a real deploy); the burn metric
is single-window while the Terraform alerts are multi-window; the sev1 threshold (10×)
and the fast-burn alert (14.4×) are not yet reconciled to one constant.

## Conventions

- **LLM usage.** The model is used for one thing — turning a telemetry snapshot into
  fluent on-call prose. It never decides severity, budget, or any number; those are
  deterministic in `slo.py` / `incident.classify()`. Routing is the portfolio-standard
  chain (`llm.py`), identical in shape to the other demos.
- **Offline-first, secret-free, synthetic traffic** — conforms to the portfolio's
  CONV-1…5.
- **Entry point:** `./run.sh` (replaces make) — `setup` · `serve` · `test` · `lint` ·
  `check` · `demo` · `eval` · `smoke` · `doctor`.
- **Docs:** the spec and plan live here in `docs/spec/`; the runbook in `docs/`; the
  architecture / design decisions / evals are in the in-repo `README.md`.
