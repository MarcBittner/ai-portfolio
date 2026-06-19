# trueline — Overview

A technical overview of what trueline is, the problem it solves, and how it is
shaped — grounded in the code, but above the line-level depth of
[`WALKTHROUGH.md`](./WALKTHROUGH.md). For system design see
[`ARCHITECTURE.md`](./ARCHITECTURE.md); for hosting see [`DEPLOYMENT.md`](./DEPLOYMENT.md); for the function API see [`API.md`](./API.md).

## The problem

Vendors are paid against a contract — a purchase order that fixes the agreed unit
price for each item. Invoices then arrive over weeks or months, and the prices on
them drift: a line is billed above the agreed rate, a quantity is multiplied wrong,
a fee appears that the contract never authorized. Catching this by hand means a
person reading every line of every invoice against the PO and a rate sheet. It does
not scale, so most overcharges are simply paid.

trueline automates the read-and-check, with a hard rule about *what* is automated.

## The core principle

**The language model only reads. Deterministic code decides.**

The model turns an invoice — possibly messy text — into structured line items:
description, SKU, quantity, unit price, the printed line total, and a confidence
score. It never does arithmetic and never decides whether a line is an overcharge.
Every calculation and flag is produced by pure code in
[`convex/lib/reconcile.ts`](../convex/lib/reconcile.ts), which has no Convex imports
and is therefore directly unit-testable in isolation.

This matters because a model's failure modes — hallucinated numbers, arithmetic
mistakes, inconsistent judgment — are exactly what you cannot have in a process that
disputes money. Confining the model to extraction
([`convex/lib/llm.ts`](../convex/lib/llm.ts)) keeps the trustworthy part trustworthy
regardless of which model, or no model, did the reading. The split is enforced in
two concrete places: the database schema
([`convex/schema.ts`](../convex/schema.ts)) stores model-read fields and
code-computed fields in separate, commented column groups; and the request path
quarantines the model call in a non-transactional Convex *action*
([`convex/extract.ts`](../convex/extract.ts)) while every decision runs in
transactional code.

## The three planes

trueline is three independently deployed services, not one server:

- **Web app — Next.js** (`app/`). Marketing page and the signed-in workspace. Holds
  only the *public* Convex URL (inlined via the `NEXT_PUBLIC_CONVEX_URL` env
  convention) and the Clerk keys; it never holds a model key.
- **Backend — Convex** (`convex/`). Database, all server functions, the scheduler,
  and realtime. **Model keys live here**, read from `process.env` inside `llm.ts`,
  because this is the only place a model is called.
- **Auth — Clerk**. Sign-in, organizations, and the signed JWT the backend trusts.

How they connect:
- Signing in yields **two** credentials: a **session cookie** that `middleware.ts`
  checks to gate `/app`, and a **signed JWT** that Convex verifies. Trust is anchored
  in [`convex/auth.config.ts`](../convex/auth.config.ts) (one issuer + audience), so
  `ctx.auth.getUserIdentity()` returns verified claims — including the organization
  id — with no per-request lookup. `ConvexProviderWithClerk` (in
  [`app/providers.tsx`](../app/providers.tsx)) attaches a fresh JWT to every call.
- The browser holds one **websocket** to Convex (a single `ConvexReactClient` at
  module scope). Reads are `useQuery` subscriptions over it: Convex re-runs a
  subscribed query and pushes the new result whenever its underlying rows change. No
  polling, no manual refetch.

## Convex function types (how the split is enforced at runtime)

The backend uses Convex's three function kinds deliberately:
- **queries** — reactive, transactional reads (`listInvoices`, `getInvoice`,
  `stats` in [`convex/invoices.ts`](../convex/invoices.ts)). They may not make
  network calls.
- **mutations** — transactional writes (`createInvoiceFromText`,
  `submitExtraction`, `reviewLine`, `correctLine`). Also no network calls.
- **actions** — the *only* place external I/O (the model call) is allowed
  (`extract.run`). Actions are **not** transactional and have no direct DB handle;
  they read/write by calling queries/mutations.

So the fallible network step is isolated in an action that calls the model, then
commits results through a single mutation (`writeResults`). Because the action is
not auto-retried, the write path (`insertReconciledLines`) **clears any existing
lines for the invoice before re-inserting**, keyed on the invoice id — so a re-run
can never double-insert.

## How it works, end to end

1. **Upload.** A reviewer uploads a contract (purchase order) and invoices.
   `createInvoiceFromText` records the invoice as `extracting`; `setBaselineFromText`
   parses the contract into the PO baseline. A market/catalog rate sheet is the
   second baseline.
2. **Extract.** `extractLineItems` (`llm.ts`) routes by mode through an explicit
   provider chain — local Ollama → Anthropic → OpenRouter — and falls back to a
   deterministic pipe-format parser (`parsePipeInvoice` in
   [`convex/lib/parse.ts`](../convex/lib/parse.ts)) if no provider returns lines.
   That terminal fallback is why the pipeline always completes, even with no keys.
3. **Verify.** `reconcileLine` recomputes each line's total as `quantity × unitPrice`
   and compares it to the printed total within a small tolerance. The model's
   arithmetic is never trusted.
