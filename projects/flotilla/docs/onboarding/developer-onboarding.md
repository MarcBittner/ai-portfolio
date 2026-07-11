# Developer onboarding

**TL;DR** — With `.env.local` configured and the dashboard + worker booted
([getting-started.md](./getting-started.md)), this doc is the next step: how to
*work in* the codebase. It covers the one mental model that makes everything else
click (enqueue → worker saga, flags-off-by-default, the non-negotiable safety
guards, and the "trueline" UI conventions), a directory-by-directory repo tour
with a start-here file for each, how to land a change through the `npm run verify`
gate without tripping a security invariant, a day-1 checklist, and where to get
unstuck. It does **not** re-teach setup — that's
[getting-started.md](./getting-started.md). Deep dives live in
[ARCHITECTURE.md](../ARCHITECTURE.md), [CAPABILITY-MAP.md](../CAPABILITY-MAP.md),
and [GLOSSARY.md](../GLOSSARY.md); this doc links them rather than repeating them.

> **Legend:** ✅ shipped · ◐ partial · 🔭 flag-gated (default off) · ⚠️ gotcha.

## Table of contents

- [The mental model](#the-mental-model)
- [Repo tour](#repo-tour)
- [How to make a change](#how-to-make-a-change)
- [Day-1 checklist](#day-1-checklist)
- [Troubleshooting & gotchas](#troubleshooting--gotchas)
- [Where to get help](#where-to-get-help)

## The mental model

Five ideas carry almost everything in this codebase. Skim them here, then read
[ARCHITECTURE.md](../ARCHITECTURE.md) for the full picture.

**1. Route handlers enqueue; the worker executes the saga.** A mutating API
route never provisions inline. It validates, then calls an `enqueue*()` helper
that writes a `queued` job to Mongo and returns `{jobId, instanceId}` immediately
(`app/api/instances/route.ts:47`, `lib/jobs.ts:92`). The standalone Node worker
(`scripts/worker.ts`) polls the queue, atomically claims a job, and runs the
long, all-HTTP provisioning **saga** off the request path — because a provision
streams tens of MB and needs a filesystem for PII masking (`lib/jobs.ts:31`). The
browser tails the live log over SSE. See the full lifecycle diagram in
[ARCHITECTURE.md → Request & job lifecycle](../ARCHITECTURE.md#request--job-lifecycle).

**2. The saga compensates on failure.** Provisioning is a linear sequence of
named steps, each of which may register a **compensating action**; on an
uncorrectable throw the runner unwinds executed steps in reverse (teardown the
preview it created, restore the pre-provision snapshot) so a half-built instance
never lingers (`lib/provision.ts:71`). It's idempotent throughout — a
double-submit or a retried job converges on one instance + one job via an
`idempotencyKey` (`lib/jobs.ts:97`). Glossary: [Saga / compensating
step](../GLOSSARY.md#saga--compensating-step), [Idempotency
marker](../GLOSSARY.md#idempotency-marker-idempotencykey).

**3. Every non-core subsystem is flag-gated, and flags ship off.** Observability,
monitoring, AI assist, cost, drift, and share links each sit behind a feature
flag in the config singleton (`lib/models/config.ts:114`). Reliability/safety
nets (`deadLetterQueue`, `stalledReclaim`, `queuePanel`) default **on**; anything
genuinely new defaults **off**. "Enabling a flag never changes behavior for
anyone until its UI is used" (`README.md:29`). Glossary: [Feature
flag](../GLOSSARY.md#feature-flag).

**4. Safety guards are never behind a flag.** Hard-coded, always-on defenses live
in their own modules: the **production hard block** (`PROD_CONVEX_DEPLOYMENT` can
never be a write/teardown target — *no `dangerAck` overrides it*,
`lib/deployments.ts:48`), **`dangerAck` on any pre-existing deployment**
(`lib/executor.ts:172`), **forced PII masking of prod-sourced data**
(`lib/executor.ts:77`), and **RBAC** on every route (`lib/api.ts:29`). Flipping a
flag off never re-opens one of these. Glossary: [Danger-ack](../GLOSSARY.md#danger-ack-dangerack),
[PII masking](../GLOSSARY.md#pii-masking--scrubpii); full list in
[ARCHITECTURE.md → Deployment-topology safety guards](../ARCHITECTURE.md#deployment-topology-safety-guards).

**5. "Trueline" is the house UI language, and it degrades but never crashes.**
The frontend has no spec doc — it's a dense, operator-first, glass-panel
aesthetic enforced by a shared kit (`app/components/kit.tsx`,
`app/components/nav.tsx`): a horizontal top-nav (never a sidebar), glass tables as
the primary surface, a `⋯`/right-click row menu, and a confirm modal that *every*
mutation routes through. The defining data posture: when a store is unreachable,
reads return `200` with an empty payload + a `reason` and the UI shows an honest
"connecting…" state instead of erroring (`lib/api.ts:19`, `lib/api.ts:62`). To
stay consistent, **copy an existing tab** rather than inventing. Full catalog:
[GLOSSARY.md → Trueline design-language
conventions](../GLOSSARY.md#trueline-design-language-conventions).

## Repo tour

Where things live and the one file to open first in each. Every `path` below
maps to the current working tree.

| Directory | What's in it | Start here |
|---|---|---|
| `app/` | Next.js App Router root — global layout, providers, the pre-paint theme bootstrap, `globals.css` design tokens, `/breakglass` + `/sign-in` shells | `app/layout.tsx` |
| `app/api/` | Route handlers (`runtime="nodejs"`, `force-dynamic`); mutating routes only **enqueue**. One folder per subsystem (`instances`, `backups`, `monitoring`, `observability`, `access`, …) | `app/api/instances/route.ts` |
| `app/app/` | The authed dashboard shell — one folder per tab (`instances`, `queue`, `config`, `monitoring`, `observability`, `access`, `logs`, …) | `app/app/page.tsx` |
| `app/components/` | The shared "trueline" UI kit — glass tables, pills, hovercards, confirm modal (`kit.tsx`), top-nav + theme menu (`nav.tsx`), the `AskAI` widget | `app/components/kit.tsx` |
| `lib/` | Domain logic shared by routes **and** the worker — jobs queue, the two provision engines, RBAC, auth, masking, deployment guards, notify, drift, cost | `lib/jobs.ts`, `lib/executor.ts` |
| `lib/clients/` | Thin SDK-free `fetch` wrappers for every external control plane — Vercel, Convex (mgmt + deploy + backups), Clerk, GitHub, the snapshot store, Anthropic. ⚠️ `axiom.ts` is dormant | `lib/clients/vercel.ts` |
| `lib/models/` | Mongo data-access layer, one module per collection; every read/write goes through here (`instances`, `jobs`, `config`, `audit`, `dashboardUsers`, …). Schemas are Zod | `lib/models/index.ts` |
| `lib/observability/` | 🔭 Metrics pipeline (flag `observability`) — collector, per-source pollers, Mongo TTL store, chart query/align | `lib/observability/collect.ts` |
| `lib/monitoring/` | 🔭 Nagios-style alerting (flag `monitoring`) — scheduler, check registry, soft→hard state machine, escalation, digests | `lib/monitoring/scheduler.ts` |
| `scripts/` | The standalone worker (`worker.ts`) + one-off CLI entrypoints (`provision`, `refresh-staging`, `auto-refresh`, `sync-backups`, `metrics-poll`) | `scripts/worker.ts` |
| `__tests__/` | Vitest unit tests (51 files) with an in-memory Mongo fake — no Atlas needed | `__tests__/helpers/fakeMongo.ts` |
| `docs/` | This documentation tree — architecture, capability map, glossary, data model, API reference, operations runbooks, security | `docs/README.md` |

## How to make a change

**Find the code first.** [CAPABILITY-MAP.md](../CAPABILITY-MAP.md) is a
capability → `path:Lnnn` index: locate your feature in the table of contents and
jump straight to the entrypoint. The [entry-point
index](../CAPABILITY-MAP.md#entry-point-index) lists every API route (with its
required role and flag) and every worker/CLI command. To trace a **route →
handler**, note that routes are file-system-mapped: `app/api/<x>/route.ts`
exports `GET`/`POST`/`PATCH`/`DELETE`, each wrapped in `withOperator` and, for
mutations, delegating to a `lib/` function.

**Respect the invariants** (these are the security floor — cross-tenant / prod
leaks are silent, so treat them as non-optional):

| Invariant | What it means | Cite |
|---|---|---|
| Gate every route | Wrap handlers in `withOperator(fn, minRole)`; reads default `read-only`, mutations pass `"write"` (or `admin`/`super-admin` for role mgmt). Never hand-roll the auth check | `lib/api.ts:29` |
| Enqueue, don't provision | Mutating routes call an `enqueue*()` helper and return `{jobId}` — never run the saga inline | `lib/jobs.ts:92` |
| Never bypass a safety guard | Prod is a hard block (`lib/deployments.ts:48`); pre-existing deployments need `dangerAck` (`lib/executor.ts:172`); prod-sourced data forces masking (`lib/executor.ts:77`). Don't add a flag or arg that sidesteps these | `lib/deployments.ts:6` |
| Flags default to today's behavior | New subsystem → add a flag in `FeatureFlags` that ships **off**; reliability nets are the only defaults-on | `lib/models/config.ts:114` |
| Reads degrade, never crash | Wrap store reads in `safeRead()` so a missing dependency returns an empty payload + `reason`, not a 500 | `lib/api.ts:62` |
| Never leak internals | Server errors are logged server-side but the client sees a generic message — no DB URIs, no stack, no secrets | `lib/api.ts:52` |
| Copy a tab for UI | Extend the `kit.tsx` primitives (glass `Table`, `Pill`, `useConfirm`); don't build a bespoke table | `app/components/kit.tsx:32` |

**Test conventions** (`__tests__/`, Vitest):

- Tests run in the `node` environment against an **in-memory Mongo fake**
  (`__tests__/helpers/fakeMongo.ts`) — no Atlas cluster required
  (`vitest.config.ts`). Mock `@/lib/mongo` to return `fakeDb` and mock
  `@/lib/auth`'s `getPrincipal` to drive a chosen role (see
  `__tests__/rbacApi.test.ts` for the canonical pattern).
- Name files `<subject>.test.ts` next to their peers; the glob is
  `__tests__/**/*.test.ts`.
- ⚠️ **Masking tests are slow** — deterministic Copycat over a full export dir
  runs 20–30 s, which is why `testTimeout` is bumped to 60 s
  (`vitest.config.ts`). Don't "fix" a masking test that looks hung; give it time.
- There's broad coverage to mirror: RBAC (`rbac*.test.ts`), the saga/idempotency
  (`saga.test.ts`, `queueReliability.test.ts`), preflight guards
  (`preflight.test.ts`, `teardown.test.ts`), and each flag-gated subsystem.

**The verify gate.** Before you commit, run:

```bash
npm run verify   # = lint + typecheck + test
```

This is the pre-commit gate (`package.json`): ESLint, `tsc --noEmit`, then the
full Vitest suite. Get it green before pushing.

## Day-1 checklist

- [ ] **Run it.** Dashboard (`npm run dev`) + worker (`npm run worker`) both up,
      empty state loads, worker prints its polling line — per
      [getting-started.md](./getting-started.md).
- [ ] **Read [ARCHITECTURE.md](../ARCHITECTURE.md)** end to end — especially the
      layer diagram and the job lifecycle.
- [ ] **Skim [CAPABILITY-MAP.md](../CAPABILITY-MAP.md)** so you know it exists and
      how to look up the code behind any feature.
- [ ] **Trace one route → handler → lib.** Open `app/api/instances/route.ts`,
      follow `POST` into `enqueueProvision` (`lib/jobs.ts:92`), and see where a
      job would be picked up (`scripts/worker.ts:131`, `workOnce`).
- [ ] **Run `npm run verify`** on a clean tree and confirm it's green — so you
      know the baseline before you change anything.
- [ ] **Make a trivial change and re-verify.** Tweak a log line or a UI label,
      run `npm run verify`, and watch it stay green. (⚠️ backend change? re-run
      the worker so it picks up the new code — see gotchas.)

## Troubleshooting & gotchas

Start with the [getting-started
troubleshooting](./getting-started.md#troubleshooting) list — Mongo URI,
`ALLOWED_EMAILS` fail-closed, break-glass, the Node ≥ 22.6 `--experimental-strip-
types` requirement. Beyond first-boot, the dev-workflow gotchas that bite:

- ⚠️ **A feature looks dead? Check its flag.** Observability, monitoring, and the
  AI surfaces default **off** (`lib/models/config.ts:114`). An empty tab or a
  `403` from `/api/monitoring/**` is by design until you enable the flag in
  **Config → Features** (or via `FLOTILLA_FEATURE_*`). Don't debug it as a bug first.
- ⚠️ **Jobs sit `queued` and nothing happens? The worker isn't running** — or
  it's running stale code. The dashboard only *enqueues*; execution needs
  `npm run worker` (or `FLOTILLA_INLINE_WORKER=1` for a single-process dev loop,
  `lib/jobs.ts:555`). The worker doesn't hot-reload — **restart it after any
  backend change**. And executing a real provision also needs the
  platform-automation creds (`VERCEL_TOKEN`, `CONVEX_ACCESS_TOKEN`, …).
- ⚠️ **Masking is slow in tests** (20–30 s) — expected, not a hang; timeouts are
  raised to 60 s (`vitest.config.ts`). See test conventions above.
- ⚠️ **Two provisioning engines coexist.** `lib/executor.ts` (all-HTTP) is the
  live path the worker + jobs actually run; `lib/provision.ts` (CLI-driven,
  `npx convex`) still exports `runSaga` + migration constants and is used by
  `scripts/refresh-staging.ts`. **Don't assume `provision()` is the dashboard
  path — it isn't; `executeProvision()` is** (`lib/executor.ts:123`). See
  [ARCHITECTURE.md → Drift & gotchas](../ARCHITECTURE.md#drift--gotchas).
- ⚠️ **Clerk auth-strategy toggles aren't applied by the engine** — the `clerk`
  dimension only *records* a selection; the real toggle is a Playwright worker
  follow-up (`lib/executor.ts:300`).
- ⚠️ **`reset-auth` + `migrations` over HTTP are best-effort**, warned-and-
  deferred on the executor path rather than fatal (`lib/executor.ts:273`).
- ⚠️ **Axiom is dormant.** `lib/clients/axiom.ts` and all `AXIOM_*` env vars are
  unwired; the live observability store is MongoDB (`lib/observability/store.ts`).
- ⚠️ **Two Mongo clusters.** Dashboard state is on the main `dashboard-primary` cluster;
  high-volume metrics live on a **separate** cluster with a TTL index
  (`lib/mongo.ts`). Collections are namespaced `flotilla_*`.

## Where to get help

- **Docs index** — [docs/README.md](../README.md) routes you to the right
  reference: [DATA-MODEL.md](../DATA-MODEL.md) for Mongo collections,
  [API-REFERENCE.md](../API-REFERENCE.md) for route/CLI details,
  [SECURITY.md](../SECURITY.md) for the trust-boundary + RBAC map.
- **Operations runbooks** — [operations/](../operations/) for when something
  breaks: provisioning, snapshots, alerts, break-glass, deploy.
- **The code is the spec.** There's no separate UI-spec doc — the "trueline"
  conventions live in `app/components/kit.tsx` / `nav.tsx` and the
  [Glossary](../GLOSSARY.md#trueline-design-language-conventions). When in doubt,
  copy the nearest existing tab.
- **Load-bearing comments.** The `path:Lnnn` "why this guard exists" comments in
  `lib/deployments.ts`, `lib/executor.ts`, `lib/mask.ts`, and `lib/api.ts` are
  the institutional memory — read them before changing a guard.
- **Security posture** — [../SECURITY.md](../SECURITY.md) for trust boundaries, the RBAC
  floor, the public guest tier, and the provisioning safety guards.

---

**Related:** [Onboarding index](./README.md) · [Architecture](../ARCHITECTURE.md)
· [Capability map](../CAPABILITY-MAP.md) · [Glossary](../GLOSSARY.md) · [Getting
started](./getting-started.md)
