# trueline — Code Review

## Summary
trueline is a well-architected invoice line-item verification app on Next.js + Convex + Clerk with an LLM extraction layer. The central design is sound and clearly intentional: the LLM only *reads* an invoice into a strict JSON shape, while all money-touching logic (math recomputation, PO/catalog matching, variance, flagging, recoverable-dollar estimation) lives in pure, deterministic functions in `convex/lib/reconcile.ts`. Provider routing degrades gracefully (local Ollama → Anthropic → OpenRouter → deterministic offline parser) so the pipeline always completes. The code is clean and readable; the main gaps are the absence of any automated tests around the load-bearing `reconcile.ts`, a couple of correctness bugs in matching/cost logic, and a few multi-tenancy/auth seams worth tightening.

## Architecture notes
- **Clean separation of LLM vs. deterministic logic.** `convex/lib/reconcile.ts` and `convex/lib/parse.ts` are pure (no Convex imports), so they are trivially unit-testable, and the LLM is confined to extraction in `convex/lib/llm.ts`. The schema (`convex/schema.ts:73-100`) mirrors this by separating "what the LLM read" from "what code verified."
- **Idempotent write path.** `insertReconciledLines` (`convex/invoices.ts:60-65`) clears prior lines before re-inserting, and `convex/extract.ts:17-18` keys the non-transactional action on the invoice `_id`, so a re-run can't double-insert. Good handling of Convex's action/mutation transactional boundary.
- **Multi-tenancy by `orgId`.** Every table is indexed by `orgId` and reads filter through it (`convex/schema.ts:4-7`). Read queries use a non-throwing `optionalOrg` (`convex/invoices.ts:36-41`) to avoid white-screening during the Clerk→Convex auth lag.
- **Browser→host Ollama bridge.** `app/lib/ollama.ts` + the `deferServer`/`submitExtraction` path (`convex/invoices.ts:211-301`) lets a cloud backend use a model on the user's machine, with a fallback to the server action.
- **Graceful provider degradation** with a cached reachability probe (`convex/lib/llm.ts:96-108`) and an explicit per-mode attempt order.

## Findings