4. **Reconcile.** Each line is matched to its PO line and catalog rate — exact SKU
   first, otherwise a fuzzy description match via token overlap — and the variance
   against each baseline is computed.
5. **Flag.** Severity only escalates: a failed math check or a price well over a
   baseline (red threshold ~10%) is **red**; a smaller overage (~3%), a missing
   match, or low extraction confidence is **yellow**. The recoverable-dollar figure
   is computed against the *lower* of the two baselines, and only when the price is
   actually over — a conservative, defensible number. Every flag carries a
   plain-language reason.
6. **Review.** A reactive dashboard (`app/app/page.tsx`) shows results live. A
   reviewer approves, rejects, or corrects a line; `correctLine` re-runs the same
   `reconcileLine` on the corrected numbers and records the edit as a labeled signal.
7. **Evaluate.** `runEval` ([`convex/evals.ts`](../convex/evals.ts)) scores the flag
   engine's precision and recall against a labeled set — the gate to run before
   changing a threshold, prompt, or model.

### A concrete example

A PO agrees copper cable at $0.78/ft. An invoice bills it at $0.95/ft for 1,000 ft.
The model reads it as one line; `reconcileLine` recomputes `1000 × 0.95 = $950`
(matches the printed total, so the math check passes), then flags **red** because
$0.95 is ~22% over $0.78, with a recoverable estimate of `(0.95 − 0.78) × 1000 =
$170`. A line whose printed total ≠ quantity × price trips the math check; a fee that
matches nothing in the PO is flagged for review because its rate cannot be verified.

## The data model

Tables in `schema.ts`, every one carrying an `orgId` and a `by_org` index:
- **`purchaseOrders`** — the agreed line items (the "should pay" baseline), with the
  lines nested in the document.
- **`catalog`** — market/reference rates per item (the "should cost" baseline).
- **`invoices` / `invoiceLines`** — the documents and their extracted lines. An
  `invoiceLines` row stores *what the model read* (description, sku, quantity,
  unitPrice, claimedExtension, confidence, sourceQuote) and *what code computed*
  (computedExtension, mathOk, poUnitPrice, catalogPrice, matchedBy, variance fields,
  flag, reasons, recoverableUsd) as separate fields — the read/decide boundary made
  explicit on disk.
- **`settings` / `logs` / `evalRuns`** — per-tenant routing config, an event log, and
  scored evaluation history.

Multi-tenancy is structural: `requireOrg`/`optionalOrg` derive the tenant from the
verified JWT (`org_id`, else a per-user id), and every read filters through the
`by_org` index, so one tenant cannot read another's rows.

## Design decisions worth noting

- **Why a model at all, if code decides?** Reading arbitrary invoice layouts into
  structured fields is what code is bad at and models are good at; the split plays to
  each.
- **Why the deterministic fallback?** It guarantees the product runs on real data
  with zero config and zero cost, and makes behavior reproducible for tests — the
  model is an accelerator, not a dependency.
- **Why measure the flag engine separately?** Accuracy that touches money should be
  demonstrated on labeled data, not asserted; `evals.ts` is the regression gate.
- **Why a browser-side local-model path?** A cloud backend can't reach a model on a
  reviewer's laptop, but the browser can ([`app/lib/ollama.ts`](../app/lib/ollama.ts)
  probes `localhost` and posts the result via `submitExtraction`), while the cloud
  still performs all the deterministic reconciliation.

## Key properties

- **Multi-tenant** — every record scoped to an organization, every read filtered by it.
- **Reactive** — the UI is a live projection of the database.
- **Degrades gracefully** — extraction falls back local → paid → free → deterministic.
- **Measured, not asserted** — flag-engine accuracy is scored on labeled data.
- **Runs on real data** — the seeded sample is synthetic; the same pipeline runs on
  any uploaded contract and invoices.

## Code map

| Concern | File |
|---|---|
| Decision engine (math, matching, flags, recoverable) | [`convex/lib/reconcile.ts`](../convex/lib/reconcile.ts) |
| Extraction + provider routing | [`convex/lib/llm.ts`](../convex/lib/llm.ts) |
| Deterministic parser / shared types | [`convex/lib/parse.ts`](../convex/lib/parse.ts) |
| Queries + mutations (incl. tenant scoping, write path) | [`convex/invoices.ts`](../convex/invoices.ts) |
| The model-calling action | [`convex/extract.ts`](../convex/extract.ts) |
| Schema + indexes | [`convex/schema.ts`](../convex/schema.ts) |
| Auth trust anchor | [`convex/auth.config.ts`](../convex/auth.config.ts) |
| Eval scoring | [`convex/evals.ts`](../convex/evals.ts) |
| Dashboard / upload UI | [`app/app/page.tsx`](../app/app/page.tsx) |
| Browser→host local-model path | [`app/lib/ollama.ts`](../app/lib/ollama.ts) |

## Stack

Next.js + React (web app), Convex (database, functions, realtime, scheduler), Clerk
(auth and organizations), and a configurable language-model provider for extraction,
with a deterministic parser as the offline fallback.
