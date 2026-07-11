# flotilla — Data Model

**TL;DR:** The dashboard keeps *all of its own state* in **MongoDB** — deliberately decoupled from the Convex/Vercel/Clerk instances it manages, so it never depends on a deployment it might itself refresh (`lib/mongo.ts:4`). State lives in ~25 `flotilla_`-prefixed collections across **two clusters**: the shared **primary** cluster (`MONGODB_URI`) holds instances, jobs, config, RBAC, backups metadata, audit, and the whole monitoring set; a **dedicated metrics** cluster (`FLOTILLA_METRICS_MONGODB_URI`) isolates the high-volume observability time-series so it can't fill the shared 512 MB cap and block writes (`lib/mongo.ts:34`). Every document is clean JSON — reads project out Mongo's `_id` (`lib/models/base.ts:11`), ids are app-generated `prefix_…` strings (`lib/models/base.ts:23`), and idempotency is enforced at the persistence layer via `upsertByKey` (`lib/models/base.ts:48`). **Large blobs (backup snapshot ZIPs, 60–180 MB) do NOT live in Mongo** — they are pushed to **GitHub Releases**, with only the metadata + asset ref stored here (`lib/models/backups.ts:6`). The only self-expiring data is the metrics time-series and the monitoring alert log, both carrying TTL indexes.

**Status legend:** ✅ shipped · ◐ partial · 🔭 flag-gated / planned (default off) · ⚠️ caveat

## Table of Contents