| # | Severity | Location | Issue | Suggested fix |
|---|----------|----------|-------|---------------|
| 1 | High | `convex/invoices.ts:260-301` (`submitExtraction`) | Line items extracted in the browser are written verbatim with **no server-side validation of the numbers**. The mutation trusts client-supplied `quantity`/`unitPrice`/`extension`/`confidence`. A malicious client can submit arbitrary values; `reconcileLine` recomputes the extension but still trusts qty and unitPrice as ground truth, so flags/recoverable can be spoofed. | Treat browser-submitted lines as untrusted: clamp `confidence` to 0..1 (matching `coerceLines`), reject non-finite numbers, and consider re-reading from `rawText` rather than trusting the client. At minimum, sanitize inputs the way `coerceLines` does in `llm.ts:32-47`. |
| 2 | Medium | `convex/lib/reconcile.ts:98-109` | Catalog fuzzy-match does **not** require the SKU to match when a SKU is present. If `line.sku` is set but no catalog SKU matches, it silently falls through to a description fuzzy-match and can bind to a *different* SKU's market price, producing a wrong variance/recoverable. | When `line.sku` is present and no catalog SKU matches, skip the description fallback (or record `matchedBy: "none"` semantics for the catalog too). |
| 3 | Medium | `convex/lib/reconcile.ts:75` | `mathOk` tolerance is `MATH_TOL + 0.005` = **0.015**, but `MATH_TOL` is documented as "1 cent" (line 40) and the reason string (line 78) implies a 1-cent check. The extra `0.005` silently widens tolerance to 1.5¢ and is unexplained. | Drop the `+ 0.005` or fold it into `MATH_TOL` with a comment; keep the constant and comment in sync. |
| 4 | Medium | `convex/extract.ts:32-34` | The paid-cost estimate hardcodes `$1/Mtok in + $5/Mtok out` (correct for the default `claude-haiku-4-5`), but `DEFAULT_PAID_MODEL` is overridable via `ANTHROPIC_MODEL` (`llm.ts:77`). If an operator points it at a more expensive model, the recorded `costUsd` is silently wrong. | Make per-token rates a function of the model id, or comment that the estimate assumes Haiku-4.5 rates. |
| 5 | Low | `convex/invoices.ts:23-30` vs. `convex/evals.ts:10-19`, `convex/routing.ts:19-23` | The org-derivation logic (`org_id` claim, else `user:${subject}`) is **duplicated four times** with slightly different shapes and a hand-rolled `as unknown as { org_id?: string }` cast. Divergence risk if the tenancy rule changes. | Extract a single `tenantFromIdentity(ctx)` helper into a shared module and reuse. |
| 6 | Low | `app/app/invoices/[id]/page.tsx:217` | The Variance column shows only `varianceVsPoPct` and ignores `varianceVsMarketPct`, yet the flag/recoverable logic uses the *worst* of both (`reconcile.ts:136`). A line flagged red purely on market variance shows a benign PO variance, making the verdict look unexplained. | Display both variances (or the worst one that drove the flag). |
| 7 | Low | `convex/lib/llm.ts:54` & `app/lib/ollama.ts:60` | `parseJsonLoose`/`parseLines` take `text.split("\`\`\`")[1]` — if the model emits a single fence or interleaves prose with multiple fenced blocks, this can grab the wrong segment or `undefined`. | Prefer a regex capturing the first fenced block's body, falling back to brace/bracket slicing. |
| 8 | Low | `convex/extract.ts:19` (`run` action) | On failure the action sets status to `needs_review` with an `error` (`invoices.ts:485-490`); a user sees `needs_review` with zero lines — indistinguishable from a genuinely reviewed-but-empty invoice. | Add an explicit `failed`/`error` status, or surface `inv.error` in the list verdict. |
| 9 | Low | `convex/invoices.ts:227,334` | `createInvoiceFromText` and `setBaselineFromText` hardcode `vendor: DEMO_VENDOR` and default `poNumber` to `DEMO_PO_NUMBER` even for user-uploaded data, so all real uploads inherit demo identifiers. | Parse vendor/PO number from the uploaded text, or accept them as args. |

## Test coverage
There is **no automated test coverage**. `package.json` defines only `lint` and `typecheck` scripts — no test runner is in dependencies, and there are no `*.test.*` / `*.spec.*` files.

This is the most significant gap given the architecture: `convex/lib/reconcile.ts` and `convex/lib/parse.ts` are explicitly written as pure functions "so they're trivially unit-testable" (`reconcile.ts:7`), yet that testability is unused. Highest-value missing tests:
- `reconcileLine`: math tolerance boundary (finding #3), red/yellow/green thresholds, SKU vs. fuzzy matching (finding #2), recoverable-dollar computation against the lower baseline, and the "no match" path.
- `parsePipeInvoice` / `parsePoText`: header-row skipping, `$`/comma stripping, short-row filtering.
- `coerceLines` / `parseJsonLoose`: fenced-JSON extraction and numeric coercion (finding #7).

The app ships a runtime "eval" feature (`convex/evals.ts`) that scores flag precision/recall against `DEMO_EVAL_LABELS` — useful as a regression gate, but it is an in-product mutation over seeded data, not a substitute for unit tests of the engine.

## Recommendations
1. **Add unit tests for `reconcile.ts` and `parse.ts` first.** They are pure and carry all the money logic; this is the cheapest, highest-leverage coverage and would directly catch findings #2 and #3. Add a test runner to `package.json`.
2. **Harden `submitExtraction` (finding #1).** Browser-submitted numbers currently bypass the sanitization that `coerceLines` applies to model output — validate/clamp them server-side.
3. **Fix the matching and tolerance correctness bugs (findings #2, #3).**
4. **Make cost estimation model-aware (finding #4).**
5. **De-duplicate the tenant-derivation logic (finding #5).**
6. **Tighten UX/observability for failures and real uploads (findings #6, #8, #9).**
