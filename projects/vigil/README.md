# vigil

[![CI](https://github.com/MarcBittner/ai-portfolio/actions/workflows/projects-ci.yml/badge.svg)](https://github.com/MarcBittner/ai-portfolio/actions/workflows/projects-ci.yml)
[![License: Proprietary](https://img.shields.io/badge/license-proprietary-red.svg)](LICENSE)
[![Python 3.11+](https://img.shields.io/badge/python-3.11+-blue.svg)](https://www.python.org)
[![Ruff](https://img.shields.io/badge/lint-ruff-261230.svg)](https://github.com/astral-sh/ruff)
[![FastAPI](https://img.shields.io/badge/api-FastAPI-009688.svg)](https://fastapi.tiangolo.com)

**Public observability + SOC monitoring for the whole ai-portfolio fleet — and for
itself.** `vigil` probes every live demo's health on a schedule, records a time
series in SQLite, derives rolling availability / error-rate / latency, scores each
app's **security & compliance posture** against six control frameworks, dispatches
configurable alerts, and compresses the live fleet state into an **LLM-written
incident narrative**. It runs as a **single Docker web service with zero external
paid services**.

The product is genuinely **tiered**: guests see live status, registered users see
history + the incident AI, elevated users see the compliance posture, and an admin
manages the registry and user roles — each tier enforced server-side.

> **The LLM reads, the code decides.** Status, severity, the posture score, and
> alert thresholds are all computed in deterministic Python. The model only narrates
> the result and degrades to a deterministic template when no model is configured —
> so vigil runs end-to-end with **zero keys**.

## Contents

- [Demo path](#demo-path)
- [What it does](#what-it-does)
- [Tiers & auth](#tiers--auth)
- [Security & compliance](#security--compliance)
- [LLM usage](#llm-usage)
- [Architecture](#architecture)
- [Run it](#run-it)
- [What's stubbed / needs credentials](#whats-stubbed--needs-credentials)
- [Spec](#spec)

## Demo path

```bash
./run.sh setup            # venv + install (or: ./run.sh setup --no-venv)
./run.sh demo             # offline: synthetic probes → metrics → posture → LLM summary
./run.sh serve            # live console at http://127.0.0.1:8020
./run.sh test             # unit suite (fast)
./run.sh smoke            # spin up a server and run the live regression suite
```

In the live console:

1. **Status** (no account) — the fleet, each app's current status + error rate,
   vigil included.
2. **Sign up** (top-right) — you get a `registered` account. With no SMTP
   configured, the verification link is logged to the server console **and** shown
   in the modal (click it). Sign in as `marc.bittner@gmail.com` to land straight in
   as **admin** (pre-verified).
3. **Dashboard** — availability/error-rate/latency per app; click a row for the
   response-time sparkline + recent probe logs.
4. **Incident AI** — generate a fleet-health narrative + prioritized actions
   (offline mode works with no keys).
5. **Security & Compliance** (elevated) — per-app posture, control-mapped findings,
   six-framework rollup. Admin can promote a user to `elevated` on the **Admin** tab.
6. **Alerts** / **Admin** — add an alert rule, add a monitored target, manage roles.

## What it does

- **Registry** — a configurable list of targets (`slug`, `url`, `health_path`,
  optional `repo`, `tags`), seeded with the 27 portfolio demos **plus vigil itself**.
  Add a target three ways with no code change to anything that consumes it: the admin
  API, a `targets.json` file, or `config.SEED_TARGETS`.
- **Probes** — a background asyncio poller hits every target's health URL each
  `VIGIL_POLL_INTERVAL` seconds, recording up/down, HTTP status, response time, and
  error into a **self-pruning SQLite time series**.
- **Metrics** — deterministic rolling availability, error rate, and avg/p95 latency
  over the last `VIGIL_ROLLING_WINDOW` probes; up/degraded/down status; fleet rollup.
- **Self-monitoring** — vigil is a first-class entry in its own registry and is
  probed on the same code path as everything else.

## Tiers & auth

| Tier | Sees |
|---|---|
| **guest** (anon) | current status + error rate per app **only** (projected server-side) |
| **registered** | + availability history, response-time series, probe logs, incident AI, alert viewing |
| **elevated** | + security & compliance posture + control-mapping; + alert configuration |
| **admin** | + registry management + user-role promotion |

- **Email/password** with stdlib `scrypt` hashing and signed-cookie sessions.
- **Email verification** by token (emailed when SMTP is set; otherwise logged +
  surfaced so the flow still completes — see *needs credentials*).
- **Social OAuth** (Google + GitHub) via `authlib`; the redirect/callback code is
  present and each provider registers **only when its client id/secret exist**.
- **Roles** guest/registered/elevated/admin. `marc.bittner@gmail.com` is the only
  bootstrap admin (auto-elevated, pre-verified) and can promote others.
- **Signup is rate-limited** per IP (token bucket) to resist abuse. Anyone may sign up.
- Tiering is enforced by `require_role` dependencies (401/403) — **not** by the UI.

## Security & compliance

vigil **reuses postureline's engine**. Live-endpoint checks run now against each
app's real URL:

- HTTPS/TLS enforcement, security response headers (HSTS, CSP, X-Content-Type-Options,
  X-Frame-Options, Referrer-Policy), server-banner disclosure, and **health-secret
  leakage** (a `/health` that exposes credential-shaped tokens).

Every finding is **risk-qualified** (critical/high/medium/low) and **mapped to ≥1
SOC 2 anchor control**, crosswalked across **SOC 2 · HIPAA · ISO 27001 · NIST 800-53 ·
NIST 800-171 · CMMC**, and rolled into a **severity-weighted, saturating posture
score** + letter grade (postureline's curve). A gitleaks-style **repo secret scan**
ships its real regex ruleset and result shape but is a **clearly-marked stub** —
the per-push CI hook / repo checkout is not wired (see below).

## LLM usage

One genuine LLM surface: the **incident / fleet-health summarizer**
(`POST /api/incident/summary`). It reads the live fleet state and writes a concise
status narrative + prioritized actions.

- **Code decides** the severity (`none`/`sev3`/`sev2`/`sev1`) and the impacted
  priority order in `incident.classify` from the metrics — never the model.
- Routing is the portfolio-standard chain (`llm.py`): **paid → local (Ollama) →
  free (OpenRouter) → deterministic offline drafter**. The offline drafter emits the
  same JSON shape, so the feature (and its eval) reproduces with zero keys.
- A browser→host **Ollama `client_summary`** is accepted as the narrative while code
  still owns severity — the same local-LLM bridge used across the portfolio.

## Architecture

```
config.py    knobs + seed/targets.json registry + Target model
store.py     SQLite: targets, probe time series, users, alert rules/events
probe.py     async poller → records probes, evaluates alerts each cycle
metrics.py   deterministic rolling availability/error-rate/latency reducer
security.py  live checks → control-mapped findings + posture (postureline math)
alerts.py    channel interface (console/webhook/email/sms) + edge-triggered eval
auth.py      scrypt passwords, sessions, roles, verification, OAuth, rate limit
incident.py  LLM summarizer — code decides severity, model narrates, offline drafter
llm.py       vendored stdlib router (paid → local → free → offline)
api.py       FastAPI: tier-gated endpoints + poller lifespan + static SPA
```

## Run it

```bash
./run.sh setup            # or --no-venv to install into the current env
./run.sh serve            # http://127.0.0.1:8020
./run.sh demo             # offline pipeline demo
./run.sh test             # unit tests
./run.sh smoke            # live regression (local server, or --url <deploy>)
./run.sh doctor           # python/venv/ollama status
```

Docker (how Render runs it):

```bash
docker build -t vigil .
docker run -p 8080:8080 vigil      # GET /health, open /
```

## What's stubbed / needs credentials

vigil runs fully with **no `.env`**. Everything below is **coded** and switches on
when the credential is set; until then it degrades gracefully and is marked
`NEEDS-CREDENTIAL` in the UI/logs. See [`.env.example`](.env.example).

| Surface | State | To go live |
|---|---|---|
| **Session secret** | dev default | Set `VIGIL_SECRET` to a strong random value (so sessions survive restarts / can't be forged). |
| **Email verification** | link logged + surfaced in the signup response | Set `SMTP_HOST` / `SMTP_USER` / `SMTP_PASS` (+ `SMTP_PORT`, `SMTP_FROM`) to email it. |
| **Email alerts** | falls back to console | Same SMTP vars. |
| **SMS alerts** | falls back to console | Twilio: `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM`. |
| **Google OAuth** | button hidden until configured | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`; redirect URI `{VIGIL_SELF_URL}/auth/oauth/google/callback`. |
| **GitHub OAuth** | button hidden until configured | `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`; redirect URI `{VIGIL_SELF_URL}/auth/oauth/github/callback`. |
| **LLM (real model)** | deterministic offline drafter | Any of `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `OPENROUTER_API_KEY`, or a reachable Ollama. |
| **Repo secret-scan CI hook** | **stub** — real ruleset, returns `not_run` | Wire a per-push webhook (diff or clone token) to feed `security.scan_repo`. |
| **Self URL** | `http://127.0.0.1:8020` | Set `VIGIL_SELF_URL` to the public deploy URL (self-probe + OAuth/email links). |

Everything else — probing, metrics, the tiered dashboard, auth + roles + rate
limiting, live security posture + control-mapping, console/webhook alerts, and the
incident summarizer — **is done and working with zero credentials.**

## Spec

- [`docs/spec/spec.md`](docs/spec/spec.md) — functional requirements + invariants.
- [`docs/spec/development-plan.md`](docs/spec/development-plan.md) — phased plan +
  roadmap.
