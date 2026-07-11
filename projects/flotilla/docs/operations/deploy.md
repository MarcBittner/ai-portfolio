# Runbook: Deploy the dashboard + worker + crons

**TL;DR** — A full deploy is three moving parts, not one: (1) the **Next app**
(`output: "standalone"`, `next.config.ts:6`) on Vercel, (2) the **standalone
worker** (`npm run worker` — a long-lived Node process, *not* serverless), and
(3) **three Vercel crons** (`vercel.json:3-16`) that drive the observability and
monitoring sweeps. Deploy is **env-complete or it silently degrades**: a missing
`CRON_SECRET` 401s every cron, a missing `MONGODB_URI` no-ops the store, and a
missing worker means provisions enqueue but never run. Set the env, run the
pre-deploy gate, ship all three parts.

![Config → Provisioning defaults](../screenshots/ui/config-provisioning.png)

*The in-app Config page — runtime overrides that persist over env defaults.*

## Prerequisites

- **Accounts / access:** a Vercel account on the deploying team with the
  `flotilla` project (`.vercel/project.json`), plus the credentials
  that back every subsystem (MongoDB Atlas, Clerk, Convex mgmt API, GitHub
  snapshot repo — see [Required environment](#required-environment)).
- **Node.js ≥ 20** — the worker's type-stripping path prefers **≥ 22.6**;
  otherwise run it via `tsx` (`README.md:36`).
- **A host for the worker** with a filesystem + the `convex` CLI available.
  Vercel serverless does **not** run it (`scripts/worker.ts` header).
- **Pre-deploy gate — always run both before shipping:**

  ```bash
  npm run verify   # lint + typecheck + vitest — the pre-commit gate (package.json:13)
  npm run build    # next build → .next/standalone/server.js (next.config.ts:6)
  ```

  > `next build` does **not** lint (`eslint.ignoreDuringBuilds: true`,
  > `next.config.ts:9`) — `npm run verify` is the only lint/typecheck gate, so
  > don't skip it.

## Required environment

Grouped by subsystem, citing the `.env.example` section each lives in. **Never
commit real values** — they live in your team's secret manager
(`.env.example:1-2`). A subset is also overridable at runtime from the in-app
**Config** page (persisted values win over env defaults).

| Var | Subsystem / `.env.example` | Required? |
|---|---|---|
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `CLERK_JWT_ISSUER_DOMAIN` | Dashboard auth (`:4-7`) | **Required** for the Clerk gate |
| `BREAKGLASS_EMAIL`, `BREAKGLASS_PASSWORD_HASH` | Break-glass login (`:8-10`) | Recommended (scrypt hash only, never plaintext) |
| `ALLOWED_EMAILS` | Clerk operator allow-list (`:100-102`) | **Required when Clerk is on** — empty/unset denies **all** logins (fail-closed) |
| `MONGODB_URI`, `MONGODB_DB` | Persistence (`:12-14`) | **Required** — queue, config, metrics, monitoring all live here |
| `VERCEL_TOKEN`, `VERCEL_TEAM`, `VERCEL_GIT_REPO_ID` | Platform automation (`:16-18`) | **Worker-side only.** Required on the **worker host** (`.env.local`) for provisioning + Vercel polling. **Cannot** be set as Vercel *project* env vars — Vercel reserves the `VERCEL_` prefix and rejects them — and the deployed app doesn't need them (the worker does the Vercel work). |
| `CONVEX_TEAM_TOKEN`, `CONVEX_ACCESS_TOKEN` | Convex mgmt/big-brain API (`:19-24`) | **Required** — provision, admin keys, backups, data import |
| `CONVEX_TEAM_SLUG`, `CONVEX_TEAM_ID`, `CONVEX_PROJECT_ID` | Convex project resolution (`:25-30`) | **Required (no code default)** |
| `CONVEX_PROJECT_SLUG` | Convex (`:31`) | Optional — resolved from team+project id when unset |
| `FLOTILLA_PROD_CONVEX_DEPLOYMENT` | Managed topology safety gate (`:39-42`) | Optional default, but **set in every real env** so the PRODUCTION hard write/teardown block is active |
| `FLOTILLA_SHARED_DEPLOYMENTS` | Managed topology (`:40-43`) | Optional — `name:role,…`; PRODUCTION/staging-prod force PII masking |
| `GITHUB_TOKEN`, `GITHUB_REPO` | Branch picker (`:45-50`) | Optional for a public branch repo; **required** for the private snapshot store |
| `SNAPSHOT_REPO` | Snapshot blob store (`:51-55`) | **Required for snapshots** (no default) — unset ⇒ store degrades off |
| `CRON_SECRET` | Monitoring & cron (`:200-205`) | **Required** — cron routes 401 fail-closed when unset (`app/api/observability/poll/route.ts:37-40` + both monitoring routes; see [Gotchas](#gotchas)) |
| `ALERT_GMAIL_USER`, `ALERT_GMAIL_APP_PASSWORD`, `ALERT_FROM_NAME` | Monitoring email digests (`:206-211`) | Required for email alerts; unset ⇒ email channel degrades off (`lib/monitoring/email.ts:7-8,17,22`; Gmail App Password, spaces stripped) |
| `FLOTILLA_FEATURE_OBSERVABILITY` | Observability tab (`:131-142`) | Optional flag — **OFF** unless set; store is `MONGODB_URI` (no separate creds) |
| `FLOTILLA_FEATURE_*` (monitoring, AI failure triage, Ask AI, cost estimates) | Feature-flag defaults (`:57-142`) | Optional — every subsystem ships **off** by default |
| `ATLAS_API_*`, `ATLAS_GROUP_ID`, `ATLAS_PROCESS_ID` | Observability Atlas poller (`:163-188`) | Optional — absent creds ⇒ Atlas poller no-ops; rest runs |
| `ANTHROPIC_API_KEY` (+ `ANTHROPIC_TRIAGE_MODEL`) | AI failure triage (`:57-65`) | Optional — no key ⇒ endpoint returns 409 "AI not configured" |
| `OPENAI_API_KEY`, `OLLAMA_URL`, `OPENROUTER_API_KEY`, `FLOTILLA_AI_*` | Ask-AI provider chain (`:69-88`) | Optional — chain degrades to a deterministic (non-AI) tier with no key |
| `AXIOM_TOKEN`, `AXIOM_DATASET`, `AXIOM_ORG_ID` | (`:150-153`) | **No-op / dormant** — the metrics store moved to Mongo; unused unless the Axiom client is revived |
| `FLOTILLA_INLINE_WORKER` | Worker (`:90-94`) | Optional — set `=1` to also run jobs in-process (local/single-process deploy) |
| `AUTO_INGEST_BACKUPS`, `AUTO_INGEST_INTERVAL_MS` | Worker backup ingest (`:104-110`) | Optional — off unless set; interval defaults 1h |
| `FLOTILLA_MASK_BY_DEFAULT`, `FLOTILLA_MIGRATIONS_BY_DEFAULT`, `FLOTILLA_DEFAULT_*` | Config-store defaults (`:112-129`) | Optional — each falls back to a shipped default |

> Cadence/tuning knobs (`FLOTILLA_WORKER_POLL_MS`, `FLOTILLA_METRICS_POLL_MS`,
> `FLOTILLA_METRICS_BACKFILL_INTERVAL_MS`, `FLOTILLA_METRICS_TTL_DAYS`,
> `ATLAS_*_TIERS`) are all optional and default sanely (`.env.example:128-188`).

## Deploy steps

The three parts are independent — but ship **all three** or a subsystem breaks.

```bash
# 1. Pre-deploy gate (from repo root). Both must pass before you deploy.
npm run verify        # lint + typecheck + vitest  (package.json:13)
npm run build         # next build → .next/standalone/server.js  (next.config.ts:6)
```

```bash
# 2. Set the project env on Vercel (once, and on any change). CRON_SECRET is
#    REQUIRED — the cron routes fail closed without it (see Gotchas).
#    Parse .env RAW — do NOT `source` it (see Gotchas). Example, one var:
vercel env add CRON_SECRET production        # paste the secret when prompted
#    ...repeat for every REQUIRED var in the table above, per environment.
#    SKIP the reserved VERCEL_* keys — Vercel rejects them; they are worker-side.
#    Bulk restore from .env.local is fine via the API (POST /v10/projects/<id>/env,
#    upsert=true, skipping VERCEL_*). VERIFY it took: the project env must be
#    NON-EMPTY before you deploy — an empty project env ships a fail-closed app
#    (no DB, all logins denied, crons 401). Check in the dashboard or:
#      GET https://api.vercel.com/v9/projects/<projectId>/env?teamId=<team>
```

```bash
# 3. Deploy the Next app. This also (re)registers the crons from vercel.json.
#    The CLI uploads the working dir — add a .vercelignore FIRST so local
#    secrets/notes never get uploaded (env now comes from the project, not files):
#      printf '.env\n.env.*\n*.pem\ncredentials*.md\ndocs/spec/untracked/\n' > .vercelignore
vercel deploy --prod                          # project: flotilla (.vercel/project.json)
```

```bash
# 4. Run / host the standalone WORKER (a long-lived process, NOT serverless).
#    On the worker host, with .env.local present (Node ≥ 20; ≥ 22.6 for the
#    type-stripping path, else use tsx):
npm run worker                                # package.json:19
#    (equivalently: node --experimental-strip-types --env-file=.env.local scripts/worker.ts)
#    Keep it supervised (systemd / pm2 / container restart=always). Multiple
#    workers are safe — claimJob() guarantees one runner per job.
```

```bash
# 5. Verify the crons registered. In vercel.json they are (all */5 * * * *):
#      /api/observability/poll      (vercel.json:4-7)
#      /api/monitoring/run          (vercel.json:8-11)
#      /api/monitoring/escalate     (vercel.json:12-15)
vercel crons ls                               # confirm all 3 appear for the prod deployment
```

## Verify

Post-deploy checks — confirm all three parts are live:

1. **App loads.** Hit the deployed URL, sign in through Clerk (or break-glass).
   An honest empty state is expected until subsystems are configured
   (`README.md:49`).
2. **Worker is polling.** Enqueue a job (provision / refresh) from the UI and
   watch it move out of `queued`; the worker streams log lines to `flotilla_logs`
   (`scripts/worker.ts` header). No worker ⇒ jobs sit `queued` forever.
3. **Crons registered & authorized.** `vercel crons ls` shows all three at
   `*/5`. A manual authorized probe (cron sends `Authorization: Bearer
   $CRON_SECRET`):

   ```bash
   # Expect 200 + JSON (or {"skipped":"...flag off"} if the flag is off),
   # NOT 401. A 401 means CRON_SECRET is missing/mismatched.
   curl -sS -H "Authorization: Bearer $CRON_SECRET" \
     https://<deployment>/api/observability/poll | head
   ```

4. **Observability / monitoring flags.** These sweeps no-op with a `skipped`
   response until their flags are ON (`FLOTILLA_FEATURE_OBSERVABILITY` /
   `monitoring`, `poll/route.ts:43-46`, `run/route.ts:38-41`) — expected if you
   haven't enabled them in **Config → Features**.

## Rollback

- **App:** roll back to the previous good deployment —
  `vercel rollback <previous-deployment-url>` (or promote the prior deployment
  in the Vercel dashboard). The standalone build is self-contained, so the prior
  deployment needs no rebuild.
- **Worker:** redeploy the prior commit's `scripts/worker.ts` to the worker host
  and restart the process. In-flight jobs are safe — a crashed/replaced worker's
  `running` job is reclaimed after `FLOTILLA_LOCK_TIMEOUT_MS` (`scripts/worker.ts`).
- **Crons:** they live in `vercel.json`, so a rollback that includes that file
  restores the schedules. **Never** ship a `vercel.json` that drops a cron (see
  Gotchas) — reverting the app without it would silently kill a sweep.
- **Env:** `vercel env rm <VAR> <env>` then re-add the prior value; redeploy for
  the change to take effect.

## Gotchas

- **Partial env silently degrades — it doesn't crash.** No `MONGODB_URI` ⇒ the
  observability pipeline no-ops and the tab shows an empty state
  (`.env.example:135-136`); no `SNAPSHOT_REPO` ⇒ the snapshot store degrades off
  (`.env.example:54`); no `ALERT_GMAIL_*` ⇒ email alerts silently don't send
  (`lib/monitoring/email.ts:22-26`). "Works, but does nothing" is the failure
  mode — cross-check the [Required environment](#required-environment) table.
- **`CRON_SECRET` missing ⇒ every cron 401s (fail-closed).** The routes REQUIRE
  it and 401 when it's unset *or* mismatched — cron has no session, so the shared
  secret is the only key (`poll/route.ts:37-40`, `run/route.ts:32-35`,
  `escalate/route.ts:29-32`). A cron that silently 401s = no metrics, no alerts.
- **Parse `.env` RAW, never `source` it.** Values can contain `$`, spaces, and
  special chars (e.g. the Gmail App Password — Gmail *displays* it space-grouped;
  the code strips the spaces, `lib/monitoring/email.ts:17`). `source .env` would
  mangle or shell-expand them. Use `vercel env add` / `--env-file=.env.local`
  (as the worker script does, `package.json:19`), not shell sourcing.
- **Never drop a cron from `vercel.json`.** All three sweeps live only there
  (`vercel.json:3-16`); Vercel re-registers on deploy, so a `vercel.json` that
  omits one *unregisters* that cron with no error. The escalation sweep is also
  folded into `/api/monitoring/run` and is idempotent (per-tier last-notified
  cursor), so running both can't double-page (`lib/monitoring/escalate.ts:6-7`) — but
  dropping the poll cron means the metrics store only ever holds one timestamp
  (`poll/route.ts:29-30`).
- **Empty project env ⇒ a fresh deploy ships broken (fail-closed).** A prior
  READY deployment keeps working on the env captured at *its* build time, so an
  empty project env is invisible until you redeploy — then the new build captures
  nothing: no DB, all logins denied (empty `ALLOWED_EMAILS`), crons 401. **Verify
  the project env is present before deploying** (step 2), don't assume it persisted.
- **Vercel reserves the `VERCEL_` prefix.** You cannot set `VERCEL_TOKEN` /
  `VERCEL_TEAM` / `VERCEL_GIT_REPO_ID` (or any `VERCEL_*`) as project env vars —
  the API/dashboard reject them. That's fine: they're **worker-side** creds (the
  deployed app only enqueues; the worker does the Vercel work with `.env.local`).
  The in-app Vercel metrics poller just no-ops without them.
- **The CLI deploy uploads your working dir — don't leak secrets.** `vercel
  deploy` uploads local files; a gitignored `.env.local` / `docs/spec/untracked/`
  / `credentials*.md` can ride along. Add a `.vercelignore` (`.env*`, `*.pem`,
  `credentials*.md`, `docs/spec/untracked/`) before deploying. Runtime env comes
  from the Vercel project now, so the build never needs the local `.env`.
- **The worker is not serverless.** Vercel deploy ships the app + crons but
  **not** the worker; forgetting step 4 means provisions enqueue and never run.
- **Enabling a flag changes nothing until its UI is used** (`README.md:29-30`) —
  turning on `FLOTILLA_FEATURE_OBSERVABILITY` is safe, but the crons still no-op
  until the `observability` flag is ON in Config.

---

**Related:** [./README.md](./README.md) · [../ARCHITECTURE.md](../ARCHITECTURE.md) · [../SECURITY.md](../SECURITY.md)
