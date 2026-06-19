# trueline — Development Plan

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) and [`DEPLOYMENT.md`](./DEPLOYMENT.md) for the current system.

## Code review backlog (from `/docs/code-review/trueline.md`, 2026-06-18) — NOT YET DONE

Grade **A−** (multi-tenancy isolation was scrutinized and came back clean). Prioritized fixes; full detail + `file:line` in the review.

- [ ] **HIGH — no tests.** The pure, money-deciding `convex/lib/reconcile.ts` is the textbook unit-test target and has zero coverage, which undercuts the "code decides the money" thesis. Add a vitest suite starting with `reconcileLine` boundary cases (math tolerance, sku-vs-fuzzy match, the red/yellow thresholds, recoverable-$ at the lower baseline), then the LLM JSON coercion.
- [ ] **HIGH — `submitExtraction` trust boundary.** The browser→host path accepts client-supplied line data and writes it with no `status` guard, so a client can re-submit an already-`approved` invoice and clobber reviewer decisions. Reject unless the invoice is still `extracting`; guard the status transition.
- [ ] **LOW — `MATH_TOL` mislabel.** Effective tolerance is ~1.5¢, not the documented 1¢ (`MATH_TOL + 0.005` in `reconcile.ts`); fix the constant or the comment.
- [ ] **LOW — duplicated org derivation** across ~4 files; extract a shared `requireOrg`/`optionalOrg` helper.
- [ ] **LOW — N+1 in `listInvoices`** (per-invoice line fetch); denormalize flag counts onto the invoice or batch.

## v0.2 (future)
- PDF/OCR invoice ingest (currently pipe-delimited text only).
- Embedding-based line matching (currently token overlap).
