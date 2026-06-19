# trueline — Overview

A high-level description of what trueline is and how it is shaped. For the
line-level tour see [`WALKTHROUGH.md`](./WALKTHROUGH.md); for the system design see
[`ARCHITECTURE.md`](./ARCHITECTURE.md); for hosting see [`DEPLOYMENT.md`](./DEPLOYMENT.md).

## What it is

trueline verifies vendor invoices against the contract they are billed under. It
reads each line item off an invoice, recomputes the arithmetic, compares every
unit price to the agreed purchase order and to market/catalog rates, flags the
lines that are over, estimates the recoverable dollars, and routes the flagged
lines to a human for approval or correction.

## The core principle

The language model only **reads** the document into structured data — line items,
quantities, prices, and a confidence score. It never does arithmetic and never
decides whether a line is an overcharge. Every calculation and every flag is made
by deterministic code that can be read, tested, and defended. The model reads; the
code decides. This split is the product's central claim, and it is enforced
structurally throughout the system.

## The three planes

trueline is not one server. It is three independently managed services:

- **Web app (Next.js)** — the marketing page and the signed-in workspace. Renders
  the UI and talks to the backend. Holds no model keys.
- **Backend (Convex)** — the database, all server functions, the scheduler, and the
  one external step that calls a language model. All model keys live here.
- **Auth (Clerk)** — sign-in, organizations, and the signed token the backend
  trusts. The organization id in that token scopes every row in the database.

They are joined by a public backend URL and a signed token. The browser connects to
the backend over a live websocket, so the interface always reflects the current
state of the data without polling.

## How it works

1. **Upload.** A reviewer uploads a contract (the purchase order) and one or more
   vendor invoices.
2. **Extract.** A language model reads each invoice into structured line items. If
   no model is configured, a deterministic parser produces the same shape, so the
   pipeline always completes.
3. **Verify.** Code recomputes each line's total (quantity × unit price) and checks
   it against the printed total.
4. **Reconcile.** Each line is matched to its purchase-order line and catalog rate
   (by SKU, else by description), and the price variance against each is computed.
5. **Flag.** Each line is marked green, yellow, or red, with a recoverable-dollar
   estimate for the overcharges and a plain-language reason for every flag.
6. **Review.** A reactive dashboard shows the results live. A reviewer approves,
   rejects, or corrects each line; a correction re-runs the same checks.
7. **Evaluate.** A scoring step measures the flag engine's precision and recall on a
   labeled set — the gate to run before changing a threshold, prompt, or model.

## The data, at a glance

- **Purchase orders** — the agreed line items an invoice is billed against (the
  "should pay" baseline).
- **Catalog** — market/reference rates per item (the "should cost" baseline).
- **Invoices and invoice lines** — the uploaded documents and their extracted lines.
  Each line stores both what the model read and what the code computed, kept as
  separate fields so the boundary between the two is explicit.
- **Settings, logs, eval runs** — per-tenant routing configuration, an event log,
  and the history of scored evaluation runs.

## Key properties

- **Multi-tenant.** Every record is scoped to an organization, and every read is
  filtered by that scope, so one tenant cannot see another's data.
- **Reactive.** The UI subscribes to the backend; any change is pushed to every
  open view automatically.
- **Degrades gracefully.** Extraction routes from a local model to a paid provider
  to a free provider to a deterministic parser, so the app runs end to end with no
  keys and no network.
- **Measured, not asserted.** The flag engine's accuracy is scored on labeled data
  rather than claimed.
- **Runs on real data.** The seeded sample is synthetic, but the same pipeline runs
  on any uploaded contract and invoices.

## Stack

Next.js + React (web app), Convex (database, functions, realtime, scheduler), Clerk
(auth and organizations), and a configurable language-model provider for extraction.
