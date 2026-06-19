# trueline — Capability Map (what the app does, and where)

This maps every **thing the product does** to the code that does it. Each entry is a
business behavior — "the app reads the invoice," "the app flags an overcharge" — with a
short description of what happens and a link to the responsible code. Links point at
`file#Lnnn` (current line; the named function is the stable reference).

System-level view: [`ARCHITECTURE.md`](./ARCHITECTURE.md). Line-by-line narrative:
[`WALKTHROUGH.md`](./WALKTHROUGH.md).

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

**What happens:** a visitor signs in with Clerk and lands in a workspace that contains
only their organization's data — no tenant can see another's invoices.

**Where it happens:** the sign-in CTA is on the landing page
([`Landing` · app/page.tsx:23](../app/page.tsx#L23)); the Clerk + Convex providers wrap
every page in [`RootLayout` · app/layout.tsx:19](../app/layout.tsx#L19). Isolation is
enforced server-side: the tenant id is derived from the verified token by
[`requireOrg` · convex/invoices.ts:23](../convex/invoices.ts#L23) (never sent by the
client), the trusted issuer is declared in
[`auth.config.ts:16`](../convex/auth.config.ts#L16), and every table is `by_org`-indexed
in [`schema.ts:17`](../convex/schema.ts#L17).

## The guided demo

**What happens:** a brand-new tenant lands on a populated, worked example instead of an
empty screen; the demo invoices are really run through a model (not faked); and "Reset"
clears everything and *stays* cleared even after navigating away.

**Where it happens:** the dashboard auto-seeds once per tenant
([`Dashboard` · app/app/page.tsx:155](../app/app/page.tsx#L155) →
[`loadDemo` · :274](../app/app/page.tsx#L274)), which seeds the baseline via
[`seedDemoBaseline` · convex/invoices.ts:268](../convex/invoices.ts#L268) and then runs
each demo invoice through the real upload path. Reset is
[`resetDemo` · convex/invoices.ts:443](../convex/invoices.ts#L443); durability comes from
[`markInitialized` · :46](../convex/invoices.ts#L46) and
[`demoState` · :204](../convex/invoices.ts#L204). Sample files download via
[`download` · app/app/page.tsx:63](../app/app/page.tsx#L63).

## Load a contract (the baseline)

**What happens:** the user uploads a purchase order / contract; it becomes the agreed
price list every invoice line is checked against, and it seeds a market-rate catalog.

**Where it happens:** the upload control is
[`UploadButton` · app/app/page.tsx:72](../app/app/page.tsx#L72); it hands the text to
[`uploadContract` · :210](../app/app/page.tsx#L210), which calls
[`setBaselineFromText` · convex/invoices.ts:410](../convex/invoices.ts#L410); the text is
parsed by [`parsePoText` · convex/lib/parse.ts:25](../convex/lib/parse.ts#L25).

## Upload and read an invoice

**What happens:** the user uploads an invoice; the app reads it into structured line
items with an LLM. Crucially, the model **only reads** — it never computes or decides.

**Where it happens:** uploading an invoice is
[`uploadInvoice` · app/app/page.tsx:219](../app/app/page.tsx#L219), which records the
invoice ([`createInvoiceFromText` · convex/invoices.ts:300](../convex/invoices.ts#L300))
then extracts it. The read itself runs either in the browser against your local model
([`extractWithOllama` · app/lib/ollama.ts:111](../app/lib/ollama.ts#L111)) or on the
server ([`extract.run` · convex/extract.ts:19](../convex/extract.ts#L19) →
[`extractLineItems` · convex/lib/llm.ts:156](../convex/lib/llm.ts#L156)), with a
deterministic parser as the no-model fallback
([`parsePipeInvoice` · convex/lib/parse.ts:48](../convex/lib/parse.ts#L48)).

## Choose where the model runs

**What happens:** the app prefers your **local** Ollama (no quota, private); if none is
reachable it uses a paid model, then a free one, and only falls back to the deterministic
parser when no model is available anywhere — and it tells you which path it took.

**Where it happens:** the browser finds a reachable local model and the model it actually
has installed via [`probeOllama` · app/lib/ollama.ts:36](../app/lib/ollama.ts#L36) and
[`pickOllamaModel` · :64](../app/lib/ollama.ts#L64); the client prefers local then defers
to the server in [`uploadInvoice` · app/app/page.tsx:219](../app/app/page.tsx#L219); the
server-side fallback chain is
[`extractLineItems` · convex/lib/llm.ts:156](../convex/lib/llm.ts#L156).

## Reconcile each line

**What happens:** for every line the app recomputes `qty × unit price`, matches the line
to the contract and the catalog, and computes how far the price is from each baseline —
all in deterministic code, never the model. *This is the product.*

**Where it happens:** the decision engine is
[`reconcileLine` · convex/lib/reconcile.ts:66](../convex/lib/reconcile.ts#L66) (a pure,
unit-tested function). Its results are persisted by
[`insertReconciledLines` · convex/invoices.ts:60](../convex/invoices.ts#L60) and, on the
server path, committed by [`writeResults` · :546](../convex/invoices.ts#L546).

## Flag overcharges and recoverable dollars

**What happens:** each line is flagged green / yellow (3–10% over) / red (>10% over or a
math error), and the app estimates the recoverable dollars vs the *lower* baseline; the
invoice shows the totals you can dispute.

**Where it happens:** the flag + recoverable-$ logic is inside
[`reconcileLine` · convex/lib/reconcile.ts:66](../convex/lib/reconcile.ts#L66). It's
displayed by [`InvoiceReview` · app/app/invoices/[id]/page.tsx:11](../app/app/invoices/[id]/page.tsx#L11)
and summarized per row by
[`verdictText` · app/app/page.tsx:513](../app/app/page.tsx#L513); the colored pills are
[`FlagBadge` · app/components/ui.tsx:67](../app/components/ui.tsx#L67).

## Review and correct lines

**What happens:** an estimator can approve, reject, or correct any line — any number of
times. Correcting an **unlisted** line (one not on the contract) accepts the entered rate
as a reviewer-approved baseline, turning it green.

**Where it happens:** the correct prompt is
[`correct` · app/app/invoices/[id]/page.tsx:53](../app/app/invoices/[id]/page.tsx#L53),
which calls [`correctLine` · convex/invoices.ts:486](../convex/invoices.ts#L486)
(re-reconciles at the new price; an unlisted line becomes a manual green match).
Approve/reject a line is [`reviewLine` · :473](../convex/invoices.ts#L473).

## Approve or reject an invoice

**What happens:** the reviewer can approve or reject the whole invoice once they've worked
the lines.

**Where it happens:** the buttons live in
[`InvoiceReview` · app/app/invoices/[id]/page.tsx:11](../app/app/invoices/[id]/page.tsx#L11)
and call [`setInvoiceStatus` · convex/invoices.ts:531](../convex/invoices.ts#L531).

## Prove the engine and show live accuracy

**What happens:** the app proves the flag engine against a fixed, hand-labeled benchmark
(precision/recall, independent of anything you upload) and *separately* shows a live
math-consistency readout over the invoices you've actually processed.

**Where it happens:** the page is
[`Evals` · app/app/evals/page.tsx:9](../app/app/evals/page.tsx#L9); the benchmark run is
[`runEval` · convex/evals.ts:21](../convex/evals.ts#L21) →
[`scoreBenchmark` · convex/lib/benchmark.ts:87](../convex/lib/benchmark.ts#L87) over the
fixed set ([`BENCHMARK_INVOICES` · :47](../convex/lib/benchmark.ts#L47)). The live
math-consistency over your data comes from
[`stats` · convex/invoices.ts:158](../convex/invoices.ts#L158).

## See what happened (diagnostics)

**What happens:** an operator can see every extraction run (provider, model, latency,
cost, lines, flags), the event log, and a benchmark comparing the routing modes.

**Where it happens:** the page is
[`Diagnostics` · app/app/diagnostics/page.tsx:27](../app/app/diagnostics/page.tsx#L27); it
reads traces from [`listInvoices` · convex/invoices.ts:113](../convex/invoices.ts#L113) and
the log from [`recentLogs` · :604](../convex/invoices.ts#L604).

## Configure model routing

**What happens:** a tenant can choose the routing mode (auto / local / free / paid /
offline) and an optional model override, and see which providers are available.

**Where it happens:** the page is
[`Configuration` · app/app/settings/page.tsx:28](../app/app/settings/page.tsx#L28); it
saves via [`routing.set` · convex/routing.ts:61](../convex/routing.ts#L61) and reads the
current config + provider availability from
[`routing.get` · :26](../convex/routing.ts#L26).

## App shell, theme, and navigation

**What happens:** every page renders inside a shared shell with navigation, a light/dark
theme, and the org/user controls; the dashboard itself renders the guided multi-step flow.

**Where it happens:** the shell is
[`RootLayout` · app/layout.tsx:19](../app/layout.tsx#L19); the top nav is
[`Nav` · app/components/nav.tsx:43](../app/components/nav.tsx#L43) with the theme switch
[`ThemeToggle` · :9](../app/components/nav.tsx#L9); the multi-step flow is rendered by
[`Dashboard` · app/app/page.tsx:155](../app/app/page.tsx#L155) using
[`Stepper` · :118](../app/app/page.tsx#L118).