- [Collections overview](#collections-overview)
- [Per-collection detail](#per-collection-detail)
  - [instances](#instances--flotilla_instances)
  - [jobs (+ dead-letter queue)](#jobs--flotilla_jobs--flotilla_jobs_dead)
  - [config](#config--flotilla_config)
  - [dashboard users](#dashboard-users--flotilla_dashboard_users)
  - [metrics](#metrics--flotilla_metrics-dedicated-cluster)
  - [monitoring set](#monitoring-set)
  - [supporting collections](#supporting-collections)
- [Relationships](#relationships)
- [Instance lifecycle](#instance-lifecycle)
- [Retention & TTL](#retention--ttl)
- [Related](#related)

## Collections overview

Canonical names are declared once in the `COLLECTIONS` map (`lib/mongo.ts:72`); every model reaches them through `col(name)` (`lib/models/base.ts:12`). All live on the **primary** cluster unless flagged ⚠️ *metrics cluster*.

| Collection | Purpose | Key fields | Owning module |
|---|---|---|---|
| `flotilla_instances` | A managed preview/staging instance (branch × data clone across Vercel + Convex + Clerk) | `id`, `idempotencyKey`, `kind`, `status`, `health`, `expiresAt`, `currentJobId`, `ownerEmail`, `team` | `lib/models/instances.ts:56` |
| `flotilla_jobs` | Async orchestration queue (provision/update/refresh/teardown/test/fix-loop) | `id`, `idempotencyKey`, `type`, `status`, `instanceId`, `attempts`, `lockRenewedAt` | `lib/models/jobs.ts:57` |
| `flotilla_jobs_dead` | Dead-letter queue: jobs past max retries, out of the live queue | `…JobDoc`, `deadAt`, `deadReason` | `lib/models/jobs.ts:90` |
| `flotilla_config` | Operator-editable defaults + feature flags (one singleton doc) | `id="singleton"`, editable keys, `features`, `featureSchedules` | `lib/models/config.ts:220` |
| `flotilla_config_history` | Append-only per-key diff of config/flag overrides (flag/rollout UX) | `id`, `seq`, `ts`, `actor`, `reason?`, `entries[{key,before,after,schedule?}]` | `lib/models/config.ts` (`recordConfigHistory`) |
| `flotilla_dashboard_users` | RBAC store — the dashboard's own operators + roles | `id`, `email` (natural key), `role`, `disabled` | `lib/models/dashboardUsers.ts:17` |
| `flotilla_metrics` ⚠️ *metrics cluster* | Observability time-series: one doc per (provider,metric,labels,minute) | `bucketKey` (unique), `metric`, `value`, `ts`, `expireAt` (TTL) | `lib/observability/store.ts:44` |
| `flotilla_backups` | Snapshot **metadata** (blobs live in GitHub Releases / legacy GridFS) | `id`, `deployment`, `ref`, `storeKind`, `blobRef`, `snapshotId` | `lib/models/backups.ts:14` |
| `flotilla_templates` | Reusable launch presets (branch + backup + Clerk + env) | `id`, `name`, `branch`, `backupRef` | `lib/models/templates.ts:17` |
| `flotilla_clerkConfigs` | Per-instance Clerk config + drift read; reusable Clerk templates | `id`, `instanceId`, `clerkInstance`, `driftKeys` | `lib/models/clerkConfigs.ts:16` |
| `flotilla_managedUsers` | Per-instance Clerk **test** users (distinct from dashboard users) | `id`, `instanceId`, `email`, `status` | `lib/models/managedUsers.ts:15` |
| `flotilla_logs` | Append-only orchestration log stream (per job/instance) | `seq`, `ts`, `source`, `level`, `msg`, `jobId` | `lib/models/logs.ts:18` |
| `flotilla_audit` | Append-only security audit trail | `id`, `seq`, `ts`, `actor`, `action`, `target` | `lib/models/audit.ts:9` |
| `flotilla_testruns` | Test-suite runs (smoke/regression/security/self) + per-check results | `id`, `kind`, `status`, `checks`, `jobId` | `lib/models/testruns.ts:29` |
| `flotilla_fixloops` | AI validated-fix loop runs (propose→apply→verify attempts) | `id`, `instanceId`, `jobId`, `status`, `attempts`, `winningPlan` | `lib/models/fixloops.ts:15` |
| `flotilla_gate_verdicts` | AI smoke-gate verdict cache — memoized per terminal run version | `runId`, `version`, `outcome`, `at` | `lib/models/gateVerdicts.ts:9` |
| `flotilla_share_links` | One-click reviewer sign-in links (Clerk tickets) | `id`, `instanceId`, `email`, `url`, `expiresAt`, `revoked` | `lib/models/shareLinks.ts:7` |
| `flotilla_backup_files` | GridFS bucket for **legacy** backup ZIP blobs ⚠️ | GridFS chunks/files | `lib/mongo.ts:126` |
| `flotilla_monitors` | Monitor binding (target selector × check × params × schedule) | `id`, `checkType`, `target`, `intervalSec`, `notify` | `lib/models/monitoring/types.ts:133` |
| `flotilla_monitor_state` | Per (monitor,target) **current** state — the soft→hard machine's memory | `id`, `monitorId`, `targetId`, `status`, `softCount`, `since` | `lib/models/monitoring/types.ts:155` |
| `flotilla_monitor_alerts` | Append-only alert dispatch log (TTL) | `id`, `monitorId`, `kind`, `channel`, `state`, `expireAt` (TTL) | `lib/models/monitoring/types.ts:173` |
| `flotilla_monitor_recipients` | Phase-1 email digest contacts | `id`, `email`, `enabled` | `lib/models/monitoring/types.ts:190` |
| `flotilla_monitor_silences` | Silence / opt-out scopes (all / monitor / target) | `id`, `all`, `monitorId`, `targetId`, `until` | `lib/models/monitoring/types.ts:202` |
| `flotilla_monitor_contacts` | Phase-2 reusable escalation endpoints (slack/email) | `id`, `name`, `channels` | `lib/models/monitoring/contacts.ts:28` |
| `flotilla_monitor_contact_groups` | Named sets of contacts (tier fan-out) | `id`, `name`, `contactIds` | `lib/models/monitoring/contacts.ts:37` |
| `flotilla_monitor_policies` | Escalation policies (ordered tiers) | `id`, `name`, `tiers` | `lib/models/monitoring/policies.ts:27` |
| `flotilla_monitor_incidents` | Open hard-CRIT incidents + escalation cursor + ack | `id`, `monitorId`, `status`, `tier`, `ackBy` | `lib/models/monitoring/incidents.ts:15` |
| `flotilla_monitor_groups` | Phase-5 named sets of monitors (ids or selector) | `id`, `name`, `membership` | `lib/models/monitoring/groups.ts:52` |
| `flotilla_monitor_timeperiods` | Phase-5 weekly notification windows (gates NOTIFY) | `id`, `name`, `tz`, `windows` | `lib/models/monitoring/timeperiods.ts:41` |

Plus `flotilla_metrics_state` — a tiny singleton on the metrics cluster holding the deep-backfill marker (`{ _id: "backfill", lastBackfillAt }`); a local const, deliberately **not** a `COLLECTIONS` entry, so it stays inside the observability module (`lib/observability/store.ts:127`).

## Per-collection detail

### instances — `flotilla_instances`

The core of the model: one row per managed preview/staging instance. Two provisioning shapes: **FRESH** (the tool provisions a brand-new isolated Convex deployment + Vercel deployment, then loads a chosen snapshot into it; `createdByTool = true`) and **EXISTING** (the operator targets a pre-existing deployment to refresh — danger-flagged, preflight-gated; production is a hard write-block) (`lib/models/instances.ts:11`).

| Field | Type | Notes |
|---|---|---|
| `id` | `string` | `inst_…` app id (`lib/models/instances.ts:139`) |
| `idempotencyKey` | `string` | Unique. Default derives from `kind:branch:dataRef:deployment` so a double-submit converges (`lib/models/instances.ts:133`) |
| `name`, `kind`, `branch` | | `kind ∈ {preview, staging}`; `staging` defaults to a unique `staging-<rand>` name (`lib/models/instances.ts:137`) |
| `backupSnapshotId`, `backupDeployment` | `string?` | Read-only DATA SOURCE (a Convex cloud snapshot) — `backupDeployment` is never written (`lib/models/instances.ts:39`) |
| `convexDeployment` | `string?` | Resolved WRITE target; omitted/"fresh" ⇒ provision a new one (`lib/models/instances.ts:41`) |
| `clerkInstance`, `vercelProject`, `url` | `string?` | Bound resources + the live URL |
| `status` | enum | `pending → provisioning → ready / failed / archived` (`lib/models/instances.ts:18`) |
| `health` | enum | `unknown / provisioning / healthy / degraded / down` (`lib/models/instances.ts:19`) |
| `migrations`, `scrubPII`, `masked` | `boolean` | `masked` = PII masking was applied to the imported snapshot (`lib/models/instances.ts:76`) |
| `ttlHours`, `expiresAt` | `number?` | Only set when a TTL was requested — **no default expiry** (`lib/models/instances.ts:78`) |
| `owner`, `lastRefreshedAt`, `currentJobId` | | Legacy free-text attribution + the in-flight job pointer |
| `ownerUserId`, `ownerEmail`, `ownerName`, `team` | `string?` | **Ownership registry** — first-class owner/team, all optional (legacy rows carry none and stay valid). Stamped on create from the resolved principal unless the request body supplies an explicit owner (on-behalf-of); `ownerEmail`/`team` carry sparse secondary indexes and back the `?owner=`/`?team=` filters; reassignable via write-gated, audited `updateInstanceOwner` (`lib/models/instances.ts` `updateInstanceOwner`) |
| `createdByTool`, `createdConvexDeployment`, `createdConvexUrl`, `vercelDeploymentId`, `lastImportedSnapshotId` | | Provenance / safety metadata + import idempotency marker (`lib/models/instances.ts:82`) |
| `createdAt`, `updatedAt` | `number` | epoch ms |

**Notes.** `createInstance` upserts on `idempotencyKey` so a re-submit returns the same row (`lib/models/instances.ts:119`). Teardown fans out to drop the instance's Clerk config + managed-user rows via `deleteInstanceClerkRecords` (`lib/models/instances.ts:169`).

### jobs (+ dead-letter queue) — `flotilla_jobs` / `flotilla_jobs_dead`

Every long-running action is an **async** job: the API only *enqueues* a `queued` row and returns its id; the standalone worker (`scripts/worker.ts`) claims and runs it, streaming logs to `flotilla_logs` (`lib/models/jobs.ts:7`). This keeps provisions off the serverless request path.

| Field | Type | Notes |
|---|---|---|
| `id`, `idempotencyKey` | `string` | Enqueue converges on the key — a re-submit returns the existing row (`lib/models/jobs.ts:105`) |
| `type` | enum | `provision / update / refresh / teardown / test / fix-loop` (`lib/models/jobs.ts:14`) |
| `status` | enum | `queued / running / succeeded / failed / rolled_back` (`lib/models/jobs.ts:15`) |
| `instanceId` | `string?` | The instance this job acts on |
| `opts` | `JobOpts` | Validated run inputs: branch, data source, target dimensions (`code`/`data`/`clerk`), `dangerAck` (`lib/models/jobs.ts:25`) |
| `steps`, `result`, `error`, `engine` | | Execution trace + `"real"`/`"stub"` engine marker |
| `enqueuedAt`, `firstAttemptAt`, `startedAt`, `finishedAt` | `number?` | Latency instrumentation |
| `attempts` | `number?` | Incremented per claim; drives the max-attempts → DLQ decision (`lib/models/jobs.ts:87`) |
| `lockRenewedAt` | `number?` | Heartbeat. A `running` job whose heartbeat is older than `DEFAULT_LOCK_TIMEOUT_MS` (2 min) is presumed crashed and reclaimed (`lib/models/jobs.ts:90`) |

**Notes.** `claimJob` is an atomic `queued → running` flip guarded on status, so two racing workers can't double-run one row (`lib/models/jobs.ts:138`). The stalled-job sweeper (`reclaimStalledJobs`) either **reclaims** a stale-locked job back to `queued` or, once `attempts >= DEFAULT_MAX_ATTEMPTS` (3), **dead-letters** it into `flotilla_jobs_dead` — every transition an atomic conditional update guarded on the still-stale lock so a just-renewed worker wins the race (`lib/models/jobs.ts:259`). `DeadJobDoc` is the full job snapshot + `deadAt`/`deadReason`; `requeueDeadJob` revives it into the live queue reusing the original id + key (`lib/models/jobs.ts:314`). RED-ish queue metrics (`computeJobTypeMetrics`, `queueHealthSnapshot`) are computed straight from this collection — no external SaaS (`lib/models/jobs.ts:348`).

### config — `flotilla_config`

A **single** singleton doc (`id="singleton"`) — the operator-editable defaults + feature-flag store (`lib/models/config.ts:22`, doc shape `:220`). Read model: every field resolves `stored ?? env ?? hardcoded default`, tagged with an `overriddenBy` provenance marker (`lib/models/config.ts:372`). Write model: a zod `.strict()` patch that upserts **only** editable keys — any read-only/secret key is rejected (`lib/models/config.ts:100`).

- **Editable fields** — provisioning defaults (`maskByDefault`, `migrationsByDefault`, `defaultTtlHours`), backups (`autoIngestEnabled`, `snapshotRepo`), `defaultTestKind`, cost rate, `notifyWebhookUrl`, appearance, and Ask-AI provider/model (`lib/models/config.ts:45`).
- **`features`** — a sub-object of boolean flags resolved with the same provenance machinery; reliability nets default ON, anything genuinely new defaults OFF (`lib/models/config.ts:114`).
- **`featureSchedules`** (flag/rollout UX) — an OPTIONAL, additive sub-object keyed by flag name; each entry is `{ value, activateAt?, expiresAt? }` (epoch-ms bounds). A stored override applies **only inside the half-open window `[activateAt, expiresAt)`**; outside it (not yet active, or expired) resolution treats the override as **absent** and falls through to env/default (`scheduleActiveAt` / `getConfig`). A schedule entry **supersedes** the plain `features[key]` boolean for that flag. ✅ Back-compat: a plain boolean with no schedule entry is *always* in-window ⇒ behaves exactly as before. Expired windows are **lazy-pruned on read** (`pruneExpiredSchedules`, no cron). **Stale** (an ON override older than `FLOTILLA_FLAG_STALE_AFTER_DAYS`, default 30) + **redundant** (matches the env/default it overrides) hints are derived server-side (`detectStaleFlags`).
- **`flotilla_config_history`** — every config/flag write appends one `ConfigHistoryDoc` (a batch of per-key `{key, before, after, schedule?}` entries + `actor`/`reason?`), read back most-recent-first for the Config "Recent changes" view (`listConfigHistory`). Secret masking is preserved (`notifyWebhookUrl` is masked before it lands in history, same as the read path).
- ⚠️ **Never holds secrets.** The prod/shared write-guards live in their own modules and are surfaced here read-only — a flag can never relax a security remediation (`lib/models/config.ts:16`). The one exception, `notifyWebhookUrl` (a bearer token in a URL), is masked to host-only on read via `maskWebhookUrl` (`lib/models/config.ts:270`). Reads are resilient — a store failure degrades to env/default, never throws (`lib/models/config.ts:332`).

### dashboard users — `flotilla_dashboard_users`

The RBAC store: one row per **non-immutable** dashboard operator (`lib/models/dashboardUsers.ts:11`). Fields: `id`, `email` (normalized/lowercased — the natural key with a unique index), `role`, `invitedBy`, `disabled`, timestamps (`lib/models/dashboardUsers.ts:17`). ⚠️ The `IMMUTABLE_SUPERADMINS` are a **code constant** (`lib/rbac.ts`), NOT rows — resolution always overrides to super-admin for them and every mutation rejects them, so they can't be demoted or removed even if a stale row exists. `disabled` keeps the row but denies access. Distinct from `flotilla_managedUsers` (per-instance Clerk *test* users). **Guests** (unauthenticated demo visitors) never appear here — they resolve below `read-only` at request time and have no stored row.

### metrics — `flotilla_metrics` (dedicated cluster)

The Mongo-backed time-series behind the Observability tab — this **replaced Axiom** (whose dataset-creation API 500s server-side) (`lib/observability/store.ts:1`). One `MetricDoc` per (provider, metric, labels, minute-bucket).

| Field | Type | Notes |
|---|---|---|
| `bucketKey` | `string` | **Unique** idempotency key `(provider,metric,labelsKey,minuteBucket)` — re-polling a 60s window converges to one row, no double-count (`lib/observability/store.ts:45`) |
| `metric`, `value`, `unit`, `type` | | Dotted `provider.subject.measure_unit` name; `type ∈ gauge/counter/rate` |
| `provider`, `source`, `labelsKey`, `instanceId?`, `env?`, `resource?` | | Labels **hoisted to columns** for cheap `$match`/`$group` (`lib/observability/store.ts:54`) |
| `ts`, `bucketTs` | `number` | epoch ms, floored to the 1-min storage bucket — the query aggregation does integer bucket math on these |
| `expireAt` | `Date` | Date mirror of `ts`; the TTL index fires on this (Mongo TTL only works on a Date field) (`lib/observability/store.ts:57`) |

**Notes.** Ingest is an unordered bulk upsert in chunks of 1000, keyed on `bucketKey` (`lib/observability/store.ts:203`). A per-metric cardinality ceiling (`MAX_SERIES_PER_METRIC = 500`) drops-and-logs new series so a cardinality bomb can't explode the store (`lib/observability/metricPoint.ts:59`). Every method **degrades cleanly** — a store failure returns a degraded result, never throws, so the tab shows an honest empty state (`lib/observability/store.ts:19`). The whole subsystem is gated behind the `observability` feature flag (`lib/models/config.ts:142`).

### monitoring set

The monitoring subsystem — all small + low-churn, so deliberately on the **primary** cluster, not the metrics cluster (`lib/mongo.ts:104`). Phase 1 is cron-first + light checks, so there is **deliberately no** high-volume per-run check-results/history collection — only the *current* per-target state + a TTL'd alert log (`lib/mongo.ts:103`). Gated behind the `monitoring` flag (`lib/models/config.ts:155`).

- **`flotilla_monitors`** — the binding: `checkType ∈ {metric_threshold, http_reachability, instance_status}` (a CLOSED registry — new *kinds* are reviewed code, never runtime uploads), a `target` selector, `params` (validated against the check-type schema on create and before every run), `intervalSec`, `retries`, and a `notify` block (`lib/models/monitoring/types.ts:133`).
- **`flotilla_monitor_state`** — one row per (monitor, target), the soft→hard state machine's memory: `status` (committed HARD state), `softCount` (pending candidate), `lastStatus` (last raw result), `since`. Deterministic composite id (`mst_<monitor>_<target>`) so upserts converge on one row — the only "high-ish" churn monitoring collection, but current-state-only so it stays bounded (`lib/models/monitoring/state.ts:4`).
- **`flotilla_monitor_alerts`** — append-only, one row per channel per dispatch attempt *including failed sends* (`ok:false` + `reason`), TTL-reaped (`lib/models/monitoring/alerts.ts:4`).
- **Phase-2 escalation** — `flotilla_monitor_contacts` / `_contact_groups` (reusable endpoints, secrets masked on read), `flotilla_monitor_policies` (ordered tiers), `flotilla_monitor_incidents` (open hard-CRIT with an escalation cursor `tier`/`tierNotifiedAt` + ack fields; deterministic composite id like the state doc) (`lib/models/monitoring/incidents.ts:15`).
- **Phase-5** — `flotilla_monitor_groups` (named monitor sets) + `flotilla_monitor_timeperiods` (weekly windows that gate NOTIFY, not checks).
- **`flotilla_monitor_recipients`** / **`flotilla_monitor_silences`** — Phase-1 email digest list + silence scopes (`all` / per-monitor / per-target; `until=0` ⇒ open-ended).

### supporting collections

- **`flotilla_backups`** — snapshot metadata only. `storeKind:"gh"` + `blobRef` (a GitHub Release asset id) is the current path; `storeKind:"gridfs"` + `gridfsId` is legacy. `snapshotId`/`cloudBackupId` link a stored blob to its Convex cloud backup; `status ∈ {stored, importing, ingesting}` (`lib/models/backups.ts:12`).
- **`flotilla_logs`** — append-only orchestration stream; `seq` is a monotonic per-process counter so events sharing a `ts` stay ordered; queried newest-first, capped at 2000 (`lib/models/logs.ts:18`).
- **`flotilla_audit`** — append-only security trail (`actor`, `action`, `target`, `detail`); best-effort writes — a failed audit write never breaks the mutation it describes (`lib/models/audit.ts:22`).
- **`flotilla_share_links`** — reviewer one-click Clerk sign-in tickets with `expiresAt` + revocation fields.
- **`flotilla_testruns`** / **`flotilla_fixloops`** — test-suite runs (per-check results) and AI fix-loop audit records; each carries the `jobId` of the worker job executing it.
- **`flotilla_gate_verdicts`** — memoized AI smoke-gate verdicts (one per terminal run version), so the billable verdict computes at most once per run.
- **`flotilla_templates`** / **`flotilla_clerkConfigs`** / **`flotilla_managedUsers`** — launch presets, per-instance Clerk config + drift, and per-instance Clerk test users.

## Relationships

```
                          flotilla_config (singleton) ── defaults + feature flags gate everything
                                    │
   flotilla_templates ──"launch as"──► │
   flotilla_backups (metadata) ──data source──┐
        │  blobRef                          │
        ▼                                   ▼
  GitHub Releases                    ┌──────────────┐  currentJobId   ┌──────────────┐
  (blobs, NOT Mongo)                 │ flotilla_        │◄───────────────►│ flotilla_jobs   │
        ▲  legacy                    │ instances    │  instanceId     │ (queue)      │
        │                            └──────┬───────┘                 └──────┬───────┘
  flotilla_backup_files (GridFS)               │                                │ streams
                                            │ instanceId              stalled │ + attempts
        ┌───────────────────────────────────┼──────────────┐                ▼
        ▼                  ▼                 ▼              ▼          flotilla_jobs_dead (DLQ)
 flotilla_clerkConfigs  flotilla_managedUsers  flotilla_testruns  flotilla_fixloops       │
 flotilla_share_links   (Clerk test users)  flotilla_logs ◄── (worker job logs) ────┘

   ── Observability (DEDICATED metrics cluster) ─────────────────────────────
   pollers ──MetricPoint──► flotilla_metrics  (labels.instanceId ⤳ instances)   + flotilla_metrics_state
                                    ▲ TTL(expireAt)

   ── Monitoring set (primary cluster; monitoring flag) ─────────────────────
   flotilla_monitors ──eval──► flotilla_monitor_state ──transition──► flotilla_monitor_alerts (TTL)
        │  target selector (instance / type / service / url / all → instances)      │
        └─► notify: flotilla_monitor_{recipients,silences,contacts,contact_groups,
                                    policies,incidents,groups,timeperiods}
```

Key edges: an **instance** points to its in-flight **job** via `currentJobId`, and a job points back via `instanceId` — a job that stalls is reclaimed or moved to the DLQ. A **backup** row references a blob in **GitHub Releases** (or legacy GridFS), never storing bytes in the doc. **Metrics** and **monitors** reference instances only *by label/selector value* (`instanceId`, `instance:<id>`), not a Mongo foreign key — they live on / target the fleet loosely so a dropped instance never dangles a hard reference.

## Instance lifecycle

`status` and `health` are separate axes: `status` is the provisioning state machine, `health` is the observed runtime signal. Enums: `status ∈ {pending, provisioning, ready, failed, archived}` (`lib/models/instances.ts:18`), `health ∈ {unknown, provisioning, healthy, degraded, down}` (`lib/models/instances.ts:19`). Transitions are stamped by the orchestrator in `lib/jobs.ts`:

```
  createInstance
      │  status=pending, health=unknown           (lib/models/instances.ts:143)
      ▼
  provision/refresh/update job claimed
      │  status=provisioning, health=provisioning  (lib/jobs.ts:142)
      ▼
   ┌──────────────┬───────────────────────────┐
   │ success      │ failure / rolled_back      │
   ▼              ▼                            
  status=ready    status=failed, health=down   (lib/jobs.ts:663)
  health=healthy  (job: failed | rolled_back,   (lib/jobs.ts:627)
  (unknown if       lib/jobs.ts:656)
   dryRun)
      │
      │  teardown job (manual or TTL sweep)
      ▼
  status=archived, health=down, currentJobId cleared   (lib/jobs.ts:703)
      └─ teardown reported failure ⇒ health=degraded    (lib/jobs.ts:716)
```

The **TTL expiry sweep** runs each worker poll: `listExpiredInstances` returns tool-created, still-`ready` instances whose `expiresAt` has elapsed (`pending`/`provisioning`/`archived` rows are skipped so it never races an in-flight job) (`lib/models/instances.ts:160`); the worker enqueues a teardown per warn-before-destroy (`scripts/worker.ts:206`).

## Retention & TTL

| Data | Retention mechanism | Default | Citation |
|---|---|---|---|
| `flotilla_metrics` samples | Mongo TTL index on `expireAt` (Date mirror of `ts`) | `FLOTILLA_METRICS_TTL_DAYS` = **30d** (clamped >0) | `lib/observability/store.ts:155`, `:133` |
| `flotilla_monitor_alerts` | TTL index on `expireAt` (`expireAfterSeconds:0`; per-row future date) | `FLOTILLA_MONITOR_ALERT_TTL_DAYS` = **90d** | `lib/models/monitoring/alerts.ts:20`, `:11` |
| `flotilla_jobs` (bounded) | Not TTL'd — reads cap at 2000 rows; DLQ is manual requeue/inspect | — | `lib/models/jobs.ts:455` |
| `flotilla_logs` (bounded) | Not TTL'd — reads cap at 2000, default 500 newest | — | `lib/models/logs.ts:61` |
| `flotilla_instances` | Not TTL'd — `archived` via teardown; optional per-instance `expiresAt` drives the sweep (not a DB TTL) | no default expiry | `lib/models/instances.ts:78` |

⚠️ Only **metrics** and **monitor alerts** self-expire via Mongo TTL indexes. `flotilla_audit`, `flotilla_logs`, `flotilla_jobs`, and instance/monitoring config rows are **never auto-reaped** — audit and logs are append-only by design, and the live-queue/config collections are cleaned by their own lifecycle (DLQ requeue, teardown), not expiry.

**Not in Mongo (and why):**

- **Backup snapshot ZIPs (60–180 MB)** → **GitHub Releases** (`storeKind:"gh"`, `blobRef` = asset id). They were filling the shared 512 MB cap, so only metadata lives in `flotilla_backups`; legacy blobs remain in the `flotilla_backup_files` GridFS bucket for reads/deletes only (`lib/models/backups.ts:6`).
- **High-volume metrics** → a **separate cluster** (`FLOTILLA_METRICS_MONGODB_URI`), isolated from the shared cluster that once filled and blocked all writes (`lib/mongo.ts:34`).
- **Secrets / API tokens** → **environment variables only**, never persisted. `flotilla_config` overrides behavioural defaults, not credentials (`lib/models/config.ts:16`).
- **The managed instances' own application data** → lives in **their** Convex deployments; the dashboard's Mongo is deliberately decoupled so it never depends on an instance it manages (`lib/mongo.ts:4`).

## Related

- [README.md](./README.md) — documentation index + reading order
- [ARCHITECTURE.md](./ARCHITECTURE.md) — system shape, layers, job lifecycle
- [SECURITY.md](./SECURITY.md) — trust boundaries, RBAC + guest tier, masking
- [CAPABILITY-MAP.md](./CAPABILITY-MAP.md) — capability → code index; entrypoints; feature flags
