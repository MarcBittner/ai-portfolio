# trueline — API Reference

trueline's API is its **Convex function surface**, not a REST API. The web client
calls these functions by typed reference (`api.<module>.<fn>`) over a websocket;
Convex generates the types from the function definitions, so calls are checked at
compile time. There is no separate HTTP API server.

**Authentication.** Every call carries the caller's Clerk JWT (attached by
`ConvexProviderWithClerk`). Functions read the verified identity via
`ctx.auth.getUserIdentity()` and derive the tenant as the `org_id` claim, or
`user:<subject>` when the caller has no organization.

**Tenancy.** All data is scoped to the tenant. Write functions reject
unauthenticated calls; read functions return an empty result when identity has not
yet propagated. Cross-tenant access is impossible: every row read is filtered
through a `by_org` index, and per-document operations re-check `orgId`.

**Function kinds.**
- **Query** — reactive, read-only. Called with `useQuery`; the result updates live.
- **Mutation** — a single transactional write. Called with `useMutation`.
- **Action** — the only kind permitted external I/O (the model call). Called with
  `useAction`.

Source: [`convex/invoices.ts`](../convex/invoices.ts),
[`convex/routing.ts`](../convex/routing.ts), [`convex/evals.ts`](../convex/evals.ts),
[`convex/diagnostics.ts`](../convex/diagnostics.ts),
[`convex/extract.ts`](../convex/extract.ts).

---

## Contents

- [Queries (reactive reads)](#queries-reactive-reads)
- [Mutations (transactional writes)](#mutations-transactional-writes)
- [Actions (external I/O)](#actions-external-io)
- [Internal functions](#internal-functions)
- [Local-model path](#local-model-path)

---

## Queries (reactive reads)

| Function | Arguments | Returns |
|---|---|---|
| `api.invoices.listInvoices` | — | Array of invoices for the tenant, each with `lineCount` and `red` / `yellow` / `green` flag counts, newest first. |
| `api.invoices.getInvoice` | `{ invoiceId }` | `{ invoice, lines }` (lines ordered by `lineNo`), or `null` if missing or owned by another tenant. |
| `api.invoices.stats` | — | `{ invoices, recoverableUsd, needsReview, latestEval }` — tenant rollups for the dashboard. |
| `api.invoices.baseline` | — | `{ hasPo, poLines, poNumber, vendor }` — whether a contract has been loaded. |
| `api.invoices.recentLogs` | — | The 60 most recent event-log rows for the tenant. |
| `api.routing.get` | — | `{ mode, model, keys, localUrl, defaultLocalModel, defaultFreeModel, defaultPaidModel, activeMode }` — routing config + which provider keys are present. |
| `api.evals.listEvals` | — | The 10 most recent evaluation runs, newest first. |

## Mutations (transactional writes)

| Function | Arguments | Returns / effect |
|---|---|---|
| `api.invoices.seedIfEmpty` | — | Seeds a demo PO, catalog, and three reconciled invoices if the tenant is empty. Idempotent. Returns `{ seeded }`. |
| `api.invoices.createInvoiceFromText` | `{ invoiceNumber, rawText, poNumber?, deferServer? }` | Inserts an invoice with status `extracting`. If `deferServer` is false, schedules the server extraction action; if true, the browser handles extraction. Returns the new `invoiceId`. |
| `api.invoices.scheduleExtract` | `{ invoiceId }` | Schedules the server extraction action (the fallback when browser-side extraction is unavailable). |
| `api.invoices.submitExtraction` | `{ invoiceId, provider, model, latencyMs?, lines[] }` | Accepts line items extracted in the browser, reconciles and writes them, and sets status `needs_review`. `lines[]` items: `{ description, sku?, quantity, unit, unitPrice, extension, confidence, sourceQuote }`. |
| `api.invoices.setBaselineFromText` | `{ rawText, poNumber? }` | Parses an uploaded contract into the PO baseline (and seeds the catalog if absent). Returns `{ poLines }`. Throws if no line items are found. |
| `api.invoices.reviewLine` | `{ lineId, decision }` | Records a human decision on a line. `decision`: `"approved"` \| `"rejected"`. |
| `api.invoices.correctLine` | `{ lineId, unitPrice, quantity? }` | Applies a corrected price/quantity, re-runs the deterministic reconcile on the line, and marks it `edited`. |
| `api.invoices.setInvoiceStatus` | `{ invoiceId, status }` | Sets the invoice status. `status`: `"approved"` \| `"rejected"` \| `"needs_review"`. |
| `api.invoices.resetDemo` | — | Clears all of the tenant's invoices, lines, POs, catalog, and eval runs. Returns `{ cleared }`. |
| `api.routing.set` | `{ mode, model? }` | Saves the tenant's extraction routing. `mode`: `"auto"` \| `"local"` \| `"free"` \| `"paid"` \| `"offline"`. Returns `{ ok }`. |
| `api.evals.runEval` | — | Scores the flag engine (precision / recall / math-consistency) on the labeled set and stores an `evalRuns` row. Returns the run. |

## Actions (external I/O)

| Function | Arguments | Returns |
|---|---|---|
| `api.diagnostics.benchmark` | `{ invoiceText }` | Runs the given invoice through every routing mode (`offline`, `local`, `free`, `paid`) and returns, per mode, `{ mode, provider, model, latencyMs, lines, error }`. Called with `useAction`. |

---

## Internal functions

These are server-only (`internal.*`) and are **not** part of the client API — they
are invoked by the scheduler or by other server functions, never from the browser:

- `internal.extract.run` — the scheduled extraction action: reads the invoice text,
  calls the model (or the deterministic fallback), and writes results in one
  mutation.
- `internal.extract._getRaw` — reads an invoice's raw text for the action.
- `internal.routing._forExtract` — reads a tenant's routing config for the action.
- `internal.invoices.writeResults` — reconciles + writes extracted lines (one
  transaction).
- `internal.invoices.markError` — records an extraction failure on the invoice.
- `internal.invoices.appendLog` — appends an event-log row.

---

## Local-model path

When routing is `auto` or `local`, the browser may extract using a model on the
caller's machine. It probes `localhost` ([`app/lib/ollama.ts`](../app/lib/ollama.ts)),
and on success calls `submitExtraction` with the resulting lines; the cloud backend
still performs all reconciliation. If no local model is reachable, the client calls
`scheduleExtract` and the server action takes over. See
[`WALKTHROUGH.md`](./WALKTHROUGH.md) [§16](./WALKTHROUGH.md#16-branch-a-browserhost-ollama) for the full path.
