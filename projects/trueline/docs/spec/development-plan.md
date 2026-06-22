# trueline — Development Plan

Spec: [`spec.md`](./spec.md). Current system: [`ARCHITECTURE.md`](../ARCHITECTURE.md)
and [`DEPLOYMENT.md`](../DEPLOYMENT.md). Checkboxes reflect what is built and live.

## Phase 0 — MVP ✅

- [x] Next.js (App Router) + Convex + Clerk scaffold; Render + Convex deploy wiring.
- [x] Schema with the trust boundary on disk: `invoiceLines` splits LLM-read fields
      (description, sku, qty, unit price, confidence, source quote) from code-decided
      fields (recomputed total, math-ok, matched PO/catalog prices, variance, flag,
      recoverable $). Every table `orgId`-scoped with a `by_org` index.
- [x] Deterministic engine `convex/lib/reconcile.ts` (`reconcileLine`): recompute math,
      SKU-then-fuzzy matching, variance, green/yellow/red, recoverable $.
- [x] Request lifecycle: upload (mutation) → extract (action, the LLM call) → reconcile
      → write results in one mutation, idempotent (clear-then-reinsert by invoice id).
- [x] Guided dashboard (download → upload contract → upload invoice → review) +
      per-invoice reconciliation view.
- [x] Multi-tenancy: `orgId` derived server-side from the Clerk token; `auth.config.ts`
      trusts the issuer.
- [x] Deterministic offline parser so the pipeline completes with zero keys.

## Phase 1 — LLM routing & local models ✅

- [x] Routing modes (auto / local / paid / free / offline) with honest provider/model
      labels; per-tenant `settings`.
- [x] Browser→host Ollama bridge: the cloud action can't reach `localhost`, so the
      browser extracts locally and posts structured lines back (`submitExtraction`).
- [x] Free hosted model wiring (OpenRouter) as the server fallback.
- [x] **Local model autodetect** (`pickOllamaModel`): probe returns the models Ollama
      actually has installed and pick a usable one, so local doesn't 404 on a guessed
      name and silently fall back; explicit fallback reasons surfaced to the user.

## Phase 2 — Observability & evaluation ✅

- [x] Diagnostics: request traces, event log, and a model benchmark across routing
      modes (local row exercised via the browser→host bridge).
