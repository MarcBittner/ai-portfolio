# trueline — Capability Map (what the app does, how, and where)

This maps every **thing the product does** to the code that does it. Each entry has four
parts: **What happens** (the business behavior), **How the code works** (the mechanism),
the linked code (`file#Lnnn` — current line; the named function is the stable reference),
and a **Walkthrough** link into the deep-dive narrative for that capability.

System-level view: [`ARCHITECTURE.md`](./ARCHITECTURE.md). Full narrative (every section
linked below): [`WALKTHROUGH.md`](./WALKTHROUGH.md).

## Contents

- [Sign in and isolated workspace](#sign-in-and-isolated-workspace)
- [The guided demo](#the-guided-demo)
- [Load a contract (the baseline)](#load-a-contract-the-baseline)
- [Upload and read an invoice](#upload-and-read-an-invoice)
- [Choose where the model runs](#choose-where-the-model-runs)
- [Reconcile each line](#reconcile-each-line)
- [Flag overcharges and recoverable dollars](#flag-overcharges-and-recoverable-dollars)
- [Review and correct lines](#review-and-correct-lines)
- [Approve or reject an invoice](#approve-or-reject-an-invoice)
- [Prove the engine and show live accuracy](#prove-the-engine-and-show-live-accuracy)
- [See what happened (diagnostics)](#see-what-happened-diagnostics)
- [Configure model routing](#configure-model-routing)
- [App shell, theme, and navigation](#app-shell-theme-and-navigation)

---

## Sign in and isolated workspace

**What happens:** a visitor signs in with Clerk and lands in a workspace containing only
their organization's data — no tenant can see another's invoices.

**How the code works:** the sign-in button on
[`Landing` · app/page.tsx:23](../app/page.tsx#L23) opens Clerk's modal; Clerk mints a JWT.
[`RootLayout` · app/layout.tsx:19](../app/layout.tsx#L19) wraps the app in the Clerk +
Convex providers so every Convex request carries that token. On each request,
[`requireOrg` · convex/invoices.ts:23](../convex/invoices.ts#L23) (or the non-throwing
[`optionalOrg` · :36](../convex/invoices.ts#L36)) calls `getUserIdentity()` — verified
against the issuer declared in [`auth.config.ts:16`](../convex/auth.config.ts#L16) — and
reads the `org_id` claim (falling back to `user:<subject>`). That `orgId` is then the
fixed prefix of every `withIndex("by_org", …)` read and write, enforced by the tables in
[`schema.ts:17`](../convex/schema.ts#L17). Because the id comes from the token, never a
client argument, cross-tenant access is structurally impossible.

**Walkthrough:** [§6 the Clerk flow](./WALKTHROUGH.md#6-clicking-sign-in-the-clerk-flow) ·
[§7 trusting the JWT](./WALKTHROUGH.md#7-authconfigts-how-convex-decides-to-trust-the-jwt) ·
[§9 multi-tenancy](./WALKTHROUGH.md#9-the-backend-reads-optionalorg-requireorg-multi-tenancy) ·
[§2 middleware gating](./WALKTHROUGH.md#2-middlewarets-runs-before-every-request)

## The guided demo

**What happens:** a new tenant lands on a populated, worked example; the demo invoices are
really run through a model (not faked); and "Reset" clears everything and *stays* cleared.

**How the code works:** [`Dashboard` · app/app/page.tsx:155](../app/app/page.tsx#L155)
derives the current step from whether a PO exists and how many invoices there are. A
ref-guarded effect checks [`demoState` · convex/invoices.ts:204](../convex/invoices.ts#L204)
— a persistent `tenantState.demoInitialized` flag — and, only if it's false, calls
[`loadDemo` · app/app/page.tsx:274](../app/app/page.tsx#L274) once.
`loadDemo` calls [`seedDemoBaseline` · convex/invoices.ts:268](../convex/invoices.ts#L268),
which inserts the PO + catalog if absent, flips the flag via
[`markInitialized` · :46](../convex/invoices.ts#L46), and returns the demo invoice texts
that aren't already present — then loops them through the normal upload path so they're
genuinely extracted. [`resetDemo` · :443](../convex/invoices.ts#L443) deletes the tenant's
invoices/lines/PO/catalog/evals and *also* calls `markInitialized`, so the auto-seed effect
won't refire when you navigate back. Sample downloads are
[`download` · app/app/page.tsx:63](../app/app/page.tsx#L63).

**Walkthrough:** [§8 mounting & live queries](./WALKTHROUGH.md#8-app-mounts-and-fires-live-queries) ·
[§10 seeding an empty account](./WALKTHROUGH.md#10-seeding-an-empty-account-seedifempty) ·
[§12 the guided stepper](./WALKTHROUGH.md#12-the-guided-stepper-ui)

## Load a contract (the baseline)

**What happens:** the user uploads a purchase order; it becomes the agreed price list every
invoice line is checked against, and seeds a market-rate catalog.

**How the code works:** [`UploadButton` · app/app/page.tsx:72](../app/app/page.tsx#L72) is a
real button that clicks a hidden file input, reads the file's text, and passes it to
[`uploadContract` · :210](../app/app/page.tsx#L210). That calls
[`setBaselineFromText` · convex/invoices.ts:410](../convex/invoices.ts#L410), which deletes
any existing PO, then inserts a new `purchaseOrders` row whose lines come from
[`parsePoText` · convex/lib/parse.ts:25](../convex/lib/parse.ts#L25) (it splits the
pipe-delimited rows, drops the header and malformed rows, and strips `$`/commas). If no
catalog exists yet it seeds the market rates, and it writes an event-log row.

**Walkthrough:** [§13 uploading a file (the browser side)](./WALKTHROUGH.md#13-uploading-a-file-the-browser-side) ·
[§11 the read/decide data model](./WALKTHROUGH.md#11-the-data-model-schemats--the-readdecide-split-in-tables)

## Upload and read an invoice

**What happens:** the user uploads an invoice; the app reads it into structured line items
with an LLM. The model **only reads** — it never computes or decides.

**How the code works:** [`uploadInvoice` · app/app/page.tsx:219](../app/app/page.tsx#L219)
pulls the invoice number from the filename/text, then records the invoice with status
`extracting` via [`createInvoiceFromText` · convex/invoices.ts:300](../convex/invoices.ts#L300)
(`deferServer` tells it the browser will try the local model first). It then extracts the
lines one of two ways: in the browser against your local model
([`extractWithOllama` · app/lib/ollama.ts:111](../app/lib/ollama.ts#L111), posting the
result back through [`submitExtraction` · convex/invoices.ts:349](../convex/invoices.ts#L349)),
or on the server ([`scheduleExtract` · :336](../convex/invoices.ts#L336) →
[`extract.run` · convex/extract.ts:19](../convex/extract.ts#L19) →
[`extractLineItems` · convex/lib/llm.ts:156](../convex/lib/llm.ts#L156)). Either way the
extracted lines are fed into the deterministic reconciler and written; the no-model fallback
parser is [`parsePipeInvoice` · convex/lib/parse.ts:48](../convex/lib/parse.ts#L48).

**Walkthrough:** [§13 uploading a file](./WALKTHROUGH.md#13-uploading-a-file-the-browser-side) ·
[§14 which route extraction takes](./WALKTHROUGH.md#14-uploadinvoice-decides-which-route-extraction-takes) ·
[§15 `createInvoiceFromText`](./WALKTHROUGH.md#15-createinvoicefromtext-mutation-one-transaction) ·
[§17 the server action](./WALKTHROUGH.md#17-branch-b-the-server-action-extractrun) ·
[§19 parsing messy model output](./WALKTHROUGH.md#19-parsing-messy-model-output-parsets-coerce-loose-json)

## Choose where the model runs

**What happens:** the app prefers your **local** Ollama (no quota, private); if none is
reachable it uses a paid model, then a free one, and only falls back to the deterministic
parser when no model is available anywhere — and it tells you which path it took.

**How the code works:** in the browser,
[`probeOllama` · app/lib/ollama.ts:36](../app/lib/ollama.ts#L36) fetches `/api/tags` on
`localhost:11434` then the `:11435` CORS proxy and returns the reachable URL *plus the
models actually installed*;
[`pickOllamaModel` · :64](../app/lib/ollama.ts#L64) chooses the configured model if Ollama
has it (exact or family match) else the first installed one — so a guessed name can't
silently force a fallback. [`uploadInvoice` · app/app/page.tsx:219](../app/app/page.tsx#L219)
uses the local model when present and otherwise records the exact fallback reason before
deferring to the server. The server's own chain (local-reachable? → paid → free → offline
parser) lives in [`extractLineItems` · convex/lib/llm.ts:156](../convex/lib/llm.ts#L156),
with per-provider calls `callOllama`/`callAnthropic`/`callOpenRouter` just below it.

**Walkthrough:** [§14 which route extraction takes](./WALKTHROUGH.md#14-uploadinvoice-decides-which-route-extraction-takes) ·
[§16 Branch A: browser→host Ollama](./WALKTHROUGH.md#16-branch-a-browserhost-ollama) ·
[§18 provider routing](./WALKTHROUGH.md#18-provider-routing-llmts--extractlineitems)

## Reconcile each line

**What happens:** for every line the app recomputes `qty × unit price`, matches the line to
the contract and the catalog, and computes how far the price is from each baseline — all in
deterministic code, never the model. *This is the product.*

**How the code works:**
[`reconcileLine` · convex/lib/reconcile.ts:66](../convex/lib/reconcile.ts#L66) is a pure
function: it (1) recomputes the extension and sets `mathOk` within ~1.5¢; (2) matches the
PO then catalog by SKU, falling back to a token-overlap description match **only when the
line has no SKU** (so it never borrows another SKU's price); (3) computes the unrounded
variance vs each baseline; (4) flags — math error → red, unmatched → yellow, low confidence
→ yellow, then >10% over → red / >3% → yellow; and (5) estimates recoverable $ as
`(unitPrice − lower baseline) × qty` only when over. An `acceptedUnitPrice` option promotes
an unmatched line a reviewer has priced into a green "manual" match. Results are persisted by
[`insertReconciledLines` · convex/invoices.ts:60](../convex/invoices.ts#L60) and, on the
server path, committed clear-then-reinsert by
[`writeResults` · :546](../convex/invoices.ts#L546) so a re-run can't double-insert.

**Walkthrough:** [§20 reconcile + write](./WALKTHROUGH.md#20-reconcile--write-writeresults--insertreconciledlines) ·
[§21 the trust-critical core (`reconcileLine`)](./WALKTHROUGH.md#21-the-trust-critical-core-reconcileline)

## Flag overcharges and recoverable dollars

**What happens:** each line is flagged green / yellow (3–10% over) / red (>10% over or a math
error) with a recoverable-$ estimate; the invoice shows the totals you can dispute.

**How the code works:** the thresholds and the recoverable-$ math live inside
[`reconcileLine` · convex/lib/reconcile.ts:66](../convex/lib/reconcile.ts#L66) (constants
`RED_PCT`/`YELLOW_PCT`, and the benchmark is `min(poUnitPrice, catalogPrice)`). The stored
flag/`recoverableUsd` per line is rendered by
[`InvoiceReview` · app/app/invoices/[id]/page.tsx:11](../app/app/invoices/[id]/page.tsx#L11),
summarized per row by [`verdictText` · app/app/page.tsx:513](../app/app/page.tsx#L513), and
shown as colored pills by [`FlagBadge` · app/components/ui.tsx:67](../app/components/ui.tsx#L67).

**Walkthrough:** [§21 the trust-critical core](./WALKTHROUGH.md#21-the-trust-critical-core-reconcileline) ·
[§22 the verdict pushes back to the UI](./WALKTHROUGH.md#22-the-verdict-pushes-back-to-the-ui-reactivity)

## Review and correct lines

**What happens:** an estimator can approve, reject, or correct any line — repeatedly.
Correcting an **unlisted** line accepts the entered rate as a reviewer-approved baseline,
turning it green.

**How the code works:** the correct flow is
[`correct` · app/app/invoices/[id]/page.tsx:53](../app/app/invoices/[id]/page.tsx#L53) — it
prompts for a price (pre-filled with the PO/market rate, or the invoiced rate for an unlisted
line), then calls [`correctLine` · convex/invoices.ts:486](../convex/invoices.ts#L486). That
re-runs `reconcileLine` at the new price, passing `acceptedUnitPrice` so an unmatched line
becomes a green manual match, and patches the line with `decision: "edited"`. Approve/reject a
single line is [`reviewLine` · :473](../convex/invoices.ts#L473), which just patches the
line's `decision` and reviewer. Because each is a patch keyed on the line id, decisions are
fully re-editable.

**Walkthrough:** [§23 the invoice detail / review page](./WALKTHROUGH.md#23-the-invoice-detail--review-page) ·
[§24 `reviewLine` and `correctLine`](./WALKTHROUGH.md#24-reviewline-and-correctline-an-edit-re-reconciles)

## Approve or reject an invoice

**What happens:** the reviewer approves or rejects the whole invoice once the lines are worked.

**How the code works:** the buttons in
[`InvoiceReview` · app/app/invoices/[id]/page.tsx:11](../app/app/invoices/[id]/page.tsx#L11)
call [`setInvoiceStatus` · convex/invoices.ts:531](../convex/invoices.ts#L531), which
verifies the invoice belongs to the tenant and patches its `status`.

**Walkthrough:** [§23 the invoice detail / review page](./WALKTHROUGH.md#23-the-invoice-detail--review-page)

## Prove the engine and show live accuracy

**What happens:** the app proves the flag engine against a fixed, hand-labeled benchmark
(precision/recall, independent of anything you upload) and *separately* shows a live
math-consistency readout over the invoices you've actually processed.

**How the code works:** [`Evals` · app/app/evals/page.tsx:9](../app/app/evals/page.tsx#L9)
auto-runs the benchmark on mount (deduped) and records a row on an explicit re-run.
[`runEval` · convex/evals.ts:21](../convex/evals.ts#L21) calls
[`scoreBenchmark` · convex/lib/benchmark.ts:87](../convex/lib/benchmark.ts#L87), which runs
the real `reconcileLine` over the fixed
[`BENCHMARK_INVOICES` · :47](../convex/lib/benchmark.ts#L47), tallies true/false
positives/negatives into precision/recall plus math-consistency, and is pure (no DB). The
mutation dedupes identical results unless `force` is set, then inserts an `evalRuns` row;
[`listEvals` · convex/evals.ts:62](../convex/evals.ts#L62) returns the history. The separate
live math-consistency over *your* lines is computed by
[`stats` · convex/invoices.ts:158](../convex/invoices.ts#L158).

**Walkthrough:** [§27 Evals (the CI gate)](./WALKTHROUGH.md#27-evals-the-ci-gate-evalsts)

## See what happened (diagnostics)

**What happens:** an operator can see every extraction run (provider, model, latency, cost,
lines, flags), the event log, and a benchmark comparing the routing modes.

**How the code works:** [`Diagnostics` · app/app/diagnostics/page.tsx:27](../app/app/diagnostics/page.tsx#L27)
renders traces from [`listInvoices` · convex/invoices.ts:113](../convex/invoices.ts#L113)
(which rolls up each invoice's provider/model/latency/cost and flag counts) and the event
log from [`recentLogs` · :604](../convex/invoices.ts#L604). Its "Run benchmark" button runs a
sample invoice through each routing mode and exercises the local row in the browser via the
same Ollama bridge the upload path uses.

**Walkthrough:** [§26 Diagnostics](./WALKTHROUGH.md#26-diagnostics-traces-event-log-model-benchmark)

## Configure model routing

**What happens:** a tenant chooses the routing mode (auto / local / free / paid / offline)
and an optional model override, and sees which providers are available.

**How the code works:** [`Configuration` · app/app/settings/page.tsx:28](../app/app/settings/page.tsx#L28)
loads the current config from [`routing.get` · convex/routing.ts:26](../convex/routing.ts#L26)
(which also reports provider availability and default model names) and persists changes via
[`routing.set` · :61](../convex/routing.ts#L61) on save. The extract action reads the tenant's
effective routing through the internal `routing._forExtract` query.

**Walkthrough:** [§25 routing config (Settings + `routing.ts`)](./WALKTHROUGH.md#25-routing-config-settings-page--routingts)

## App shell, theme, and navigation

**What happens:** every page renders inside a shared shell with navigation and a light/dark
theme; the dashboard renders the guided multi-step flow.

**How the code works:** Next's App Router turns files into routes; the shared shell is
[`RootLayout` · app/layout.tsx:19](../app/layout.tsx#L19), which injects a no-flash theme
bootstrap (sets `html.light` before paint) and mounts the Clerk + Convex providers.
[`Nav` · app/components/nav.tsx:43](../app/components/nav.tsx#L43) renders the tabs, app
launcher, and org/user widgets; [`ThemeToggle` · :9](../app/components/nav.tsx#L9) flips
`html.light` and persists the choice to `localStorage`. The dashboard's step machine in
[`Dashboard` · app/app/page.tsx:155](../app/app/page.tsx#L155) decides which section to show
and renders progress with [`Stepper` · :118](../app/app/page.tsx#L118).

**Walkthrough:** [§1 how files become URLs](./WALKTHROUGH.md#1-how-files-become-urls-the-app-router) ·
[§3 the layout shell](./WALKTHROUGH.md#3-applayouttsx-the-shell-that-wraps-every-page) ·
[§4 providers & live connections](./WALKTHROUGH.md#4-appproviderstsx-the-client-boundary--live-connections) ·
[§28 shared UI](./WALKTHROUGH.md#28-shared-ui-uitsx-navtsx)

---

## Coverage vs the walkthrough

Every numbered walkthrough section maps to a capability above: §1/§3/§4/§28 → App shell;
§2/§6/§7/§9 → Sign in & tenancy; §5 → landing (App shell / Sign in); §8/§10/§12 → Guided
demo; §11 → the data model (Load a contract / Reconcile); §13/§14/§15/§17/§19 → Upload &
read; §16/§18 → Model routing; §20/§21 → Reconcile; §22 → Flag & reactivity; §23/§24 →
Review & correct (+ Approve/reject); §25 → Configure routing; §26 → Diagnostics; §27 →
Prove the engine. §29 (build & deploy) is covered in [`DEPLOYMENT.md`](./DEPLOYMENT.md);
§30 is the end-to-end recap.
