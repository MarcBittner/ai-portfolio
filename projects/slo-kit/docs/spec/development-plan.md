# slo-kit — Development Plan

Spec: [`spec.md`](./spec.md). Current system, design decisions, and evals live in the
in-repo [`README.md`](../../README.md); the incident runbook in [`../runbook.md`](../runbook.md).
Checkboxes reflect what is built and live.

**Legend:** `[x]` complete · `[>]` in progress · `[ ]` pending

## Phase 0 — Instrumented core (MVP) ✅

- [x] Scaffold: `pyproject`, `run.sh` (replaces make, with smoke + doctor), Dockerfile,
      LICENSE, CI.
- [x] RED metrics registry + Prometheus text exposition (stdlib-only, lock-guarded).
- [x] OpenTelemetry-style trace recorder (bounded ring buffer, `deque maxlen 200`).
- [x] SLI/SLO + error-budget + burn-rate computation (`slo.py`, a pure function over a
      snapshot).
- [x] Instrumented outreach service with **deterministic** fault injection + load
      generator; one metric + one span per request at a single choke point.
- [x] FastAPI surface: `/v1/messages`, `/metrics[/snapshot]`, `/slo`, `/traces`,
      `/admin/{fault,loadtest,reset}` + a Grafana-style dashboard.
- [x] Ops artifacts: Terraform multiwindow burn-rate alerts, smoke-gated GitHub Actions
      pipeline, one-page incident runbook.
- [x] Tests (metrics / SLO / service / API) + local & remote smoke; ruff clean;
      `./run.sh demo` offline (burn → recover); `./run.sh eval` reproducible.

## Phase 1 — Incident summary (LLM) ✅

- [x] `POST /incident/summary`: compress the live SLO snapshot + RED metrics + error
      spans into `{summary, severity, suggested_steps[]}`.
- [x] **Deterministic severity** (`incident.classify`) from burn rate + budget + latency
      — the trust-critical decision never depends on the model.
- [x] Runbook steps keyed to the situation, mirroring `docs/runbook.md`, so the draft a
      responder gets matches the page they would open.
- [x] **Deterministic offline drafter** as the terminal fallback — templates the same
      shape, so the capability and its eval reproduce with zero keys.
- [x] Incident-summary eval over labeled snapshots (severity + situation accuracy);
      `/evals` and `eval-report.md`.

## Phase 2 — LLM routing & local models ✅

- [x] Routing chain (`llm.py`): anthropic → openai → ollama → openrouter → offline;
      providers self-select from the environment; honest provider/model/latency/cost.
- [x] Routing **modes** (auto / local / paid / free / offline) selectable in Settings,
      with a visible indicator of which provider actually served the request.
- [x] **Browser→host Ollama bridge:** the cloud server can't reach `localhost`, so the
      browser probes the operator's host Ollama, runs `incident.py`'s exact prompt, and
      posts back **only the narrative** (`client_summary`); the server keeps severity +
      steps deterministic. Lets a cloud demo run a real local model.
- [x] **Local model autodetect:** the model field is populated from the host's installed
      models (`/api/tags`) so local doesn't 404 on a guessed name.
- [x] Free hosted model wiring (OpenRouter) as the server fallback.

## Phase 3 — Observability & UX (Diagnostics / About / theming) ✅

- [x] **Diagnostics view:** resolved provider/model + last-summary latency, the active
      routing chain, live provider status, and a **model benchmark** across every routing
      mode (`GET /diagnostics/benchmark`) — the `local` row exercised via the browser→host
      bridge, mirroring trueline's Diagnostics.
- [x] **About panel:** what this is / how it works / the grouped stack / how the LLM is
      used / design principles — company-neutral, SRE-focused, reflecting the Prometheus /
      Grafana-LGTM / OTel / Terraform signals an SRE shop runs on.
- [x] **Guided demo path:** an inline step cue (run load → inject → summarize → reset) on
      the operator controls, plus a Help modal with the same flow.
- [x] **Light/dark/system theme** with a no-flash bootstrap (applied before paint) and a
      segmented control in Settings, persisted to localStorage.
- [x] Settings drawer (routing mode, model override, load/incident defaults) + a portfolio
      launcher (catalog SSOT) + keyboard shortcuts (`?`, `Esc`, `Ctrl/⌘K`, `G`).
- [x] Test for the benchmark endpoint (`GET /diagnostics/benchmark`): every mode present,
      severity identical across modes (deterministic), provider/model/latency surfaced.

## Current state

Live and offline-safe. The SLO core, metrics, and traces are deterministic and run with
zero keys; the incident summarizer degrades local → paid → free → deterministic offline
with honest labels, a browser→host local path, and autodetected local models. Severity is
classified in code, never by the model. A Diagnostics view surfaces the resolved engine
and a per-mode benchmark; an About panel documents the stack and principles. `./run.sh
check` (ruff + pytest) is green.

## Roadmap (proposed improvements)

Grouped by theme, roughly in priority order.

### Reliability fidelity (the part an SRE will probe)
- [ ] **Multi-window burn rate.** The service computes a single-window consumption ratio
      while the README/Terraform advertise multi-window burn; implement the multi-window
      burn (fast 1h + slow 6h) so the runtime matches the alert policy.
- [ ] **Budget boundary bug.** At exactly the 0.5% budget, status reports `healthy` while
      `budget_remaining` is `0.0` and the `burning` branch is effectively dead; fix the
      boundary comparison and cover it with a test.
- [ ] **Reconcile thresholds.** The sev1 threshold (10×) disagrees with the fast-burn
      alert (14.4×); pick one source of truth (constant) for severity and the alarm.
- [ ] **Rolling time-window metrics** instead of cumulative-since-reset, so SLIs reflect a
      sliding window the way a real scraper sees them.
- [ ] **Real OpenTelemetry export** (OTLP → Tempo/Jaeger) behind a flag; the call sites
      already isolate `tracing.py` so it's a drop-in.

### Hardening & security
- [ ] **Gate `/admin/*`.** `fault` / `loadtest` / `reset` are unauthenticated; add a token
      (at least for non-demo deploys).
- [ ] **Perf/concurrency.** O(n) `list.pop(0)` on the latency window → `deque`; lock the
      tracer under concurrent requests.
- [ ] **Input limits** — cap load sizes / request bodies; basic rate limiting.

### Alerting & deploy
- [ ] **Alertmanager / Grafana provisioning** alongside the Terraform (dashboards as code).
- [ ] **Per-endpoint SLOs** + a budget-policy "freeze releases when exhausted" hook wired
      to the CI gate.

### LLM & eval
- [ ] **Schema-validated extraction with retry** — validate the model's JSON against a
      strict schema and re-prompt on malformed output instead of best-effort parsing.
- [ ] **Score live-model narratives** — measure summary quality (faithfulness to the
      snapshot, no invented numbers) against the deterministic draft, not just severity.
- [ ] **More providers** (Azure / Bedrock) and cost/quality-aware routing.

## Code review backlog (from `/docs/code-review/slo-kit.md`, 2026-06-18)

Grade **A−**.

- [ ] **MED — budget boundary bug** (see Roadmap → Reliability fidelity).
- [ ] **MED — single-window vs multi-window burn** (see Roadmap → Reliability fidelity).
- [ ] **MED — ungated `/admin/*`** (see Roadmap → Hardening & security).
- [ ] **LOW — threshold mismatch** sev1 10× vs fast-burn 14.4× (see Roadmap).
- [ ] **LOW — perf/concurrency** latency-window `pop(0)` + unlocked tracer (see Roadmap).
