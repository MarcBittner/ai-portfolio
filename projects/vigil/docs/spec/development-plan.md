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
- [x] gitleaks-style repo secret scan (`secretscan.py`) — real regex ruleset over a
      target's local source (in-repo) or CI-pushed results (`POST /api/ingest/scan`),
      folded into the posture report mapped to `CC6.3`; `not_run` only when neither
      a local tree nor a pushed scan exists.

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
      (registered), incident AI, alerts, security posture (elevated), admin. The
      target detail now also carries a **Metrics** panel (scraped `/metrics`,
      inline-SVG sparklines + latest values) and a **Logs** panel (ingested
      structured logs with level/time filters) — distinct from the probe-result feed,
      closing #5/#6/#28 (see the backlog below).
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
| 5 | Registered see **logs** | ✅ | Real structured-log ingestion: `logs` table + `POST /api/ingest/logs` (X-Ingest-Token, loopback-only when unset) + a registered-tier viewer `GET /api/targets/{slug}/logs` with level/since filters; vigil ships its own operational logs under slug `vigil` (poll cycles, alert fires, errors) |
| 6 | Registered see **metrics** | ✅ | App-metrics scrape: stdlib Prometheus-text parser (`promparse.py`) + `metric_samples` table; the poll cycle scrapes each target's `/metrics` (per-target `metrics_path`, 404/HTML/parse-miss skipped), stores a bounded series set; registered-tier viewer `GET /api/targets/{slug}/metrics` (latest values + SVG sparkline series); vigil exposes its own `/metrics` (real counters/gauges) and is scraped like any target |
| 7 | Registered see **code-quality** | ✅ | `quality` table + `POST /api/ingest/quality` (token/loopback; **vigil derives the letter grade** in `quality.py`, never the caller) + registered viewer `GET /api/targets/{slug}/quality` (latest + trend) and a Code-quality panel on target detail. CI (the reference workflow) posts ruff/pytest/coverage per push |
| 8 | Security scans **for each push** | ✅ | `POST /api/hooks/github` (HMAC-SHA256 verified, secure-by-default) maps changed `projects/<slug>/` paths to targets, records a `pushes` row per commit, and runs the live security scan keyed to the commit. `GET /api/targets/{slug}/pushes` + a Pushes panel give per-push history/diffing |
| 9 | **Definition of "up" is surfaced** | ✅ | `GET /api/targets/{slug}/up-definition` + the dashboard detail's "Definition of up" panel show the required checks (method/path/assertions in plain English) and the last raw result per check (HTTP code, latency, which assertion failed) |
| 10 | Extensible to add new infra/apps | ✅ | admin API + `targets.json` + `SEED_TARGETS`, no consumer code change |
| 11 | **Extensible custom checks** — curl a specific endpoint + define response conditions | ✅ | `checks`/`check_results` tables + assertion engine (`checks.py`): per-check method/path/headers/body and an assertion set — status (in/eq/lt/gt), latency budget, body-contains (+negate), body-regex, JSON-path (eq/exists/lt/gt/contains), header (eq/exists/contains). "up" = all REQUIRED checks pass. Admin CRUD + "Run now" API & UI; each app's `/health` seeded as the default check (legacy 200–399 preserved) |
| 12 | Security scan of **live apps** → risk-qualified findings | ✅ | TLS/HSTS/CSP/headers/exposure checks → severity-weighted, control-mapped posture |
| 13 | Security scan of **repos** | ✅ | Real gitleaks-style scanner (`secretscan.py`: AWS/GitHub PAT/Slack/OpenAI/Anthropic/Render/private-key/generic + entropy-gated catch-all). Scans a target's **local source** when vigil runs in-repo, else accepts **CI-pushed** results (`POST /api/ingest/scan`, per-commit). Findings fold into the posture report mapped to `CC6.3`; `not_run` only when neither source exists. (Dependency-CVE/SAST still out of scope) |
| 14 | Findings map to SOC 2 / HIPAA / NIST (+ISO/CMMC); failing controls listed | ✅ | six-framework crosswalk; failing controls derived from findings |
| 15 | **Specific CSVs** of findings / failing controls | ✅ | `GET /api/security/export.csv` + `GET /api/security/{slug}/export.csv` (elevated-gated, stdlib `csv`, `Content-Disposition` attachment): one row per finding × control × framework plus failing-control rows — columns `slug,finding,severity,control_id,framework,framework_control,status` |
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
| 26 | Admin can **elevate** users to (a) full visibility+alerting, (b) admin | ✅ | admin Users page now shows a tier legend (registered = status/availability/logs/metrics · **elevated = full visibility + alerting** · **admin = + user management**) with per-role grant/demote buttons; the admin can't change their own role |
| 27 | Self-monitor: own **uptime/response** | ✅ | `vigil (self)` target |
| 28 | Self-monitor: own **logs/metrics** | ✅ | vigil captures its own structured logs (a `logging` handler mirrors the `vigil` logger into the logs table + an explicit `selflog.slog` hook for poll/alert/error events) and exposes its own `/metrics` (Prometheus text) that its self-target scrapes through the identical parse+store path |
| 29 | Self-monitor: run the **same tests/security scans on itself** | ✅ | self security-scan runs (now incl. a real repo secret scan of vigil's own tree); and the reference CI workflow posts vigil's own ruff+pytest+coverage to `/api/ingest/quality` under slug `vigil`, so the self-target carries a code-quality grade like any monitored app |
| 30 | ≥1 AI feature on trueline's routing fallback | ✅ | incident summarizer via the standard local→paid→free→offline chain |
| 31 | Persistence of accounts/history across restarts | ◐ | **Code-ready** — `VIGIL_DB` points the SQLite file anywhere and the store self-migrates existing files; set it to a mounted path and data persists. **Blocked on infra/cost only:** Render's *free* tier has no persistent disk, so making it durable needs a paid instance (disk mounted, `VIGIL_DB` on it) or an external DB. On free tier the admin still re-seeds from `VIGIL_ADMIN_PASSWORD` each boot |

## Remediation backlog (prioritized — built next, NOT yet done)

### P0 — the explicitly-called-out gaps
- [x] **Custom, extensible checks (#11).** `checks` + `check_results` tables + a pure
      assertion engine (`checks.py`): per target, define `method`, `path`, headers,
      optional body, and an **assertion set** — status (in/eq/lt/gt), max-latency
      budget, `body_contains` (+negate), `body_regex`, `json_path`
      (eq/exists/lt/gt/contains), header equals/exists/contains. The prober runs each
      enabled check, records a per-check result, and "up" = **all required checks
      passed** (no checks → legacy single `/health` GET). Admin CRUD + "Run now" API
      (`/api/admin/checks…`) and an admin Checks UI; each app's `/health` is seeded as
      the default check so existing behavior (200–399 = up) is preserved.
- [x] **Surface the definition of "up" (#9).** `GET /api/targets/{slug}/up-definition`
      returns the required checks (method/URL/assertions in plain English) + the last
      raw result per check (HTTP code, latency, response snippet, which assertion
      failed); the dashboard detail renders a "Definition of up" panel from it.
- [x] **Logs (#5, #28).** A structured `logs` table (slug/ts/level/source/message/meta,
      indexed on (slug, ts DESC), self-pruning to `MAX_LOGS_PER_TARGET`) with
      `add_logs`/`recent_logs` accessors. A push endpoint `POST /api/ingest/logs`
      token-authenticated via `X-Ingest-Token` (env `VIGIL_INGEST_TOKEN`; when
      unset, accepts loopback callers only — dev-usable, safe by default). A
      registered-tier viewer `GET /api/targets/{slug}/logs?level=&limit=&since=` with
      a UI Logs panel (level + time filters, level-colored rows; guests blocked
      server-side). vigil ships its OWN logs through the same path: a `logging`
      handler (`selflog.DBLogHandler`) mirrors the `vigil` logger into the table plus
      an explicit `selflog.slog` hook records poll cycles, alert fires, and errors
      under slug `vigil`.
- [x] **Metrics depth (#6, #28).** A stdlib-only Prometheus-text parser
      (`promparse.py` → `(name, labels, value)`, never raises on malformed input,
      handles HELP/TYPE/labels/escapes/±Inf/NaN). A `metric_samples` table
      (slug/ts/name/labels/value, indexed on (slug, name, ts DESC), self-pruning to
      `MAX_METRICS_PER_TARGET`) with `record_metrics`/`metric_series`/
      `latest_metrics`. The poll cycle scrapes each target's metrics path (default
      `/metrics`, per-target `metrics_path` override; 404/HTML/parse-miss skipped, a
      failure never breaks the health poll; series capped per scrape). A
      registered-tier viewer `GET /api/targets/{slug}/metrics` (latest values + a few
      series) with a UI Metrics panel (inline-SVG sparklines + latest-values table,
      clean "no metrics exposed" empty state). vigil exposes its OWN `/metrics`
      (Prometheus text, public + secret-free) with real counters/gauges — probes run,
      poll cycles, checks passed/failed, alerts fired, targets up/down/degraded,
      poll-cycle duration, fleet availability — and its self-target scrapes it through
      the identical parse+store path.
- [x] **Code-quality (#7).** `quality` table + `POST /api/ingest/quality` (CI-pushed,
      token/loopback-gated). **vigil derives the letter grade** from the raw numbers
      in `quality.py` (failing tests dominate, lint penalised + capped, low coverage
      nudges down) — the caller cannot set its own grade. Registered viewer
      `GET /api/targets/{slug}/quality` (latest + trend) + a Code-quality panel.

### P1 — per-push + security completeness
- [x] **Per-push pipeline (#8, #16).** `POST /api/hooks/github` — a GitHub webhook
      receiver verifying `X-Hub-Signature-256` (HMAC-SHA256) against
      `config.GITHUB_WEBHOOK_SECRET` (**secure by default**: rejects when unset). On a
      `push` it maps changed `projects/<slug>/` paths to targets (`webhook.py`),
      records a `pushes` row per commit, and runs the live security scan keyed to the
      commit (`GET /api/targets/{slug}/pushes` + a Pushes panel = per-push history).
      The reference workflow `.github/workflows/vigil-report.yml` posts ruff/pytest/
      coverage + a secret scan per changed project (dormant until `VIGIL_URL` +
      `VIGIL_INGEST_TOKEN` repo secrets exist). Dependency-CVE still out of scope.
- [x] **Real repo scanning (#13).** `secretscan.py` — a real regex ruleset
      (`scan_text`/`scan_paths`) over local source (in-repo) or CI-pushed results;
      folded into the posture report mapped to `CC6.3`. (Dependency-CVE/SAST deferred.)
- [x] **CSV export (#15).** `GET /api/security/export.csv` + per-target variant
      (elevated-gated, stdlib `csv`, attachment) of findings + failing controls per
      framework.
- [x] **Run vigil's own tests as a surfaced check (#29).** The reference CI workflow
      posts vigil's own ruff+pytest+coverage to `/api/ingest/quality` under slug
      `vigil`, so the self-target shows a code-quality grade; its own repo secret scan
      also runs over the vigil tree.

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
