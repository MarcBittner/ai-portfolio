# trueline

**Invoice line-item verification.** Read a vendor invoice, **verify the math in
code**, reconcile every line against the purchase order and catalog rates, flag
overcharges with a recoverable-dollar estimate, and route the money-path lines
to a human — with the flag engine's accuracy *measured* by an eval, not asserted.

> Built on a **Next.js · Convex · Clerk · LLM** stack. The worked example is
> vendor-vs-PO invoice reconciliation (industrial/MRO supply), but the engine is
> domain-generic: anywhere you extract line items and check them against a
> baseline + a market rate. Synthetic, fictional data only.

**Live demo:** _(deployed to Vercel — link added after deploy)_

---

## What it does (the product loop)

```
upload ─▶ extract (LLM, structured) ─▶ verify math (code) ─▶ reconcile vs PO + catalog
       ─▶ flag red/yellow/green + recoverable $ ─▶ human review ─▶ eval (CI gate)
```

The governing principle: **the model reads; deterministic code decides.** The LLM
turns a messy invoice into structured line items with per-line confidence and a
source quote — it never computes a total or makes a flag call. Every number that
touches money is recomputed and judged in plain TypeScript.

---

## The stack — and why each piece

| Layer | Choice | Why |
|---|---|---|
| **Framework** | **Next.js 16** (App Router, RSC) + **React 19** | Server components render the shell; client components subscribe to live data. File-based routing; middleware at the edge for auth. |
| **Backend / DB** | **Convex** | Reactive document DB + serverless functions + realtime subscriptions in one TypeScript-native platform. No separate API server, no ORM, no websocket plumbing. |
| **Auth / tenancy / billing** | **Clerk** | Drop-in auth + **organizations** (multi-tenancy) + billing. The active org rides in a JWT that Convex validates; every row is scoped by it. |
| **LLM** | **Anthropic** (default), **OpenRouter free** (zero-cost demo), or a **deterministic mock** | Called **server-side only**, inside a Convex action. Structured JSON output; calculator-verified. |
| **Styling** | **Tailwind v4** | CSS-first theme (`@theme {}`, oklch), no config file. |
| **Hosting** | **Vercel** | `git push` → build + deploy + preview URLs. Convex and Clerk are their own clouds — a multi-provider architecture. |

This mirrors a real production SaaS shape: **Next/Vercel = front door + render
layer · Convex = brain + data · Clerk = bouncer + cash register · LLM = document
reader.**

---

## Architecture

### Convex: queries, mutations, actions

The whole backend mental model is three function types (`convex/`):

- **Query** (`listInvoices`, `getInvoice`, `stats`) — read-only, **reactive**. The
  client subscribes with `useQuery`; Convex re-runs and pushes new results when
  any data the query read changes. That's why the review dashboard updates live
  the instant an extraction finishes — no polling, no sockets to manage.
- **Mutation** (`createInvoiceFromText`, `reviewLine`, `correctLine`,
  `writeResults`) — **transactional writes** (serializable ACID). Deterministic,
  so Convex can safely auto-retry on conflict — which is *why* they can't call
  external services.
- **Action** (`extract.run`) — the **escape hatch for external I/O**: the LLM
  call. Not transactional, not auto-retried, no `ctx.db` (it reaches data via
  `runQuery` / `runMutation`). The standard hop is a mutation that **schedules**
  the action (`ctx.scheduler.runAfter(0, internal.extract.run, …)`).

No ORM is needed: the query layer is built in and types flow end-to-end from
`convex/schema.ts` through codegen to the React hooks. The tradeoff vs. SQL is
giving up ad-hoc joins — relationships are modeled with `v.id(...)` references and
explicit indexes — in exchange for reactivity, transactions, and far less
plumbing.

### The extraction pipeline (`convex/extract.ts` + `convex/lib/`)

1. **Upload** → `createInvoiceFromText` mutation inserts an `invoices` row
   (`status: "extracting"`) and **schedules** the extract action.
2. **Extract** (action) reads the invoice via `runQuery`, then calls the LLM with
   a strict instruction to return JSON line items — `{description, sku, quantity,
   unit, unitPrice, extension, confidence, sourceQuote}`. Per-line **confidence**
   and a **source quote** ground every number so a reviewer can trace it back.
   (`convex/lib/llm.ts` — Anthropic → OpenRouter free → deterministic mock.)
3. **Verify in code** (`convex/lib/reconcile.ts`): recompute `extension =
   quantity × unitPrice`. The LLM's math is never trusted.