- [x] Evals page reframed into two distinct groups: **Engine regression** (a fixed,
      hand-labeled 18-invoice benchmark scoring flag precision/recall, independent of
      uploads — `convex/lib/benchmark.ts` / `scoreBenchmark()`) and **Your processed
      invoices** (live math-consistency over the tenant's own lines).
- [x] Eval auto-runs async on load; identical auto-runs dedupe; a manual **Re-run**
      records a row, so the regression history accumulates deliberate runs.
- [x] vitest suite over the engine (`tests/reconcile.test.ts`) and the benchmark
      (`tests/benchmark.test.ts`); benchmark numbers pinned (n=18, P=R=1.00,
      math-consistency=0.871). `npm run verify` = lint && typecheck && test && check:docs.

## Phase 3 — Review loop & UX ✅

- [x] Re-editable per-line decisions (approve / edit / reject any number of times) with
      a clear active state.
- [x] Correcting an **unlisted** line accepts the entered rate as a manual baseline →
      the line verifies green ("rate accepted by reviewer") instead of staying yellow.
- [x] Light/dark/system theme toggle.
- [x] One consistent **outlined Button** system (hover lift + on-click press) applied to
      every clickable control; uploads consolidated into a single fixed action bar.

## Phase 4 — Demo realism & hardening ✅

- [x] Fixed reconcile bugs: cross-SKU price borrowing (fuzzy fallback gated to no-SKU
      lines) and threshold rounding at the 3% / 10% boundaries; covered by tests.
- [x] Demo invoices load through the **real** LLM pipeline (local → server), not a
      deterministic pre-bake; baseline seeded server-side, invoices extracted via the
      same path an upload uses.
- [x] Persistent demo lifecycle (`tenantState.demoInitialized`): auto-seed fires once
      per tenant and a **Reset stays reset** across navigation.
- [x] Public docs (OVERVIEW / ARCHITECTURE / API / WALKTHROUGH) kept in sync; multiple
      sample upload sets for exercising real behavior.

## Current state

Live and multi-tenant. The LLM reads; deterministic, unit-tested code decides every
number and flag. Routing degrades local → paid → free → offline with honest labels and
autodetected local models. Accuracy is measured by a fixed regression benchmark
(separate from a live per-tenant math-consistency readout). First load seeds a real,
LLM-extracted demo; Reset is durable. `npm run verify` is green.

## Roadmap (proposed improvements)

Grouped by theme, roughly in priority order. Complements [`ARCHITECTURE` §11](../ARCHITECTURE.md).

### Extraction rigor (trust the read more)
- [ ] **Measure mock-vs-LLM extraction accuracy.** We don't yet know if LLM extraction
      beats the deterministic parser, or where. Score both — field-level (qty / unitPrice
      / extension / description / SKU) against a labeled, **multi-format** corpus
      (`sample-data/`: pipe, CSV, printed table, markdown, prose) — and report accuracy
      per format. The pipe mock extracts nothing on CSV/printed/prose and *silently
      mis-parses* markdown, so the LLM's value is format-dependent; quantify it.
- [ ] **Justify the LLM on cost & performance.** Record per-invoice latency and (cloud)
      cost alongside the accuracy lift, and choose the routing default from the data — the
      LLM should only be the default on formats the parser can't read; for clean pipe/CSV
      the deterministic path may be the right (free, instant) choice.
- [ ] **LLM contract (PO) parsing.** `parsePoText` is deterministic/pipe-only, so non-pipe
      contracts won't load; route contracts through the same extraction path as invoices.
- [ ] **Schema-validated extraction with retry.** Validate the model's JSON against a
      strict schema (Convex validator / zod) and re-prompt on malformed output instead
      of best-effort parsing.
- [ ] **Grounding enforcement.** Require each line's `sourceQuote` to actually appear in
      the invoice text; down-rank/flag ungrounded lines so a hallucinated line is caught.
- [ ] **Second-pass / self-consistency verification.** Re-extract (or extract with a
      second model) and diff; disagreement routes the line to human review.
- [ ] **PDF / image + OCR ingest.** Accept real PDFs/scans, OCR to text, feed the
      existing extractor — replacing the pipe-delimited format.
- [ ] **Richer line semantics.** Tax, freight, discount lines; unit-of-measure
      conversion; partial-quantity / split-shipment; multi-currency normalization.
- [ ] **Editable quantity** (today only unit price is correctable).

### Multiple contracts (processing & persistence)
- [ ] **Persist many POs/contracts per tenant** and auto-select the right baseline for
      an invoice by PO number + vendor (today one active baseline at a time).
- [ ] **Contract versioning / amendments** with effective dates.
- [ ] **Catalog management UI** (today the market catalog is seeded, not editable).
- [ ] **Bulk invoice upload + batch reconcile**, with a queue and progress.

### Auth & social providers
- [ ] **More social logins** (Google / GitHub / Microsoft) and **org SSO/SAML** via
      Clerk.
- [ ] **Org roles & permissions** — approver vs viewer; gate approve/reject/correct by
      role; record who did what.

### LLM providers & routing
- [ ] **More providers** (Anthropic, OpenAI, Azure, Bedrock) with **per-tenant keys**
      and cost/quality-aware routing.
- [ ] **Streaming extraction** with incremental UI and per-line confidence as it lands.
- [ ] **Semantic line matching (embeddings)** replacing token-overlap, deterministic
      matcher kept as fallback.

### Testing, regression & CI
- [ ] **CI gate** running `verify` + the benchmark on every PR; fail the build if flag
      precision/recall regress below a threshold.
- [ ] **Adversarial extraction eval** — malformed/ambiguous/obfuscated invoices — and an
      honest recall number (don't advertise a number the labeled set guarantees).
- [ ] **Expand unit coverage:** `parse.ts`, the LLM JSON coercion (`llm.ts`),
      `stats`/math-consistency, and the manual-baseline correction path.
- [ ] **Property-based tests** for the reconcile thresholds and recoverable-$ selection.
- [ ] **Smoke tests** that hit the deployed Convex functions over real calls
      (create → extract-offline → reconcile → eval) so the deploy is verified, not assumed.
- [ ] **E2E (Playwright)** for upload → reconcile → review → approve.
- [ ] **Persisted regression trend** — chart `evalRuns` over commits; confusion-matrix
      view on the eval page; per-tenant threshold tuning gated by the benchmark.

### Robustness & security
- [x] **`submitExtraction` status guard (HIGH).** Resolved: rejects client-submitted
      lines unless the invoice is still `extracting`, so a client can't clobber an
      already-reviewed/approved invoice.
- [ ] **Input limits & validation** — file size/type caps, max line counts, rate limits.
- [ ] **Immutable decision audit log** (who approved/edited/rejected, when) beyond the
      current per-line decision fields.

### Workflow & integrations
- [ ] **Dispute export** (CSV/PDF) and a dispute status workflow.
- [ ] **AP-system / webhook integration** to push approved corrections downstream.
- [ ] **Per-invoice "re-extract with model"** action (re-run a seeded/old invoice
      through the current routing).

## Code review backlog (from `/docs/code-review/trueline.md`, 2026-06-18)

Grade **A−** (multi-tenancy isolation scrutinized, came back clean).

- [x] **HIGH — no tests.** Resolved: vitest suite over `reconcileLine` (boundaries,
      SKU-vs-fuzzy, thresholds, recoverable $) + the benchmark (22 cases).
- [x] **HIGH — `submitExtraction` trust boundary.** Resolved: the mutation now rejects
      unless the invoice is still `extracting`, so a client can't re-submit lines onto
      an already-reviewed/approved invoice.
- [ ] **LOW — `MATH_TOL` mislabel.** Effective tolerance is ~1.5¢ (`MATH_TOL + 0.005`),
      not the documented 1¢; reconcile the constant and comment.
- [ ] **LOW — duplicated org derivation.** `requireOrg`/`optionalOrg` are shared in
      `invoices.ts`, but `evals.ts` still has its own copy; consolidate.
- [ ] **LOW — N+1 in `listInvoices`.** Still a per-invoice line fetch; denormalize the
      flag counts onto the invoice (or batch).
