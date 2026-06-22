# vigil — Development Plan

Spec: [`spec.md`](./spec.md). Checkboxes reflect what is built and tested in this
MVP. This is a foundation: the architecture is deliberately extensible for new
targets, check types, alert channels, and auth providers.

## Phase 0 — MVP foundation ✅

- [x] FastAPI service + static SPA + single-stage non-root Dockerfile + `run.sh`
      (setup/serve/test/lint/check/demo/smoke/doctor), matching the repo house style.
- [x] Vendored stdlib LLM router (`llm.py`) — paid → local (Ollama) → free
      (OpenRouter) → deterministic offline, identical to slo-kit/postureline.
- [x] SQLite store (`store.py`): targets, probe time series (self-pruning), users,
      alert rules + events. Tables auto-created; seed registry upserted on boot.
- [x] Public, secret-free `/health` (vigil probes it like any target).

## Phase 1 — Registry + probes + metrics ✅

- [x] `Target` model + seed registry of the 27 portfolio demos **plus vigil**.
- [x] Three extension paths with no consumer code change: admin API, `targets.json`,
      `config.SEED_TARGETS`.
- [x] Async poller (`probe.py`): concurrent health probes, up/down/latency/error
      recorded; immediate probe on startup; survives per-cycle failures.
- [x] Deterministic rolling metrics (`metrics.py`): availability, error rate,
      avg/p95 latency, up/degraded/down status, fleet rollup.
- [x] Self-monitoring: the `vigil` entry is the same code path as any target.

## Phase 2 — Auth + tiering ✅

- [x] Email/password (stdlib scrypt) + signed-cookie sessions (itsdangerous).
- [x] Email verification tokens; emailed when SMTP set, else logged + surfaced
      (NEEDS-CREDENTIAL) so the flow is completable with zero creds.
- [x] Roles guest/registered/elevated/admin; bootstrap admin hardcoded
      (`marc.bittner@gmail.com`), auto-elevated + pre-verified; admin can promote.
- [x] Per-IP token-bucket rate limit on signup.
- [x] Server-enforced tier gating via `require_role` dependencies (401/403),
      independent of the UI.
- [x] Google + GitHub OAuth scaffolding via authlib — registered only when client
      id/secret are present (NEEDS-CREDENTIAL); buttons appear only when enabled.

## Phase 3 — Security & compliance ✅

- [x] Reuse postureline's engine: control catalog + six-framework crosswalk,
      `Finding`-style shape (every finding maps to ≥1 control), severity-weighted
      saturating posture score + letter grade.
- [x] Live-endpoint scanner (runs now): HTTPS/TLS, HSTS/CSP/X-Content-Type/
      X-Frame-Options/Referrer-Policy, server-banner disclosure, health-secret leak.
- [x] Pure scoring core (`findings_from_response`) split from the HTTP fetch, so the
      demo/tests score from fixtures and the live path shares identical logic.
- [x] Per-app posture report: findings + controls + framework rollup + score.
- [ ] **STUB:** gitleaks-style repo secret scan — real regex ruleset + result shape,
      returns `status:"not_run"`; per-push CI hook / repo checkout NEEDS-CREDENTIAL.

## Phase 4 — Alerting ✅

- [x] Rule model: per-app `metric/comparator/threshold → channel (+addr)`.
- [x] Channel interface (`Channel.send`): console (live), webhook (live w/ URL),
      email (SMTP) + SMS (Twilio) **coded**, gated on creds (NEEDS-CREDENTIAL),
      degrade to console when unconfigured.
- [x] Edge-triggered evaluation (ok→breach only) wired into every poll cycle;
      events persisted + shown in the UI.

## Phase 5 — AI incident summarizer ✅

- [x] `incident.classify` — deterministic severity (none/sev3/sev2/sev1) + impacted
      priority order from the fleet rollup. **Code decides.**
- [x] LLM narrative over the chain with a deterministic offline drafter (same JSON
      shape); lenient parse; browser→host Ollama `client_summary` accepted.
- [x] `evaluate()` scores the classifier on labeled snapshots (exact offline).

## Phase 6 — UI + docs + tests ✅

- [x] Single-page reactive console: status (guest), dashboard + detail sparkline +
      logs (registered), incident AI, alerts, security posture (elevated), admin.
- [x] Auth modal (sign in / sign up / OAuth buttons / verification-link surfacing).
- [x] Unit tests (metrics, security, auth, incident, alerts, llm, api) + live
      smoke/regression suite. `./run.sh test` green; `./run.sh smoke` green.
- [x] README + this spec + development plan.

## Roadmap (post-MVP)

- Wire the per-push CI secret-scan hook (clone token / diff webhook) — the only stub.
- Persist alert-dedup + rate-limit state for multi-replica HA.
- Add channels (Slack/PagerDuty) — one `Channel` subclass each.
- Multi-window burn-rate alerting + SLO targets per app (slo-kit crossover).
- Retain/aggregate long-horizon history (downsampled rollups).
