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

- [x] Single-page reactive console: status (guest), dashboard + detail sparkline
      (registered), incident AI, alerts, security posture (elevated), admin.
      NOTE: the "logs" shown are the **probe-result feed** (up/down/HTTP/error
      samples), NOT ingested application logs — see the gap analysis below.
- [x] Auth modal (sign in / sign up / OAuth buttons / verification-link surfacing).
- [x] Unit tests (metrics, security, auth, incident, alerts, llm, api) + live
      smoke/regression suite. `./run.sh test` green; `./run.sh smoke` green.
- [x] README + this spec + development plan.

## Gap analysis vs. the original brief (2026-06-22)

Honest audit of the shipped MVP against **every** requirement in the original
observability brief. The MVP covers the auth/tiering/probe/security/alert/AI
skeleton, but several first-class requirements are missing or only stubbed — the
review below is the source of truth, not the optimistic ✅s above.

Legend: ✅ done · ◐ partial · ⛔ missing.

| # | Requirement (from the brief) | Status | Reality / gap |
|---|---|---|---|
| 1 | Public app monitoring **all** demos + itself | ✅ | 28 targets probed; `vigil (self)` is the same code path |
| 2 | Authentication required | ✅ | scrypt + signed-cookie sessions |
| 3 | Guests see **only** status + error rate | ✅ | `metrics.guest_view` projects to the minimal shape server-side |
| 4 | Registered see **availability** | ✅ | availability / error-rate / avg+p95 latency from the probe series |
| 5 | Registered see **logs** | ⛔ | **No log ingestion at all.** The "logs" panel is the probe-result feed, not application/structured logs from the monitored apps or from vigil itself |
| 6 | Registered see **metrics** | ◐ | Only **black-box** probe metrics (uptime/error-rate/latency). No app-exposed metrics (`/metrics` scrape), no RED/throughput/saturation, no resource metrics, no real charts beyond a sparkline |
| 7 | Registered see **code-quality** | ⛔ | **Nothing.** No lint/test/coverage/complexity ingestion or display |
| 8 | Security scans **for each push** | ⛔ | Scans are on-demand, not per-commit; no push history, no per-push diffing |
| 9 | **Definition of "up" is surfaced** | ⛔ | "up" = HTTP 200–399 on `/health`, hardcoded, and **never shown in the UI** — exactly the "no indication of how up is defined" complaint |
| 10 | Extensible to add new infra/apps | ✅ | admin API + `targets.json` + `SEED_TARGETS`, no consumer code change |
| 11 | **Extensible custom checks** — curl a specific endpoint + define response conditions | ⛔ | **Biggest gap.** Only a fixed `GET /health` with a hardcoded 200–399 rule. No user-defined synthetic checks: no per-check method/path/headers/body, no assertions (status set, latency budget, body-contains, JSON-path equals/exists, regex), no per-check schedule |
| 12 | Security scan of **live apps** → risk-qualified findings | ✅ | TLS/HSTS/CSP/headers/exposure checks → severity-weighted, control-mapped posture |
| 13 | Security scan of **repos** | ◐ | gitleaks-style interface present but **STUBBED** — returns "not yet run" (needs repo checkout / CI hook). No dependency-CVE/SAST scanning either |
| 14 | Findings map to SOC 2 / HIPAA / NIST (+ISO/CMMC); failing controls listed | ✅ | six-framework crosswalk; failing controls derived from findings |
| 15 | **Specific CSVs** of findings / failing controls | ⛔ | JSON only; no CSV export endpoint |
| 16 | Configurable alerting | ✅ | per-target rule: metric + comparator + threshold |
| 17 | Alert channel: **email** | ◐ | send path coded; **NEEDS-CREDENTIAL** (SMTP env unset) |
| 18 | Alert channel: **SMS** | ◐ | send path coded; **NEEDS-CREDENTIAL** (Twilio env unset) |
| 19 | Alert channel: other (webhook) | ✅ | `WebhookChannel` works with a URL; `ConsoleChannel` always |
| 20 | **Google OAuth** | ◐ | authlib scaffold; **NEEDS-CREDENTIAL** (no client id/secret) — never exercised |
| 21 | Other social logins (**GitHub**) | ◐ | same scaffold; **NEEDS-CREDENTIAL** |
| 22 | Email/password + verification | ✅ | verification emailed when SMTP set, else link surfaced/logged |
| 23 | `marc.bittner@gmail.com` sole privileged user | ✅ | bootstrap admin (seeded from `VIGIL_ADMIN_PASSWORD` on each boot) |
| 24 | Anyone can sign up | ✅ | open signup → `registered` |
| 25 | Rate-limit the signup endpoint | ✅ | per-IP token bucket |
| 26 | Admin can **elevate** users to (a) full visibility+alerting, (b) admin | ◐ | `elevated`/`admin` promotion exists; the two tiers aren't clearly mapped/labeled to "full visibility + alerting" vs "admin", and there's no UI to choose which |
| 27 | Self-monitor: own **uptime/response** | ✅ | `vigil (self)` target |
| 28 | Self-monitor: own **logs/metrics** | ⛔ | inherits gaps #5/#6 — vigil doesn't expose or capture its own logs/metrics |
| 29 | Self-monitor: run the **same tests/security scans on itself** | ◐ | self security-scan runs; the app does **not** run its own test suite as a live, surfaced check |
| 30 | ≥1 AI feature on trueline's routing fallback | ✅ | incident summarizer via the standard local→paid→free→offline chain |
| 31 | Persistence of accounts/history across restarts | ⛔ | SQLite in ephemeral `/tmp` on free tier; only the admin is re-seeded — all other users/history are lost on redeploy (needs a persistent disk or external DB) |

