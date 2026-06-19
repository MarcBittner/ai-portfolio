# trueline — Overview

A description of what trueline is, the problem it solves, and how it is shaped.
This sits between the one-paragraph pitch and the line-level
[`WALKTHROUGH.md`](./WALKTHROUGH.md). For system design see
[`ARCHITECTURE.md`](./ARCHITECTURE.md); for hosting see [`DEPLOYMENT.md`](./DEPLOYMENT.md).

## The problem

Vendors are paid against a contract — a purchase order that fixes the agreed unit
price for each item. Invoices then arrive over weeks or months, and the prices on
them drift: a line is billed above the agreed rate, a quantity is multiplied wrong,
a fee appears that the contract never authorized. Catching this by hand means a
person reading every line of every invoice against the PO and a rate sheet. It does
not scale, so most overcharges are simply paid.

trueline automates the read-and-check, but with a hard rule about *what* is
automated and *how*.

## The core principle

**The language model only reads. Deterministic code decides.**

The model's sole job is to turn an invoice — which may be messy text — into
structured line items: description, SKU, quantity, unit price, the printed line
total, and a confidence score. It never does arithmetic, and it never decides
whether a line is an overcharge. Every calculation and every flag is produced by
plain, deterministic code that can be read, unit-tested, and defended to a vendor.

This matters because the failure modes of a language model — hallucinated numbers,
arithmetic mistakes, inconsistent judgment — are exactly the things you cannot have
in a process that disputes money. By confining the model to reading and putting all
decisions in code, the trustworthy part stays trustworthy regardless of which model
(or no model) did the reading. The data model and the request path both enforce
this split, rather than leaving it as a convention.

## The three planes

trueline is not one server. It is three independently deployed services:

- **Web app — Next.js.** The public marketing page and the signed-in workspace.
  Server-renders the UI and runs the interactive client. It holds the *public*
  database URL and the auth keys; it never holds a model key.
- **Backend — Convex.** The database, every server function (reads, writes, and the
  one external action that calls a model), the scheduler, and realtime. **All model
  keys live here**, because this is the only place a model is called.
- **Auth — Clerk.** Sign-in, organizations, and the signed token (JWT) the backend
  trusts. The organization id inside that token is what scopes every row.

How they connect:
- Signing in produces **two** credentials from one login: a **session cookie** that
  proves to the web app you are logged in (it gates the workspace), and a **signed
  JWT** that the backend verifies cryptographically and reads your organization id
  from. The cookie gets you through the door; the JWT authorizes your data.
- The browser holds one **websocket** to the backend for the life of the tab. Reads
  are live subscriptions over that socket: when data changes, the new result is
  pushed to every open view. There is no polling and no manual refresh.

## How it works, end to end

1. **Upload.** A reviewer uploads a contract (the purchase order) and one or more
   vendor invoices. The contract becomes the baseline; a market/catalog rate sheet
   is the second baseline.
2. **Extract.** A model reads each invoice into structured line items. Extraction is
   routed — a local model on the reviewer's machine, then a paid provider, then a
   free provider, and finally a deterministic parser. The last step means the
   pipeline always completes, even with no keys and no network.
3. **Verify.** Code recomputes each line's total as quantity × unit price and
   compares it to the printed total within a small tolerance. The model's arithmetic
   is never trusted.
4. **Reconcile.** Each line is matched to its purchase-order line and its catalog
   rate — by exact SKU first, otherwise by a fuzzy match on the description — and
   the price variance against each baseline is computed.
5. **Flag.** Each line is marked green, yellow, or red. A failed math check or a
   price well over a baseline is red; a missing match or low extraction confidence
   is yellow. The recoverable-dollar figure is computed conservatively, against the
   *lower* of the two baselines and only when the price is actually over — so the
   number is defensible. Every flag carries a plain-language reason.
6. **Review.** A reactive dashboard shows the results live. A reviewer approves,
   rejects, or corrects each line. A correction re-runs the same deterministic
   checks and is recorded as a labeled signal.
7. **Evaluate.** A scoring step measures the flag engine's precision and recall on a
   labeled set — the gate to run before changing a threshold, prompt, or model, so a
   tweak that helps one invoice cannot quietly regress the rest.

### A concrete example

Given a purchase order that agrees copper cable at $0.78/ft, an invoice billing that
cable at $0.95/ft for 1,000 ft is read by the model as one line, recomputed by code
(`1000 × 0.95 = $950`, which matches the printed total, so the math is fine), and
then flagged **red** because $0.95 is ~22% over the agreed $0.78. The recoverable
estimate is the overcharge against the lower baseline: `(0.95 − 0.78) × 1000 = $170`.
A second line whose printed total doesn't equal quantity × price trips the math
check; a line for a fee that matches nothing in the contract is flagged for review
because its rate cannot be verified.

## The data model

- **Purchase orders** — the agreed line items an invoice is billed against (the
  "should pay" baseline), with the line items stored inside the order.
- **Catalog** — market/reference rates per item (the "should cost" baseline).
- **Invoices and invoice lines** — the uploaded documents and their extracted lines.
  Each line stores both *what the model read* (description, quantity, unit price,
  printed total, confidence, a verbatim source quote) and *what the code computed*
  (recomputed total, math-ok flag, matched prices, variances, the flag, the reasons,
  and recoverable dollars) as separate fields, so the boundary between the two is
  explicit on disk.
- **Settings, logs, eval runs** — per-tenant routing configuration, an event log,
  and the history of scored evaluation runs.

Every record carries an organization id and is read through an index on it, which
is how one tenant is prevented from seeing another's data.

## Design decisions worth noting

- **Why a model at all, if code decides everything?** Reading arbitrary invoice
  layouts into structured fields is the part deterministic code is bad at and
  models are good at. The split plays to each.
- **Why the deterministic fallback?** It guarantees the product works on real data
  with zero configuration and zero cost, and it makes the system's behavior
  reproducible for testing — the model is an accelerator, not a dependency.
- **Why measure the flag engine separately?** Because accuracy that touches money
  should be demonstrated on labeled data, not asserted; the eval is the regression
  gate for any change to the decision logic.
- **Why browser-side local models?** A cloud backend cannot reach a model running on
  a reviewer's laptop, but the reviewer's browser can — so the read can happen
  locally and privately, while the cloud still performs all the deterministic
  reconciliation.

## Key properties

- **Multi-tenant** — every record is scoped to an organization and every read is
  filtered by it.
- **Reactive** — the UI is a live projection of the database; changes push to every
  open view.
- **Degrades gracefully** — extraction falls back from local → paid → free →
  deterministic, so the app always completes.
- **Measured, not asserted** — the flag engine's accuracy is scored on labeled data.
- **Runs on real data** — the seeded sample is synthetic, but the same pipeline runs
  on any uploaded contract and invoices.

## Stack

Next.js + React (web app), Convex (database, functions, realtime, scheduler), Clerk
(auth and organizations), and a configurable language-model provider for extraction,
with a deterministic parser as the offline fallback.
