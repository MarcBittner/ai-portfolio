# trueline

**Invoice line-item verification.** Read a vendor invoice, **verify the math in
code**, reconcile every line against the purchase order and catalog rates, flag
overcharges with a recoverable-dollar estimate, and route the money-path lines to
a human — with the flag engine's accuracy *measured* by an eval, not asserted.

> Stack: **Next.js 16 · React 19 · Tailwind v4 · Convex · Clerk · LLM**. The worked
> example is vendor-vs-PO reconciliation (industrial/MRO supply); the engine is
> domain-generic. Synthetic, fictional data only.

**Live demo:** https://trueline-moys.onrender.com — sign in, then the workspace walks
you through it (download contract + invoices → upload → review). *(Hosted on Render;
CO-Ver's stack uses Vercel — identical code, see [Infrastructure](#infrastructure-decisions).)*

The governing principle: **the model reads; deterministic code decides.** The LLM
turns a messy invoice into structured line items with per-line confidence and a
source quote — it never computes a total or makes a flag call. Every number that
touches money is recomputed and judged in plain TypeScript.

---

## Request lifecycle (one upload, end to end)

```
 Browser (RSC + client components)         Convex Cloud (giddy-marmot-130)        LLM
 ─────────────────────────────────         ──────────────────────────────        ───
 Dashboard upload                           
   └─ useMutation(createInvoiceFromText) ─▶ mutation  (transactional write)
                                              • insert invoices{status:"extracting"}
                                              • insert logs{event:"upload"}
                                              • scheduler.runAfter(0, extract.run) ── hop ──▶ action (extract.run)
                                                                                              • runQuery _getRaw  (own txn)
                                                                                              • runQuery routing._forExtract
                                                                                              • extractLineItems(text,{mode}) ─▶ Anthropic / OpenRouter
                                                                                                                                 (free) / mock
                                                                                              • reconcileLine() ×N  (pure code)
                                              mutation (writeResults) ◀── runMutation ───────── • measure latency + cost
   live ◀═ useQuery(getInvoice) re-runs ◀──   • clear+insert invoiceLines (idempotent)
   (reactive — no refresh)                     • patch invoices{status,totals,latency,cost}
                                               • appendLog{event:"extract"}
```

The dashboard/review are **reactive `useQuery` subscriptions**: the instant
`writeResults` commits, Convex re-runs the affected queries and pushes new data to
the browser — the "extracting…" row populates live with zero polling.

---

## The pipeline, step by step (with codepaths)

| # | Step | Where it happens | Convex primitive | Tables |
|---|---|---|---|---|
| 0 | **Upload contract (baseline)** | `app/app/page.tsx` (stepper) → `invoices.setBaselineFromText` parses a PO file (`lib/parse.ts:parsePoText`) | mutation | `purchaseOrders`, `catalog` |
| 1 | **Upload invoice** | `app/app/page.tsx` → `invoices.createInvoiceFromText` inserts the record and **schedules** the action | mutation + `ctx.scheduler` | `invoices`, `logs` |
| 2 | **Extract (LLM)** | `extract.ts:run` → `lib/llm.ts:extractLineItems(text,{mode,model})` calls Anthropic/OpenRouter with a strict JSON schema (per-line `confidence` + `sourceQuote`); falls back to `lib/parse.ts:parsePipeInvoice` (deterministic) so a run never fails | **action** (only place external I/O is legal) | reads via `runQuery` |
| 3 | **Verify math** | `lib/reconcile.ts:reconcileLine` recomputes `extension = qty × unitPrice`; mismatch → flagged. *The LLM's arithmetic is never trusted.* | pure function | — |
| 4 | **Reconcile** | `lib/reconcile.ts:reconcileLine` matches each line to the **PO line** and **catalog rate** (SKU, else fuzzy token-overlap on the description), computes variance vs each baseline | pure function | reads `purchaseOrders`, `catalog` |
| 5 | **Flag + recoverable $** | `lib/reconcile.ts:reconcileLine` → red/yellow/green from variance, math errors, missing matches, low confidence; `recoverableUsd` = overcharge vs the *lower* baseline | pure function | — |
| 6 | **Write back** | `invoices.writeResults` (called by the action) — **one transaction**, **idempotent on the invoice `_id`** (clears + re-inserts lines, because actions aren't auto-retried) | internal mutation | writes `invoiceLines`, patches `invoices`, `logs` |
| 7 | **Review** | `app/app/invoices/[id]/page.tsx` ← `invoices.getInvoice` (reactive). Color-coded line costs; `reviewLine` / `correctLine` (re-runs reconcile) / `setInvoiceStatus` | query + mutations | `invoiceLines`, `invoices` |
| 8 | **Eval** | `evals.ts:runEval` scores flag precision/recall + math-consistency on the labeled set (`lib/demoData.ts:DEMO_EVAL_LABELS`); shown at `app/app/evals` | mutation + query | `evalRuns` |

**Routing** (`convex/routing.ts` + `app/app/settings`): the tenant picks a mode
(auto/free/paid/offline) + model; `extract.run` reads it via `routing._forExtract`
and passes it to `extractLineItems`, which defines the provider order explicitly per
mode (offline→mock; free→OpenRouter→mock; paid→Anthropic→mock; auto→paid→free→mock).

**Diagnostics** (`app/app/diagnostics` + `convex/diagnostics.ts`): request traces
(per-run provider/model/latency/cost/flags), the `logs` event stream, and a
`benchmark` action that runs one invoice through every mode to compare them.

---

## Architecture decisions

**Convex — three function types, deliberately.**
- **Queries** (`listInvoices`, `getInvoice`, `stats`, `baseline`, `recentLogs`,
  `evals.listEvals`) are read-only and **reactive** — the UI subscribes and Convex
  pushes updates. This is why no websocket/polling code exists.
- **Mutations** (`createInvoiceFromText`, `setBaselineFromText`, `reviewLine`,
  `correctLine`, `writeResults`, …) are **serializable ACID transactions**;
  deterministic, so Convex can auto-retry them on conflict — which is *why* they may
  not do external I/O.
- **Actions** (`extract.run`, `diagnostics.benchmark`) are the **escape hatch** for
  external I/O (the LLM call). Not transactional, not auto-retried, no `ctx.db` —
  they reach data via `runQuery`/`runMutation`. A mutation **schedules** the action
  (`runAfter(0, …)`), the standard hop.

**No ORM, and it doesn't need one.** Convex's query layer is built in; types flow
end-to-end from `convex/schema.ts` through codegen (`convex/_generated`) to the React
hooks. Relationships are `v.id(...)` references resolved in code with explicit indexes
(`by_org`, `by_invoice`, …). Trade-off: no ad-hoc SQL joins — modeled in code /
denormalized — in exchange for reactivity + transactions + far less plumbing.

**Idempotency is the action's job.** Convex auto-retries mutations *because* they're
deterministic; actions aren't, so `writeResults` is keyed on the invoice `_id`
(delete-then-insert lines) and is safe to re-run — it can't double-insert or
double-charge the model.

**LLM proposes, calculator verifies.** Pure-LLM number reads hallucinate and give no
uncertainty signal — fatal when the output is dollars. The model is confined to
*reading* into a typed shape (`lib/llm.ts`); all arithmetic and every flag is
deterministic (`lib/reconcile.ts`), which makes the eval exact and reproducible.

**Multi-tenancy via Clerk → Convex.** Clerk mints a JWT (the `convex` template);
`app/providers.tsx`'s `ConvexProviderWithClerk` attaches it; Convex validates it via
`convex/auth.config.ts`; every function derives `orgId` from
`ctx.auth.getUserIdentity()` and filters through a `by_org` index. A signed-in user
with no active org gets a private `user:<id>` tenant (so the demo is friction-free).
Read queries use an `optionalOrg` helper that returns empty instead of throwing while
auth settles, so the UI never white-screens.

**Provider-agnostic LLM via plain `fetch`** (no SDK lock-in) so the same action runs
in Convex's default runtime against Anthropic, OpenRouter, or the deterministic mock,
selected by the routing config.

---

## Infrastructure decisions

- **Next.js on Render** (native Node service: `npm install && npm run build` /
  `npm run start`). CO-Ver's stack uses **Vercel** — the code is identical; Render was
  chosen here only because it needed no new account. Build command on Vercel would be
  `npx convex deploy --cmd 'npm run build'`.
- **Convex Cloud** hosts the backend/DB/realtime (dev: `canny-goshawk-927`, prod:
  `giddy-marmot-130`). Provider API keys + the Clerk issuer are set as **Convex
  deployment env vars** (server-side; the LLM action runs there), never in the browser
  bundle.
- **Clerk** for auth/orgs; only `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` is public.
- `convex/_generated` is **committed** so the git-based host build has the types
  without a Convex deploy step in CI.
- **LLM is free-by-default**: `OPENROUTER_API_KEY` + a free model
  (`google/gemma-4-31b-it:free`). Free tier is 50 req/day — past that, runs fall to the
  deterministic engine (visible on the review header + Diagnostics). Set
  `ANTHROPIC_API_KEY` and choose **Paid** for production-grade extraction.

## Code map

```
convex/
  schema.ts          tables: purchaseOrders, catalog, invoices, invoiceLines,
                     evalRuns, settings, logs (+ indexes)
  auth.config.ts     trust Clerk-issued JWTs (CLERK_JWT_ISSUER_DOMAIN)
  invoices.ts        queries (list/get/stats/baseline/recentLogs) + mutations
                     (create/setBaseline/review/correct/setStatus/reset/seed) +
                     internal writeResults/markError/appendLog + reconcile-and-insert
  extract.ts         internalAction run (LLM) + internalQuery _getRaw
  routing.ts         get/set routing config + internal _forExtract
  evals.ts           runEval + listEvals
  diagnostics.ts     benchmark action (run one invoice through every mode)
  lib/llm.ts         extractLineItems({mode,model}) — Anthropic/OpenRouter/mock
  lib/reconcile.ts   reconcileLine — verify math, match, variance, flag, recoverable $
  lib/parse.ts       parsePipeInvoice (invoice) + parsePoText (contract)
  lib/demoData.ts    synthetic contract, catalog, invoices, eval labels
app/
  layout.tsx providers.tsx middleware.ts   Clerk + Convex wiring, /app route gate
  page.tsx                                  public landing (stack + pipeline)
  app/page.tsx                              dashboard — 4-step guided walkthrough
  app/invoices/[id]/page.tsx                review — color-coded line reconciliation
  app/settings/page.tsx                     Configuration — explicit LLM routing
  app/evals/page.tsx                        Evals — precision/recall + history
  app/diagnostics/page.tsx                  Diagnostics — traces, log, benchmark
  app/about/page.tsx                        About — the stack + principles
  components/nav.tsx ui.tsx                  nav + shared UI (usd, FlagBadge, …)
```

## Local development

```bash
npm install
npx convex dev          # provisions a dev deployment, generates types, watches
npm run dev             # http://localhost:3000
```
`.env.local` (see `.env.example`): Clerk keys + `CLERK_JWT_ISSUER_DOMAIN`; one LLM key
(or none for the mock). Set the LLM key on the **Convex** deployment
(`npx convex env set OPENROUTER_API_KEY …`) since the action runs there.

Part of the [ai-portfolio](https://github.com/MarcBittner/ai-portfolio). Synthetic
data only; no secrets in the repo.
