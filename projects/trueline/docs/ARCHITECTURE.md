# trueline — Software Architecture

A complete, read-it-once reference for how trueline works end to end. Pair with
[`DEPLOYMENT.md`](./DEPLOYMENT.md) for the infra/deploy side.

> **One sentence:** an LLM reads a vendor invoice into structured JSON; **every
> number and every flag is then decided by deterministic TypeScript** that
> reconciles each line against the purchase order and a market-rate catalog,
> estimates recoverable overcharges, and routes the money-path lines to a human —
> live, multi-tenant, with the extraction quality measured by an eval.

---

## Contents

- [1. The thesis (why it's built this way)](#1-the-thesis-why-its-built-this-way)
- [2. Stack & topology](#2-stack-topology)
- [3. Data model ([`convex/schema.ts`](https://github.com/MarcBittner/ai-portfolio/blob/main/projects/trueline/convex/schema.ts))](#3-data-model-convexschemats)
- [4. The request lifecycle (upload → recoverable $)](#4-the-request-lifecycle-upload-recoverable-)
- [5. The deterministic core ([`convex/lib/reconcile.ts`](https://github.com/MarcBittner/ai-portfolio/blob/main/projects/trueline/convex/lib/reconcile.ts))](#5-the-deterministic-core-convexlibreconcilets)
- [6. LLM routing ([`convex/lib/llm.ts`](https://github.com/MarcBittner/ai-portfolio/blob/main/projects/trueline/convex/lib/llm.ts))](#6-llm-routing-convexlibllmts)
- [7. Multi-tenancy & auth](#7-multi-tenancy-auth)
- [8. Realtime, idempotency, and the eval loop](#8-realtime-idempotency-and-the-eval-loop)
- [9. App surface (`app/`)](#9-app-surface-app)
- [10. Design decisions & tradeoffs](#10-design-decisions-tradeoffs)

**Source map — jump to the code:**

| Concept | Function(s) | Source |
|---|---|---|
| Data model (7 tables, `orgId`-scoped) | schema | [`convex/schema.ts`](https://github.com/MarcBittner/ai-portfolio/blob/main/projects/trueline/convex/schema.ts) |
| Deterministic verification (math/match/flag/$) | `reconcileLine` | [`convex/lib/reconcile.ts`](https://github.com/MarcBittner/ai-portfolio/blob/main/projects/trueline/convex/lib/reconcile.ts) |
| LLM routing chain (auto→local→paid→free→mock) | `extractLineItems` | [`convex/lib/llm.ts`](https://github.com/MarcBittner/ai-portfolio/blob/main/projects/trueline/convex/lib/llm.ts) |
| Async extract job (action) | `run` | [`convex/extract.ts`](https://github.com/MarcBittner/ai-portfolio/blob/main/projects/trueline/convex/extract.ts) |
| Mutations/queries + multi-tenancy + review | `createInvoiceFromText` · `submitExtraction` · `insertReconciledLines` · `correctLine` · `requireOrg` | [`convex/invoices.ts`](https://github.com/MarcBittner/ai-portfolio/blob/main/projects/trueline/convex/invoices.ts) |
| Auth wiring (Clerk JWT → Convex) | `Providers` | [`app/providers.tsx`](https://github.com/MarcBittner/ai-portfolio/blob/main/projects/trueline/app/providers.tsx) · [`convex/auth.config.ts`](https://github.com/MarcBittner/ai-portfolio/blob/main/projects/trueline/convex/auth.config.ts) |
| Edge auth gate (`/app`) | `clerkMiddleware` | [`middleware.ts`](https://github.com/MarcBittner/ai-portfolio/blob/main/projects/trueline/middleware.ts) |
| Browser→host Ollama (live demo) | — | [`app/lib/ollama.ts`](https://github.com/MarcBittner/ai-portfolio/blob/main/projects/trueline/app/lib/ollama.ts) |
| Eval (accuracy + flag precision/recall) | — | [`convex/evals.ts`](https://github.com/MarcBittner/ai-portfolio/blob/main/projects/trueline/convex/evals.ts) |
| App pages | — | [`app/`](https://github.com/MarcBittner/ai-portfolio/blob/main/projects/trueline/app) |

## 1. The thesis (why it's built this way)

The product is **trust with money**. So the design rule is a hard split:

| The LLM may… | The LLM may **never**… |
|---|---|
| read values that appear in the document into a strict JSON shape, with a per-line `confidence` and a verbatim `sourceQuote` | compute an extension, decide a flag, estimate recoverable $, or touch a total |

Everything that touches money is **pure, deterministic TypeScript** ([`convex/lib/reconcile.ts`](https://github.com/MarcBittner/ai-portfolio/blob/main/projects/trueline/convex/lib/reconcile.ts)) — recompute the math, match to baselines, compute variance, flag, estimate recovery. A model hallucinating a number can only ever mis-*read* a line (caught by the math recompute + the `sourceQuote` + a low-confidence flag); it can't mis-*decide* one. This is the whole credibility argument for putting an LLM near accounts payable.

---

## 2. Stack & topology

| Layer | Tech | Role |
|---|---|---|
| Frontend | **Next.js 16** (App Router, RSC), React 19, Tailwind v4 | marketing landing (public) + the gated `/app` workspace |
| Backend / DB / realtime / jobs | **Convex** | document DB, TS queries/mutations/actions, reactive subscriptions, scheduler |
| Auth / multi-tenancy | **Clerk** (orgs + JWT) | sign-in, organizations, the JWT Convex trusts |
| LLM | local **Ollama** · **Anthropic** · **OpenRouter** (free) · deterministic mock | invoice → structured line items, selected by routing config |
| Host | **Render** (Next) + **Convex Cloud** + **Clerk Cloud** | three managed planes, all free-tier |

```
 Browser ── Clerk session (JWT, "convex" template)
    │
    ▼
 Next.js (Render)  ── RSC pages + client components
    │   ConvexProviderWithClerk attaches the Clerk JWT to every Convex call
    ▼
 Convex Cloud  ── queries (reactive reads) · mutations (ACID writes) · actions (external I/O) · scheduler
    │   ctx.auth.getUserIdentity() → org_id  →  every row filtered by orgId index
    ├─ extract action ──► LLM:  Ollama → Anthropic → OpenRouter → mock   (server-side keys)
    └─ (or) browser→host Ollama ──► submitExtraction mutation            (client-side, for the live demo)
```

---

## 3. Data model (`convex/schema.ts`)

Seven tables, **every document scoped by `orgId`** (the Clerk organization), each with a `by_org` index so one tenant can never read another's rows.

- **`purchaseOrders`** — baseline #1: the contract the invoice is billed against (`poNumber`, `vendor`, `lines[]` of sku/desc/unit/qty/unitPrice).
- **`catalog`** — baseline #2: market/"should-cost" rates per sku.
- **`invoices`** — header + status (`extracting → needs_review → approved|rejected`) + rollups (`claimedTotal`, `recoverableUsd`) + extraction telemetry (`extractionProvider`, `extractionModel`, `latencyMs`, `costUsd`).
- **`invoiceLines`** — the heart, three zones per row:
  - *what the LLM read*: `description, sku, unit, quantity, unitPrice, claimedExtension, confidence, sourceQuote`
  - *what code decided*: `computedExtension, mathOk, poUnitPrice, catalogPrice, matchedBy, varianceVsPoPct, varianceVsMarketPct, flag, reasons[], recoverableUsd`
  - *human-in-the-loop*: `decision (pending|approved|edited|rejected), reviewer`
- **`logs`** — structured event log (Diagnostics tab).
- **`settings`** — per-tenant LLM routing (`mode`, optional `model`).
- **`evalRuns`** — extraction accuracy + flag precision/recall over a labeled set.

The schema *is* the thesis: the `invoiceLines` columns are physically partitioned into "model read it" vs "code decided it."

---

## 4. The request lifecycle (upload → recoverable $)

A new invoice ([`convex/invoices.ts`](https://github.com/MarcBittner/ai-portfolio/blob/main/projects/trueline/convex/invoices.ts) + [`convex/extract.ts`](https://github.com/MarcBittner/ai-portfolio/blob/main/projects/trueline/convex/extract.ts)):

1. **`createInvoiceFromText`** (mutation) inserts the invoice as `status:"extracting"`, logs the upload. Then one of two extraction paths:
   - **Server path** (default): schedules the `extract.run` **action** via `ctx.scheduler.runAfter(0, …)` — a managed async job (an action is the only place external I/O is allowed).
   - **Browser→host path** (`deferServer:true`, used by the live demo): does *not* schedule the action. The browser runs the model on the user's **local Ollama** (the cloud can't reach `localhost`; the browser can) and calls `submitExtraction`. If local Ollama isn't reachable, the client calls `scheduleExtract` and the server path takes over.
2. **`extract.run`** (action) reads the raw text (through a query — actions have no `ctx.db`), reads the tenant's routing config, calls **`extractLineItems`** (the LLM), then batches all DB writes into **`writeResults`** (one internal mutation = one transaction). The action is **not** transactional and **not** auto-retried, so it's **idempotent**: keyed on the invoice `_id`, and `insertReconciledLines` clears prior lines before re-inserting — a re-run can't double-insert.
3. **`insertReconciledLines`** (shared by seed, server path, and browser path) loads the org's PO + catalog, then for each extracted line calls **`reconcileLine`** (§5), inserts the `invoiceLines` row (LLM fields + reconciled fields), and accumulates `recoverableUsd` + `claimedTotal` into the invoice.
4. The invoice flips to `needs_review`. Because Convex queries are **reactive**, every open client (`useQuery(listInvoices)` / `getInvoice`) updates **live** — no polling.
5. **Human review**: `reviewLine` (approve/reject), `correctLine` (edit unit price/qty → **re-runs `reconcileLine`** and marks `decision:"edited"` — an estimator's correction is both an action and a *label* for the eval), `setInvoiceStatus`.

Errors in the action are caught → `markError` flips the invoice back to `needs_review` with an `error` string + an error log, so a failed model call never strands an invoice.

---

## 5. The deterministic core (`convex/lib/reconcile.ts`)

Pure functions, no Convex imports → trivially unit-testable. Per line:

1. **Recompute the extension** `qty × unitPrice` (rounded to cents); `mathOk` if it matches the printed `claimedExtension` within 1¢. Math mismatch → **red**.
2. **Match to baselines** — PO line first, then catalog: by **sku** if present, else **fuzzy description** (token-overlap ≥ `0.4` of the smaller token set). `matchedBy = sku|description|none`.
3. **Variance** vs PO unit price and vs market price, as signed %.
4. **Flag + recoverable $**:
   - thresholds: `> +10%` over a baseline → **red**; `> +3%` → **yellow**; math fail → red; no match → yellow ("can't verify the rate"); `confidence < 0.6` → yellow.
   - `recoverableUsd` = `(unitPrice − min(poUnitPrice, catalogPrice)) × quantity`, **only when over** the lower baseline.
   - every line carries a human-readable `reasons[]` (e.g. *"unit price 18.4% over baseline"*, *"math: 12 × $40 = $480, invoice says $520"*).

`correctLine` runs the exact same function on the edited values, so a reviewer's edit is reconciled identically to a fresh extraction.

---

## 6. LLM routing (`convex/lib/llm.ts`)

`extractLineItems(rawText, {mode, model})` walks a provider chain and **always terminates** in a deterministic mock, so the pipeline completes with zero keys.

| `mode` | order |
|---|---|
| `auto` (default) | local Ollama *(if a cached `/api/tags` probe answers)* → Anthropic *(if key)* → OpenRouter free *(if key)* → mock |
| `local` | Ollama → mock · `free` | OpenRouter → mock · `paid` | Anthropic → mock · `offline` | mock only |

- The **system prompt** constrains the model to read-only structured output; `coerceLines` + `parseJsonLoose` defensively normalize numbers (strip `$`/`,`), clamp `confidence` to [0,1], tolerate fenced JSON, and drop empty rows. **No `response_format` is forced** (free OpenRouter models reject it) — the prompt + lenient parse do the job.
- Keys live **server-side in the Convex deployment** (`ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`); the public demo defaults to OpenRouter free (`google/gemma-4-31b-it:free`).
- **Browser→host Ollama** ([`app/lib/ollama.ts`](https://github.com/MarcBittner/ai-portfolio/blob/main/projects/trueline/app/lib/ollama.ts) + `submitExtraction`) lets the *live cloud* demo run a real model on the reviewer's own machine — the cloud action can't reach `localhost`, but the browser can; the server still does all the deterministic reconcile.

---

## 7. Multi-tenancy & auth

- **Clerk** runs at the edge ([`middleware.ts`](https://github.com/MarcBittner/ai-portfolio/blob/main/projects/trueline/middleware.ts)): `/app(.*)` is gated (`auth.protect()`), everything else is public so reviewers can read the product before signing in.
- `ClerkProvider → ConvexProviderWithClerk` ([`app/providers.tsx`](https://github.com/MarcBittner/ai-portfolio/blob/main/projects/trueline/app/providers.tsx)) mints the Clerk **"convex" JWT** and attaches it to every Convex request; Convex validates it against `CLERK_JWT_ISSUER_DOMAIN` ([`convex/auth.config.ts`](https://github.com/MarcBittner/ai-portfolio/blob/main/projects/trueline/convex/auth.config.ts)).
- Inside every function, `requireOrg`/`optionalOrg` read `ctx.auth.getUserIdentity()` → `org_id` claim (or a `user:<subject>` fallback so a solo reviewer still gets an isolated, seeded space). **Every query/mutation filters by `orgId` through an index** — tenant isolation is enforced in code on every row, not assumed.
- `optionalOrg` never throws: read queries return an empty state during the brief window where Convex auth lags a render behind Clerk, instead of crashing the client.

---

## 8. Realtime, idempotency, and the eval loop

- **Realtime**: Convex `useQuery` subscriptions push updates to every client when any underlying row changes — the review list, an invoice's lines, and the dashboard stats all update live as extraction completes or a teammate reviews.
- **Idempotency**: the extract action is keyed on the invoice id and `insertReconciledLines` clears-then-inserts, so a retried/duplicated run is safe.
- **Eval** ([`convex/evals.ts`](https://github.com/MarcBittner/ai-portfolio/blob/main/projects/trueline/convex/evals.ts), Evals tab): runs the pipeline over a labeled set and reports **extraction accuracy** (fields read correctly) and **flag precision/recall** — quality is *measured*, not asserted, and a reviewer's `correctLine` edits are labels that feed it.

---

## 9. App surface (`app/`)

- `/` — public marketing landing.
- `/app` — dashboard: stats (invoices, recoverable $, needs-review), the guided baseline→upload→review flow, the invoice list with red/yellow/green counts.
- `/app/invoices/[id]` — line-by-line review: each row shows what the model read, what code decided, the `reasons[]`, the `sourceQuote`, and approve/edit/reject.
- `/app/evals` — run + view eval results. `/app/settings` — per-tenant routing config + browser→host Ollama model picker. `/app/diagnostics` — the event log + provider status. `/app/about` — built-with.

---

## 10. Design decisions & tradeoffs

- **Convex over Postgres+ORM+API+websockets+queue** — one TS-native platform gives ACID mutations, reactive subscriptions (the live review UI with zero polling), and a managed scheduler (the async LLM job) without connection pools, migrations, or socket plumbing.
- **Clerk over hand-rolled auth** — production sessions/MFA + an **organization** model + billing, drop-in; the org id rides in the JWT and scopes every row, so there's no bespoke RBAC.
- **LLM reads, code decides** — the only safe contract for money; also makes the system explainable (`reasons[]`) and testable (pure `reconcile.ts`).
- **Deterministic terminal fallback** — the app runs end-to-end with zero keys/zero cost, which is why the public demo works for any reviewer.
- **Honest limits** — synthetic sample data (runs on your real data too); pipe-delimited text ingest (PDF/OCR is the stated next step); fuzzy description matching is token-overlap (embeddings are the upgrade); single Convex deployment (Convex handles scaling). These are called out, not hidden.
