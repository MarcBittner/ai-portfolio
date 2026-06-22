# vigil — Specification

## Overview

vigil is a public **observability + SOC monitoring** web app. It probes every
ai-portfolio live demo — and **itself** — on a schedule, records a time series in
SQLite, derives rolling availability / error-rate / latency, scores each app's
security & compliance posture against six control frameworks, dispatches
configurable alerts, and compresses the live fleet state into an LLM-written
incident narrative.

The trust boundary is the portfolio invariant: **the LLM reads, deterministic code
decides.** Status, severity, posture score, and alert thresholds are all computed
in plain Python; the model only narrates the result, and degrades to a
deterministic template when no model is available.

It is **self-contained**: one Docker web service, **zero external paid services**.
SQLite for state, a vendored stdlib LLM router (local Ollama → paid → free →
deterministic offline), and stdlib/`authlib` auth. The live link is in
[`../../README.md`](../../README.md).

## Goals

- A single, extensible monitor for the whole fleet with vigil as a first-class
  self-monitored entry.
- A genuinely tiered product: guests, registered users, elevated users, admin —
  each tier a real server-enforced capability, not a UI gate.
- Production-shaped security/compliance output: risk-qualified, control-mapped
  findings reusing postureline's engine.
- Run for a reviewer with **no keys**; every credentialed surface is coded and
  clearly marked `NEEDS-CREDENTIAL`, never faked.

## Non-goals (current scope)

- Not a full APM/tracing backend; it is health/availability + posture, not
  distributed tracing.
- Single-instance (in-process poller, alert dedup, and rate-limit state). HA /
  multi-replica is roadmap.
- The per-git-push secret-scan **CI hook** is stubbed (the regex ruleset and the
  result shape are real; the repo-checkout/webhook is not wired).

## Functional requirements

- **FR-1 — Monitored-app registry.** A configurable list of targets
  (`slug`, `name`, `url`, `health_path`, optional `repo`, `tags`), seeded with the
  27 portfolio demos **plus vigil itself**. Extensible three ways with no code
  edit to consumers: the admin API (`POST /api/admin/targets`), a `targets.json`
  file, or `config.SEED_TARGETS`.
- **FR-2 — Probes.** A background asyncio poller hits each target's health URL
  every `VIGIL_POLL_INTERVAL` seconds, recording up/down, HTTP status, response
  time, and error into a self-pruning SQLite time series. Rolling availability and
  error rate are computed over the last `VIGIL_ROLLING_WINDOW` probes.
- **FR-3 — Tiered dashboard.**
  - **Guest (unauthenticated):** current status + error rate per app only —
    projected server-side so the endpoint cannot leak more.
  - **Registered:** availability/uptime history, response-time series, recent
    probe logs, the incident AI, and alert viewing.
  - **Elevated:** + per-app security/compliance posture and control-mapping; +
    alert configuration.
  - **Admin:** + registry management and user-role promotion.
- **FR-4 — Auth.** Email/password with email verification (token; emailed when
  SMTP is set, otherwise the link is logged + surfaced — `NEEDS-CREDENTIAL`), plus
  Google + GitHub OAuth via authlib (registered only when client id/secret exist —
  `NEEDS-CREDENTIAL`). Roles: guest / registered / elevated / admin.
  `marc.bittner@gmail.com` is the only bootstrap admin (auto-elevated, pre-verified)
  and can elevate others. Signup is rate-limited per-IP (token bucket).
- **FR-5 — Self-monitoring.** vigil probes its own `/health` like any target; the
  `vigil` entry is first-class in the registry and every tier.
- **FR-6 — Security + compliance.** Per app, live-endpoint checks (HTTPS/TLS,
  security headers, server-banner disclosure, health-secret leakage) produce
  risk-qualified findings, each mapped to ≥1 SOC 2 anchor control and crosswalked
  across SOC 2 · HIPAA · ISO 27001 · NIST 800-53 · NIST 800-171 · CMMC (reusing
  postureline's catalog + saturating posture curve). A gitleaks-style repo
  secret-scan ships its real ruleset but returns `status:"not_run"` (the CI hook
  is stubbed) rather than a fabricated pass.
- **FR-7 — Alerting.** Per-app `metric/comparator/threshold → channel` rules.
  Channels: `console` (live), `webhook` (live with a URL), `email`/`sms` (coded,
  `NEEDS-CREDENTIAL`, fall back to console). Edge-triggered dedup; events logged.
- **FR-8 — AI feature.** `POST /api/incident/summary` reads the live fleet state
  and returns `{summary, severity, situation, impacted, suggested_actions}`.
  Severity + priority order are code-decided (`incident.classify`); routing is
  paid → local → free → deterministic offline. A browser→host Ollama `client_summary`
  is accepted as the narrative while code still owns severity.
- **FR-9 — Tests.** Unit suite (`./run.sh test`) + a live smoke/regression suite
  (`./run.sh smoke [--url]`).
- **FR-10 — Ops.** `/health` is public + secret-free; `run.sh`
  (setup/serve/test/lint/demo/smoke/doctor); single-stage non-root Dockerfile.

## Architecture (modules)

| Module | Responsibility |
|---|---|
| `config.py` | Knobs + the seed/`targets.json` registry + `Target` model |
| `store.py` | SQLite: targets, probe time series, users, alert rules/events |
| `probe.py` | Async poller → records probes, evaluates alerts |
| `metrics.py` | Deterministic rolling availability/error-rate/latency reducer |
| `security.py` | Live checks → control-mapped findings + posture (postureline math) |
| `alerts.py` | Channel interface (console/webhook/email/sms) + edge-triggered eval |
| `auth.py` | scrypt passwords, sessions, roles, verification, OAuth, rate limit |
| `incident.py` | LLM summarizer — code decides severity, model narrates, offline drafter |
| `llm.py` | Vendored stdlib router (paid → local → free → offline) |
| `api.py` | FastAPI: tier-gated endpoints + poller lifespan + static SPA |

## Invariants (asserted by tests)

- Every security finding maps to ≥1 control (`test_security`).
- The guest endpoint exposes exactly `{slug,name,status,error_rate,self_monitor}`
  (`test_metrics`, `test_api`).
- `/health` never contains a credential-shaped token (`test_api`, smoke).
- Severity/priority are computed from metrics, not the model — a lying
  `client_summary` cannot change severity (`test_incident`).
- Posture score is in `[0,100]` on the saturating curve; clean = A/100.
- Signup is rate-limited per IP; the bootstrap admin is the only auto-admin.