## Remediation backlog (prioritized — built next, NOT yet done)

### P0 — the explicitly-called-out gaps
- [ ] **Custom, extensible checks (#11).** A `checks` table + model: per target, define
      `method`, `path`, headers, optional body, and an **assertion set** — expected
      status (or set), max-latency budget, `body_contains`, `json_path == value`,
      `json_path exists`, header equals/exists, regex match. The prober runs each
      check; "up" becomes "all required assertions passed." Admin UI + API to add/
      edit/disable checks; seed each app's `/health` as the default check.
- [ ] **Surface the definition of "up" (#9).** Every status badge links to the exact
      check(s) that define it (method/URL/assertions) and the last raw probe
      (HTTP code, latency, response snippet, which assertion failed).
- [ ] **Logs (#5, #28).** A `logs` ingestion path: a pull adapter (fetch a target's
      `/logs`/journal endpoint where exposed) and a push endpoint
      (`POST /api/ingest/logs`, token-auth) writing a structured `logs` time series;
      a registered-tier log viewer with level/source/time filters; vigil ships its
      own structured logs through the same path.
- [ ] **Metrics depth (#6, #28).** Scrape an app's `/metrics` (Prometheus text) where
      present; store named series; render real charts (latency, throughput, error
      rate, custom gauges) — not just the probe sparkline. vigil exports its own.
- [ ] **Code-quality (#7).** Ingest per-commit lint/test/coverage/complexity
      (`POST /api/ingest/quality` from CI, or read a committed `quality.json`); show
      a per-app trend + latest grade in the registered tier.

### P1 — per-push + security completeness
- [ ] **Per-push pipeline (#8, #16).** A GitHub webhook (`POST /api/hooks/github`) +
      a CI step that, on each push, posts commit sha + runs repo secret-scan,
      dependency-CVE, live security scan, and quality — stored as a per-commit row so
      every dimension has push history and diffs.
- [ ] **Real repo scanning (#13).** Wire the gitleaks-style secret scan to an actual
      checkout/diff (read-only token) + add dependency-CVE (pip/npm/go) and a light
      SAST pass; replace the "not yet run" stub.
- [ ] **CSV export (#15).** `GET /api/security/export.csv` (and per-target) of
      findings and failing controls per framework.
- [ ] **Run vigil's own tests as a live check (#29).** Surface `./run.sh test` /
      smoke results for vigil itself in the dashboard.

### P2 — credentials & durability (need user input / paid tier)
- [ ] **Enable Google + GitHub OAuth (#20, #21)** once client id/secret are provided.
- [ ] **Enable email + SMS alerting (#17, #18)** once SMTP + Twilio creds are provided.
- [ ] **Clarify the elevation tiers (#26):** make `elevated` = full visibility +
      alerting and `admin` = user management, label them in the admin UI, and let the
      admin pick which to grant.
- [ ] **Durable persistence (#31):** move off ephemeral `/tmp` — a Render persistent
      disk (`VIGIL_DB` on the mount) or an external DB — so non-admin accounts and
      history survive redeploys.

### P3 — originally-listed polish
- [ ] Persist alert-dedup + rate-limit state for multi-replica HA.
- [ ] Add channels (Slack/PagerDuty) — one `Channel` subclass each.
- [ ] Multi-window burn-rate alerting + SLO targets per app (slo-kit crossover).
- [ ] Retain/aggregate long-horizon history (downsampled rollups).
