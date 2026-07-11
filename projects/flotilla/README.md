# flotilla

[![Next.js](https://img.shields.io/badge/Next.js-App_Router-000000?logo=nextdotjs&logoColor=white)](https://nextjs.org)
[![React](https://img.shields.io/badge/React-19-61dafb?logo=react&logoColor=000)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![MongoDB](https://img.shields.io/badge/MongoDB-persistence-47A248?logo=mongodb&logoColor=white)](https://www.mongodb.com)
[![Clerk](https://img.shields.io/badge/auth-Clerk-6C47FF?logo=clerk&logoColor=white)](https://clerk.com)
[![Tailwind](https://img.shields.io/badge/Tailwind-v4-38bdf8?logo=tailwindcss&logoColor=white)](https://tailwindcss.com)
[![license](https://img.shields.io/badge/license-proprietary-red)](LICENSE)

**A control plane for ephemeral preview environments.** flotilla provisions, monitors,
refreshes, and tears down **isolated app instances** — each one a
`(git branch × PII-masked data clone × dedicated auth config)` deployed across
**Vercel + Convex + Clerk**. Route handlers only **enqueue** work and return a job id;
a **standalone worker** runs the long, all-HTTP provisioning **saga** off the request
path — with compensating rollback, layered production-safety guards, and a
**public-safe design** where an unauthenticated guest can read everything and change
nothing.

**Live:** *(demo)* — synthetic fleet · guests are read-only · every destructive action is server-side-blocked for guests.

![The flotilla instances view](docs/screenshots/ui/app-instances.png)

*The operator console — provision, refresh, and monitor preview/staging instances from one place.*

---

## Contents

- [What it is](#what-it-is)
- [Why it's interesting](#why-its-interesting)
- [The public-safe design (guests read; guests can't break anything)](#the-public-safe-design-guests-read-guests-cant-break-anything)
- [How it works — enqueue → worker → compensating saga](#how-it-works--enqueue--worker--compensating-saga)
- [The safety story](#the-safety-story)
- [Stack](#stack)
- [Capabilities at a glance](#capabilities-at-a-glance)
- [Run it locally](#run-it-locally)
- [Configuration](#configuration)
- [Documentation](#documentation)

## What it is

Modern app teams want a **throwaway, production-shaped environment per branch or per
PR**: real data (minus the PII), a real auth tenant, a real deployment URL — up in a
minute, gone when the branch closes. flotilla is the **control plane** that does that. It
is not the app being previewed; it is the operator console that drives three managed
platforms to stand each preview up and take it down:

- **Vercel** — the code deployment (the preview URL).
- **Convex** — an isolated backend/database, seeded from a masked snapshot of a source
  deployment's data.
- **Clerk** — a dedicated auth configuration so a preview never shares sessions with
  anything real.

An **instance** ties those three together with a lifecycle (`pending → provisioning →
ready → archived`), an optional auto-expiry TTL, and a health signal. flotilla is a
Next.js (App Router) app with a **MongoDB** persistence layer for its *own* state
(deliberately decoupled from the fleet it manages), a Clerk auth gate with a scrypt
**break-glass** fallback, and a standalone background worker for off-request
provisioning.

## Why it's interesting

This is a systems piece, not a CRUD app. The parts worth reading the code for:

- **A compensating saga off the request path.** Provisioning streams tens of MB of
  snapshot data and needs a real filesystem (unzip → mask → re-zip), so it can't run in
  a serverless handler. The API enqueues; a standalone Node worker runs named saga steps
  that each register a **compensator**, so a failure *unwinds* — the half-built preview
  is torn back down instead of lingering. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).
- **An idempotent job queue in plain MongoDB.** Single-winner atomic claim, heartbeats,
  stalled-job reclaim, a dead-letter queue, and idempotency keys so a double-submit
  converges — no external queue service. See [`docs/DATA-MODEL.md`](docs/DATA-MODEL.md).
- **Deterministic, referentially-consistent PII masking.** A *string-level* JSONL
  rewriter masks identity fields while preserving every byte it doesn't target — so
  numeric fields, id references, and cross-record joins survive the mask. Prod-sourced
  data is masked **by force**, regardless of caller intent. See [`docs/SECURITY.md`](docs/SECURITY.md).
- **Layered deployment-topology safety.** A production deployment can *never* be a write
  or teardown target — no override exists. Every other shared target needs an explicit
  `dangerAck`. Guards live in their own modules and are never behind a feature flag.
- **The public-safe design** below — the headline for a public demo.

## The public-safe design (guests read; guests can't break anything)

flotilla holds credentials for real infrastructure, so a public demo has one hard
requirement: **a visitor must be able to explore the whole console and be structurally
incapable of touching anything.** That is not a UI convenience — hiding a button is not
security — it is enforced **server-side on every route**.

The authorization model is a four-role floor, `read-only < write < admin < super-admin`,
enforced in one gate (`withOperator(handler, minRole)`) that runs before every handler.
GET routes default to `read-only`; every mutating route declares `write` or higher. The
public demo adds a **guest tier below `read-only`**:

```
 unauthenticated guest ─┐
                        │  can call every GET route          → sees the whole console
                        │  cannot pass ANY write+ route       → 403, server-side, always
 authenticated operator ┘  read-only → write → admin → super-admin
```

| A guest can… | A guest can **never**… |
|---|---|
| Browse instances, queue, logs, backups, config, the access model, monitoring/observability dashboards | Provision, refresh, or tear down an instance |
| Read every dashboard and every list (all GET routes) | Capture/delete a snapshot, edit config or feature flags, change a role, run any AI action |
| See exactly what an operator sees | Reach the worker at all — mutations never enqueue a job |

Why it's robust: the block is at the **route gate**, not the button. A guest who crafts
the POST by hand still gets a `403` — the mutation never enqueues a job, so the
credential-bearing worker is never reached. The demo is safe **because the same RBAC
floor that protects the real tool protects the demo**; the guest tier is just its bottom
rung. And it composes with the deployment-safety guards: even an authenticated operator
cannot write to a production deployment, so a demo fleet is doubly fenced.

> **Shipped vs demo.** The four-role RBAC floor, the server-side `withOperator` gate,
> and the production/shared guards are **shipped** and enforced in code. The
> **read-only guest tier** is the portfolio demo's public-safe surface layered on that
> same floor — read [`docs/SECURITY.md`](docs/SECURITY.md) for exactly where each is enforced.

## How it works — enqueue → worker → compensating saga

```
Operator/Guest         Next.js route handler          MongoDB queue        Standalone worker
   │  submit launch          │                             │                     │
   ├────────────────────────►│ withOperator("write")       │                     │
   │        (guest: 403 ─────┤  ← blocked here, server-side │                     │
   │         never enqueues) │                             │                     │
   │                         ├─ parse (zod) + fill defaults │                     │
   │                         ├─ enqueueProvision() ────────►│ INSERT queued        │
   │   { jobId, instanceId } │◄────────────────────────────┤ (upsert idempotencyKey)
   │◄────────────────────────┤                             │  claimJob() queued→running (atomic)
   │  GET /jobs/:id/stream (SSE, read-only)                 │◄────────────────────┤
   │◄═══════ live log lines + status ══════════════════════╪═════════════════════╡ runSaga():
   │                         │                             │   1 preflight (prod/dangerAck guard)
   │                         │                             │   2 provision backend (fresh isolated)
   │                         │                             │   3 deploy code (Vercel REST)
   │                         │                             │   4 import data (MASK → import)
   │                         │                             │   5 reset auth  6 migrations  7 verify
   │                         │                             │   fail → unwind compensators (teardown/restore)
   │  SSE "done"             │                             │  updateInstance(ready)  ◄── notify()
   │◄════════════════════════╪═════════════════════════════╪═════════════════════┘
```

1. **The route only enqueues.** It authenticates and authorizes (`withOperator`), parses
   a Zod body, fills omitted fields from config defaults, writes a `queued` job, and
   returns `{jobId, instanceId}` immediately. It **never** provisions inline.
2. **The worker claims it.** A standalone Node process polls the queue and flips the job
   `queued → running` with an atomic single-winner claim, so N worker copies are safe and
   a re-invocation no-ops.
3. **The saga runs.** Named steps execute in order; each may register a **compensating**
   action. On an uncorrectable throw the runner unwinds executed steps in reverse — tear
   down the preview it created, restore the pre-provision snapshot — so a half-built
   instance never lingers.
4. **The browser tails it live** over Server-Sent Events (a read-only route — open to
   guests too), and the instance converges to `ready` or `failed`.

## The safety story

The worker holds credentials for real deployments, so the last line of defense is a
**preflight** step that runs before anything is touched — independent of RBAC:

| Guard | Behavior |
|---|---|
| **Production hard-block (write & teardown)** | The production deployment can *never* be a write or teardown target — **no `dangerAck` overrides it.** Production is a read-only *source* only. |
| **`dangerAck` on any pre-existing deployment** | Re-provisioning a deployment the tool did not create throws unless the caller passes `dangerAck=true` — an explicit, audited footgun-with-a-safety. |
| **Forced PII masking of prod-sourced data** | A snapshot sourced from a production/staging-prod deployment is masked **on**, regardless of the caller's `scrubPII` flag. |
| **Protected-project / email kill-switch** | Protected Vercel projects are never torn down; a target flagged as email-sending is refused so a clone never emails real users. |
| **auth-id reset** | Imported auth ids carry the *source* tenant's issuer and can never match this instance; they're rewritten post-import. |

Guards live in their own modules (`lib/deployments.ts`, `lib/executor.ts`) and are
**never behind a feature flag** — flipping a flag off reverts behavior, never re-opens a
guard.

## Stack

| Layer | Tech |
|---|---|
| UI + API | Next.js (App Router, RSC), React 19, Tailwind v4 — route handlers are `runtime="nodejs"`, `dynamic="force-dynamic"` |
| Persistence | MongoDB — the dashboard's own state, two clusters (primary + a dedicated high-volume metrics cluster) |
| Auth | Clerk (primary gate) + a scrypt **break-glass** fallback; four-role RBAC floor |
| Worker | Plain Node process (`scripts/worker.ts`) — filesystem, unzip/zip, safe to run N copies |
| Validation | Zod — every model + API body parses through a schema |
| Control planes it drives | **Vercel REST · Convex management + deploy · Clerk backend · GitHub REST** |
| AI (optional) | SDK-free direct `fetch` to Anthropic / OpenAI / OpenRouter / Ollama, with a deterministic terminal tier |

Every **non-core** subsystem — observability, monitoring, AI assist, cost, drift, share
links — is behind a **feature flag that ships off by default**. Enabling a flag never
changes behavior for anyone until its UI is used; safety guards are never flags.

## Capabilities at a glance

| Capability | Status |
|---|---|
| Instance lifecycle — provision / refresh / update / teardown, off-request saga | ✅ shipped |
| Idempotent job queue + dead-letter queue + stalled-job reclaim | ✅ shipped |
| Snapshots & backups — capture/restore; blobs in a release-asset store, not the DB | ✅ shipped |
| Four-role RBAC + grant boundary + immutable super-admins + break-glass | ✅ shipped |
| Deterministic PII masking (forced for prod-sourced data) | ✅ shipped |
| Deployment-topology safety guards (prod hard-block, `dangerAck`, protected projects) | ✅ shipped |
| Read-only public guest tier (demo) | ✅ shipped |
| Observability — metrics pipeline (Vercel / Clerk / provider / internal RED) charted in-app | 🔭 flag-gated (off) |
| Monitoring & alerting — closed-registry checks, OK/WARN/CRIT state machine, escalation | 🔭 flag-gated (off) |
| AI assist — failure triage, "Ask AI", validated fix-loop (all read-only by posture) | 🔭 flag-gated (off) |

Legend: ✅ shipped · ◐ partial · 🔭 flag-gated / planned (default off) · ⚠️ caveat.

## Run it locally

**Prerequisites:** Node.js ≥ 20 (the worker's type-stripping path prefers ≥ 22.6;
otherwise run it via `tsx`) · a MongoDB instance (Atlas or local) · Clerk application
credentials for the auth gate.

```bash
npm install
cp .env.example .env.local   # fill in the values — every var is documented inline
npm run dev                  # Next.js dev server → http://localhost:3000
npm run worker               # the background job worker (a separate process)
```

The dashboard runs with an honest empty state until its dependencies are configured;
optional subsystems (observability, monitoring, AI) no-op cleanly when their env/flags
are absent. For a single-process local loop, `FLOTILLA_INLINE_WORKER=1` runs jobs inline
without a separate worker.

| Command | Purpose |
|---|---|
| `npm run dev` | Next.js dev server |
| `npm run worker` | Standalone job worker (provisioning, sweeps) |
| `npm run build` | Production build (`next build`) |
| `npm run verify` | Lint + typecheck + unit tests (the pre-commit gate) |

## Configuration

All configuration is environment-driven and documented inline in
[`.env.example`](.env.example) — copy it to `.env.local` and fill in values. Nothing
sensitive is committed; secret env files are gitignored. A subset of settings can also
be overridden at runtime from the in-app **Config** page, where a persisted value takes
precedence over the env default and every field shows a `customized` / `from env` /
`default` badge for its source.

The **Safety & environment** block on that page surfaces the read-only
deployment-topology guards (the production deployment, protected projects, allow-listed
operators) for visibility only — they are never editable there and never show secrets.

## Documentation

Code-grounded documentation lives in **[`docs/`](docs/README.md)**:

| Doc | What it documents |
|---|---|
| [Architecture](docs/ARCHITECTURE.md) | System shape, layers, the enqueue → worker → saga lifecycle, key decisions |
| [Data model](docs/DATA-MODEL.md) | MongoDB collections, relationships, instance lifecycle, retention/TTL |
| [Security](docs/SECURITY.md) | Trust boundaries, the RBAC map + guest tier, PII masking, secrets/retention |
| [Capability map](docs/CAPABILITY-MAP.md) | Feature → code index; every route + worker CLI; feature flags |
| [Decisions (ADRs)](docs/DECISIONS.md) | Why the system is shaped this way |

Part of the [ai-portfolio](https://github.com/MarcBittner/ai-portfolio).
