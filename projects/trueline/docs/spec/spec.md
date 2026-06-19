# trueline — Specification

## Overview

trueline verifies vendor invoices against the purchase order (PO) and a catalog of
market rates. An LLM **reads** the invoice into structured line items; deterministic
TypeScript **decides** everything that touches money — it recomputes the math, matches
each line to the PO and catalog, computes variance, flags green/yellow/red, and
estimates recoverable dollars. The model reads; the code decides.

Built deliberately on the stack it targets: **Next.js (App Router) + Convex + Clerk +
an LLM**, multi-tenant and reactive. It runs with **zero paid accounts** — local
Ollama (reached from the browser), a free hosted model, or a deterministic offline
parser. The live link is in [`../../README.md`](../../README.md); deeper docs:
[`OVERVIEW`](../OVERVIEW.md) · [`ARCHITECTURE`](../ARCHITECTURE.md) ·
[`API`](../API.md) · [`WALKTHROUGH`](../WALKTHROUGH.md) · [`DEPLOYMENT`](../DEPLOYMENT.md).

## Goals

- Demonstrate a trustworthy LLM-in-the-loop money workflow where the model never
  decides a number — every figure and flag is deterministic, testable code.
- Be production-shaped: multi-tenant, reactive, observable, with a CI-style
  regression gate on the decision engine.
- Run for a reviewer with no keys, via documented fallbacks.

## Non-goals (current scope)

- Not an AP/ERP system; it surfaces disputes, it does not execute payments.
- Pipe-delimited **text** ingest only — PDF/OCR is on the roadmap.
- One active PO/contract baseline per tenant at a time — multi-contract is roadmap.

## Functional requirements

- **FR-1 — Contract intake.** Upload a PO/contract (text) → parsed deterministically
  into the baseline and seeds a market catalog.
- **FR-2 — Invoice extraction.** Upload an invoice (text) → an LLM extracts line items
  (description, sku, quantity, unit price, extension, per-line confidence, a verbatim
  source quote). The model only reads values present in the document.
- **FR-3 — Deterministic reconciliation.** Per line: recompute `qty × unitPrice`
  (≈1.5¢ tolerance); match the PO then catalog by SKU, else a fuzzy description match
  **only when the line carries no SKU** (never borrow another SKU's price); compute
  variance vs each baseline; flag **green / yellow (>3% over) / red (>10% over or a
  math error)**; low-confidence and unmatched lines → yellow; estimate recoverable $
  vs the *lower* baseline.
- **FR-4 — Human-in-the-loop review.** Approve / reject / correct each line, any number
  of times. Correcting an **unlisted** line accepts the entered rate as a manual
  baseline (the line verifies green, "rate accepted by reviewer").
- **FR-5 — LLM routing + graceful degradation.** local Ollama (browser→host) → paid →
  free → deterministic offline. Provider / model / latency / cost are surfaced
  honestly; deterministic offline is a true last resort (only when no model is usable).
- **FR-6 — Engine regression.** A fixed, hand-labeled **18-invoice benchmark** scores
  flag precision/recall (independent of any uploaded data); auto-runs on load, dedupes
  identical auto-runs, and records every manual re-run to a history.
- **FR-7 — Your-data signal.** A live math-consistency readout over the tenant's
  uploaded lines, kept distinct from the fixed benchmark.
- **FR-8 — Observability.** Request traces, an event log, and a model benchmark across
  routing modes (Diagnostics).
- **FR-9 — Multi-tenancy.** Every row is scoped by `orgId` derived **server-side** from
  the Clerk token (org, else per-user); the tenant is never client-supplied.
- **FR-10 — Demo realism.** First load auto-seeds a baseline and runs the demo invoices
  through the **real** extraction pipeline (not pre-baked); Reset clears the tenant and
  stays reset across navigation.

## Non-functional requirements

- **Trust boundary on disk.** `invoiceLines` physically splits what the LLM read from
  what code decided.
- **Reactive.** `useQuery` subscriptions over a websocket; the UI is a live projection
  of the database, no polling.
- **Idempotent writes.** Extraction results are written clear-then-reinsert keyed on
  the invoice id, so a re-run can never double-insert (actions aren't auto-retried).
- **Tested.** vitest over the reconcile engine and the benchmark; a doc-link checker;
  `npm run verify` = lint && typecheck && test && check:docs.

## Data model (summary)

`purchaseOrders`, `catalog`, `invoices`, `invoiceLines` (LLM-read vs code-decided
columns), `logs`, `settings` (per-tenant routing), `evalRuns` (regression history),
`tenantState` (demo lifecycle). Full detail in [`ARCHITECTURE` §3](../ARCHITECTURE.md).

## Security model

Clerk mints a JWT; one Convex `auth.config.ts` declares the trusted issuer, so
`getUserIdentity()` returns verified claims with no DB lookup. `orgId` comes from the
`org_id` claim (else `user:<subject>`); every table has a `by_org` index. Actions are
the only place network I/O happens; the browser never holds a model key for the cloud
path. **Known gap (tracked in the plan):** `submitExtraction` does not yet guard the
invoice status, so a client could re-submit lines onto an already-approved invoice.

## Conventions

- **Convex function types:** `query` (reactive read, no I/O), `mutation` (transactional
  write, no I/O), `action` (the only place external I/O — the LLM call — is allowed).
- **Verify:** `npm run verify` before every commit.
- **Deploy is two-part:** the Next frontend deploys on Render (push to `main`); the
  Convex backend deploys **separately** via `npx convex deploy` (prod
  `giddy-marmot-130`). See [`DEPLOYMENT`](../DEPLOYMENT.md).
- **Docs:** the spec and plan live here in `docs/spec/`; OVERVIEW / ARCHITECTURE / API /
  WALKTHROUGH / DEPLOYMENT live in `docs/`.