4. **Reconcile**: match each line to the **PO line** (catch billing above the
   agreed rate) and the **catalog rate** (catch padding) — by SKU when present,
   else a fuzzy token-overlap match on the description. Compute per-line variance.
5. **Flag**: red / yellow / green from variance, math errors, missing matches, and
   low confidence; **recoverable $** = the overcharge vs. the *lower* baseline,
   only when over.
6. **Write back** (action → `writeResults` mutation): all DB writes batched into
   **one** transaction; **idempotent on the invoice `_id`** (clear + re-insert
   lines) because the action isn't auto-retried.
7. **Review** (reactive query): the side-by-side line | PO | catalog | variance |
   confidence | source view updates live. Approve / edit / reject are mutations;
   an estimator's **edit** re-runs the deterministic reconcile and becomes a label.

### Multi-tenancy (Clerk → Convex)

Clerk's **organizations** are the tenants. Clerk mints a JWT (the one-click
"convex" template); `ConvexProviderWithClerk` attaches it; Convex validates it via
`convex/auth.config.ts`; functions read `ctx.auth.getUserIdentity()`. Every row
carries an `orgId` and every query filters through an `by_org` index, so one
tenant can never read another's data. (A signed-in user with no active org gets a
private `user:<id>` tenant, so the demo is friction-free — sign in and a demo org
is seeded instantly.)

### Evals (`convex/evals.ts`)

A labeled set marks which invoices *should* surface a red flag. `runEval` scores
the engine's **flag precision/recall** (did it catch padding without false
alarms?) plus an extraction **math-consistency** rate. This is the CI gate you'd
run before shipping a threshold/prompt/model change: a false negative is lost
money; a false positive erodes trust.

---

## Data model (`convex/schema.ts`)

`purchaseOrders` (baseline #1) · `catalog` (baseline #2 — market rates) ·
`invoices` (status + rollups) · `invoiceLines` (the LLM-read fields **and** the
code-verified fields, side by side) · `evalRuns`. Every table is `orgId`-scoped
with explicit indexes.

---

## Offline / cost story

With **no API keys at all**, extraction falls back to a deterministic parser, so
the whole pipeline runs end-to-end for free. Set `OPENROUTER_API_KEY` for **free**
hosted models (the public demo default) or `ANTHROPIC_API_KEY` for production-grade
Claude. Backend selection is purely environmental — no code change.

## Local development

```bash
npm install
npx convex dev            # provisions a dev deployment, generates types, watches
npm run dev               # Next.js on http://localhost:3000
```

Set in `.env.local` (see `.env.example`): Clerk keys + `CLERK_JWT_ISSUER_DOMAIN`,
and one LLM key (or none for the mock). `npx convex dev` writes
`CONVEX_DEPLOYMENT` + `NEXT_PUBLIC_CONVEX_URL`. Set the LLM key in the **Convex**
deployment (`npx convex env set OPENROUTER_API_KEY …`) since the action runs there.

## Deployment

- **Convex:** `npx convex deploy` (prod deployment).
- **Clerk:** create an app, enable Email + Organizations, add the **Convex** JWT
  template, set `CLERK_JWT_ISSUER_DOMAIN` in Convex.
- **Vercel:** import the repo (root `projects/trueline`); set the build command to
  `npx convex deploy --cmd 'npm run build'` so Convex deploys and injects
  `NEXT_PUBLIC_CONVEX_URL` into the Next build. Add the Clerk env vars in Vercel.

## Tech notes / decisions

- **LLM proposes, calculator verifies.** Pure-LLM PDF/number reads hallucinate and
  give no uncertainty signal — fatal when the output is dollars. The model is
  confined to *reading* into a typed shape; all arithmetic and every flag is
  deterministic code (`reconcile.ts`), which makes the eval exact and reproducible.
- **Idempotency is the action's job.** Convex auto-retries mutations *because*
  they're deterministic; actions aren't retried, so the write-back is keyed on the
  invoice `_id` to be safe to re-run.
- **Fuzzy matching** falls back to description token-overlap when SKUs are missing
  or wrong (common in real invoices); units are normalized before variance.
- **Provider-agnostic LLM** via plain `fetch` (no SDK lock-in), so the same action
  runs in Convex's default runtime against Anthropic, OpenRouter, or the mock.

Part of the [ai-portfolio](https://github.com/MarcBittner/ai-portfolio). Synthetic
data only; no secrets in the repo.
