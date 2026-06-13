# trueline

[![demo](https://img.shields.io/badge/demo-live-43c98a)](https://trueline-moys.onrender.com)
[![Next.js](https://img.shields.io/badge/Next.js-16-000?logo=nextdotjs&logoColor=white)](https://nextjs.org)
[![React](https://img.shields.io/badge/React-19-61dafb?logo=react&logoColor=000)](https://react.dev)
[![Convex](https://img.shields.io/badge/Convex-backend-ee342f)](https://convex.dev)
[![Clerk](https://img.shields.io/badge/Clerk-auth%20%2B%20orgs-6c47ff?logo=clerk&logoColor=white)](https://clerk.com)
[![Tailwind](https://img.shields.io/badge/Tailwind-v4-38bdf8?logo=tailwindcss&logoColor=white)](https://tailwindcss.com)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![license](https://img.shields.io/badge/license-proprietary-red)](LICENSE)

Invoice line-item verification: extract → verify math in code → reconcile vs purchase
order + catalog rates → flag recoverable overcharges → human review → eval. The LLM
reads the document into structured JSON; all arithmetic and every flag is deterministic
TypeScript.

**Live:** https://trueline-moys.onrender.com · synthetic data only.

![trueline](docs/screenshot.png)

---

## Stack

| Layer | Tech |
|---|---|
| Frontend | Next.js 16 (App Router, RSC), React 19, Tailwind v4 |
| Backend / DB / realtime | Convex (queries · mutations · actions · scheduler) |
| Auth / multi-tenancy | Clerk (orgs; JWT → Convex) |
| LLM | local Ollama · Anthropic · OpenRouter (free) · deterministic mock — selected by routing config |
| Host | Render (Next) + Convex Cloud + Clerk |

## Managed services — what each does, and why

| Service | What it does here | Why it's used instead of building it |
|---|---|---|
| **Convex** | Document DB + serverless TS functions + **realtime subscriptions** + scheduler. Stores invoices/lines/PO/catalog/evals/logs/settings; runs the queries, mutations, and the extract action. | One TS-native platform in place of Postgres + an ORM + an API server + a websocket layer + a job queue. Reactive `useQuery` makes the review UI update live with zero polling; mutations are ACID with auto-retry; `action` + `scheduler` give a managed async job for the LLM call. No connection pools, migrations, or socket plumbing. |
| **Clerk** | Sign-in/sessions, **multi-tenant organizations**, billing; mints the JWT that Convex trusts. | Production auth (social, MFA, sessions) + a tenant model + a billing surface, drop-in. The org id rides in the JWT and scopes every Convex row — no hand-rolled auth/session/RBAC. |
| **OpenRouter** | One OpenAI-compatible endpoint onto many models, including a **free tier** (`gemma-4-31b-it:free`). | Zero-cost default for the public demo; swap models by changing a string (no SDK/code change); one key + billing surface across providers. |
| **Anthropic (Claude)** | The **paid** extraction model — highest structured-output fidelity for the money path. | Best accuracy when it matters; same `fetch` shape, chosen by routing config. |
| **Next.js / React / Tailwind** | App Router + RSC render the shell; client components subscribe to Convex; edge middleware gates `/app`. | One framework for routing + SSR + API + middleware; server components keep the bundle lean while live data stays client-side. |
| **Render** | Hosts the Next app: git-push build/deploy, managed TLS + CDN, env injection. | No servers to manage; an identical deploy story to Vercel (the canonical host for this stack). |

## Request lifecycle

```
client                                  Convex (giddy-marmot-130)                 external
──────                                  ─────────────────────────                 ────────
useMutation(createInvoiceFromText) ──▶ mutation: insert invoices{status:extracting}
                                        insert logs; scheduler.runAfter(0, extract.run)
                                          │ schedule
                                          ▼
                                        action extract.run
                                          runQuery extract._getRaw
                                          runQuery routing._forExtract  ──▶ {mode,model}
                                          extractLineItems(text,routing) ───────────────▶ Anthropic / OpenRouter
                                          reconcileLine() × N  (pure)        429/none ──▶  ↳ deterministic mock
                                          runMutation writeResults  ◀────────┘
                                            clear+insert invoiceLines (idempotent on _id)
                                            patch invoices{status,totals,latencyMs,costUsd}
useQuery(getInvoice) re-runs ◀── reactive push (no polling) ── appendLog{event:extract}
```

**Walking through one upload:**

1. **Client → mutation.** The dashboard calls `createInvoiceFromText`. It's a *mutation*
   because this is a transactional write — the invoice row (`status:"extracting"`) and an
   audit log entry are inserted atomically.
2. **The async hop.** A mutation can't call the LLM (mutations are deterministic and do no
   external I/O, so Convex can safely auto-retry them). So it **schedules an action**
   instead — `scheduler.runAfter(0, internal.extract.run)` — and returns immediately. The
   new row already shows up in the UI as "extracting…".
3. **Action reads its inputs.** An action has no `ctx.db`, so `extract.run` pulls the raw
   text and the tenant's routing config through `runQuery` (each is its own transaction).
4. **Extract.** `extractLineItems` calls the configured provider (paid Anthropic / free
   OpenRouter) with the strict-JSON prompt; on a 429 or missing key it falls to the
   deterministic parser. Either way it returns typed line items.
5. **Verify + reconcile.** `reconcileLine` recomputes every total, matches each line to the
   PO and catalog, computes variance, and flags it — pure code. **The model's numbers are
   never trusted for math or the decision.**
6. **Write back.** The action calls `writeResults` (a mutation) — one transaction,
   idempotent on the invoice `_id` (clear-then-insert lines), patching status + totals +
   latency/cost.
7. **Live update.** Because the review screen subscribed with `useQuery(getInvoice)`,
   Convex re-runs that query the instant `writeResults` commits and **pushes** the new data
   — the row fills in live, no refresh and no polling code.

## Persistence layer (`convex/schema.ts`)

Every row is `orgId`-scoped (the active Clerk org, else `user:<subject>`); reads filter
through a `by_org*` index, so tenants are isolated. Auto fields: `_id`, `_creationTime`.

```ts
purchaseOrders { orgId, poNumber, vendor,
                 lines: [{ sku?, description, unit, quantity, unitPrice }] }
                 .index by_org [orgId]  .index by_org_po [orgId, poNumber]

catalog        { orgId, sku, description, unit, marketPrice, category? }      // market rates
                 .index by_org [orgId]  .index by_org_sku [orgId, sku]

invoices       { orgId, invoiceNumber, vendor, poNumber?, rawText,
                 status: "extracting"|"needs_review"|"approved"|"rejected",
                 claimedTotal?, recoverableUsd?,
                 extractionProvider?, extractionModel?, latencyMs?, costUsd?,
                 error?, uploadedBy? }
                 .index by_org [orgId]  .index by_org_status [orgId, status]

invoiceLines   { orgId, invoiceId→invoices, lineNo,
                 // LLM-read (it only reads):
                 description, sku?, unit, quantity, unitPrice, claimedExtension,
                 confidence (0..1), sourceQuote,
                 // code-decided:
                 computedExtension, mathOk, poUnitPrice?, catalogPrice?,
                 matchedBy: "sku"|"description"|"none",
                 varianceVsPoPct?, varianceVsMarketPct?,
                 flag: "green"|"yellow"|"red", reasons[], recoverableUsd,
                 // human-in-the-loop:
                 decision: "pending"|"approved"|"edited"|"rejected", reviewer? }
                 .index by_invoice [invoiceId]  .index by_org_decision [orgId, decision]

evalRuns       { orgId, provider, model, n,
                 extractionAccuracy, flagPrecision, flagRecall, createdBy? }  .index by_org
logs           { orgId, level: "info"|"warn"|"error", event, detail, latencyMs? }  .index by_org
settings       { orgId, mode: "auto"|"free"|"paid"|"offline", model? }  .index by_org
```

No ORM: types are generated from this schema (`convex/_generated`) and flow to the React
`useQuery`/`useMutation` hooks. Relationships are `v.id(...)` references resolved in code;
no SQL joins.

## API reference (Convex functions)

End-to-end typed via `convex/_generated`. Kinds: **query** (reactive, cached read),
**mutation** (serializable ACID write), **action** (external I/O; not transactional),
**internal\*** (server-only, not client-callable).

**Auth.** Every public function derives the tenant from the Clerk identity (`org_id`
claim, else `user:<subject>`). Reads use `optionalOrg` and return an empty result when
unauthenticated (so a transient render can't throw); writes call `requireOrg` and
**throw `Error("Not authenticated")`**. Cross-tenant access returns `null` / "not
found".

**Transport.** The browser uses Convex's reactive websocket client. Any function is
also callable over HTTP:
`POST {NEXT_PUBLIC_CONVEX_URL}/api/{query|mutation|action}` with body
`{"path":"file:function","args":{…},"format":"json"}` and header
`Authorization: Bearer <Clerk JWT from the "convex" template>`. Response is
`{"status":"success","value":…}` or `{"status":"error","errorMessage":…}`.

### `invoices.ts`

**`query listInvoices() → InvoiceRow[]`** — newest-first invoices for the tenant, each
augmented with flag rollups `{ lineCount, red, yellow, green }`. `[]` if unauthenticated.

**`query getInvoice({ invoiceId: Id<"invoices"> }) → { invoice, lines } | null`** — the
invoice plus its `invoiceLines` sorted by `lineNo`; `null` if missing or owned by
another tenant.

**`query stats() → { invoices, recoverableUsd, needsReview, latestEval }`** — dashboard
rollups (`latestEval: EvalRun | null`).

**`query baseline() → { hasPo, poLines, poNumber, vendor }`** — whether a contract/PO is
loaded; drives the guided stepper.

**`query recentLogs() → Log[]`** — newest 60 event-log rows.

**`mutation seedIfEmpty() → { seeded: boolean }`** — no-op if any invoice exists, else
inserts the demo PO + catalog + three invoices (reconciled inline). Idempotent.

**`mutation setBaselineFromText({ rawText: string, poNumber?: string }) → { poLines }`** —
parses a PO file (`lib/parse.ts:parsePoText`), **replaces** existing POs, seeds the
market catalog if absent. Throws if no line items parse.

**`mutation createInvoiceFromText({ invoiceNumber: string, rawText: string, poNumber?: string }) → Id<"invoices">`** —
inserts the invoice as `status:"extracting"`, logs it, and **schedules**
`internal.extract.run` via `scheduler.runAfter(0, …)`. Returns immediately; extraction
finishes async and the UI updates reactively.

**`mutation reviewLine({ lineId: Id<"invoiceLines">, decision: "approved"|"rejected" }) → void`** —
records the reviewer's decision + identity on a line.

**`mutation correctLine({ lineId: Id<"invoiceLines">, unitPrice: number, quantity?: number }) → void`** —
applies a corrected price/qty, **re-runs `reconcileLine`** (flags + recoverable
recompute), marks the line `decision:"edited"` (an edit becomes a label).

**`mutation setInvoiceStatus({ invoiceId, status: "approved"|"rejected"|"needs_review" }) → void`**

**`mutation resetDemo() → { cleared: true }`** — deletes every row for the tenant
(invoices, lines, PO, catalog, evals, logs).

**`internalMutation writeResults({ invoiceId, orgId, lines, provider, model, latencyMs?, costUsd? })`** —
called by the action. **One transaction**: clears + re-inserts `invoiceLines`
(idempotent on the invoice `_id`), reconciles each line, patches the invoice with
status/totals/telemetry. `markError` and `appendLog` are the error/log sinks.

### `extract.ts`

**`internalQuery _getRaw({ invoiceId }) → { rawText, invoiceNumber } | null`**

**`internalAction run({ invoiceId, orgId })`** — the only place external I/O is legal.
Reads raw text + routing config (`runQuery`), calls `extractLineItems`, measures latency
and estimates cost, writes back via `runMutation writeResults`, appends a log. Not
auto-retried — safe to re-run because the write is idempotent.

### `routing.ts`

**`query get() → { mode, model, keys:{free,paid}, defaultFreeModel, defaultPaidModel, activeMode }`** —
the tenant's routing config + live key availability (env-derived) + the mode a run
resolves to now.

**`mutation set({ mode: "auto"|"free"|"paid"|"offline", model?: string }) → { ok: true }`** —
upserts `settings`.

**`internalQuery _forExtract({ orgId }) → { mode, model }`** — read by the action.

### `evals.ts`

**`mutation runEval() → EvalRun`** — scores the labeled set; inserts + returns the run.
**`query listEvals() → EvalRun[]`** — newest 10.

### `diagnostics.ts`

**`action benchmark({ invoiceText: string }) → { mode, provider, model, latencyMs, lines, error }[]`** —
runs the same invoice through `offline`, `free`, and `paid`; returns the comparison and
logs it.

## LLM integration (`convex/lib/llm.ts`)

System prompt (verbatim):

```
You extract line items from a vendor invoice into strict JSON. You ONLY read values
that appear in the document — never invent or compute. Return a JSON object
{"lines": [...]} where each line is {"description": string, "sku": string|null,
"quantity": number, "unit": string, "unitPrice": number, "extension": number,
"confidence": number (0..1), "sourceQuote": string}. confidence reflects how
legible/certain the source was. sourceQuote is the verbatim snippet the numbers came
from. Output JSON only.
```

- User message: `Extract every line item from this invoice:\n\n<rawText>`.
- Transport: plain `fetch` (no SDK). Anthropic → `POST /v1/messages` (`x-api-key`,
  `anthropic-version: 2023-06-01`). OpenRouter → `POST /v1/chat/completions`
  (`Authorization: Bearer`). Response JSON is recovered with a fence/brace-tolerant
  parser (`parseJsonLoose`) and coerced/clamped (`coerceLines`) — numbers stripped of
  `$,`, confidence clamped 0..1, `sourceQuote` capped 280 chars.
- `extractLineItems(rawText, { mode, model })` returns `{ lines, provider, model }`.
  **The model never computes**: `extension` it returns is ignored — `reconcileLine`
  recomputes it. Output is never trusted for math or the flag decision.

## Routing config (`convex/routing.ts`, UI `app/app/settings`)

Per-tenant `settings{ mode, model }`. The extract action reads it via `_forExtract` and
passes it to `extractLineItems`, which sets the provider attempt order **explicitly** by
mode (deterministic mock is always the terminal fallback):

```
offline → []                                 → mock
local   → [ollama]                           → mock
free    → [openrouter]                        → mock
paid    → [anthropic]                         → mock
auto    → [ollama?, anthropic, openrouter]    → mock   (local if reachable → paid → free → offline)
```

A provider is attempted only if available. **Local Ollama is autodetected** — a cached
probe (`GET {OLLAMA_URL}/api/tags`, 1.5s timeout, ~60s TTL) decides availability with no
flag; `OLLAMA_URL` defaults to `http://localhost:11434` and is overridable. Because the
action runs in Convex's cloud it detects whatever *that* runtime can reach — zero-config
when Convex is self-hosted alongside Ollama; on the managed cloud the probe fails fast and
falls through. Free is used when `OPENROUTER_API_KEY` is set, paid when `ANTHROPIC_API_KEY`
is set (`keyStatus()`). `model` overrides the chosen provider's default. Defaults:
`OLLAMA_MODEL=llama3.1:8b`, `OPENROUTER_MODEL=google/gemma-4-31b-it:free`,
`ANTHROPIC_MODEL=claude-haiku-4-5-20251001`. Keys/URLs are **Convex deployment env vars**
(server-side), never in the browser bundle.

OpenRouter's free tier is 50 req/day; past that a run resolves to the mock (shown on the
review header + Diagnostics).

### Reaching a host Ollama from the browser (the client-side path)

There are **two routing layers**. The block above is the **server-side** path — it runs in
Convex's cloud, so it can reach Anthropic / OpenRouter, and Ollama only if `OLLAMA_URL`
points at a host the *cloud* can reach. But the common case is Ollama on **your machine**
with a cloud-hosted backend: the cloud can't see your `localhost` — yet the browser, which
runs on your machine, can. So in `auto`/`local` mode the upload is routed **through the
browser** instead of the action:

```
createInvoiceFromText({ deferServer: true })      // don't schedule the server action yet
  → probeOllama()        // browser: GET localhost:11434/api/tags, else :11435 (CORS proxy)
  → extractWithOllama()  // browser → host Ollama /api/chat  (stream:false, format:"json")
  → submitExtraction({ invoiceId, provider:"ollama (browser→host)", model, lines })
                         // Convex mutation: reconcile + write — same code path as the server
  ── if Ollama unreachable ──▶ scheduleExtract()  // hand back to the server action (paid→free→offline)
```

Files: `app/lib/ollama.ts` (probe + extract + JSON coerce), `app/app/page.tsx`
(`uploadInvoice` orchestration), `convex/invoices.ts` (`createInvoiceFromText`'s
`deferServer`, `submitExtraction`, `scheduleExtract`). The model proposes; the same
deterministic `reconcileLine` still does the math — only the *transport* changed.

**CORS.** A page served from another origin can't call `localhost:11434` unless Ollama
allows it. Either:
- run Ollama with `OLLAMA_ORIGINS='*' ollama serve` (allows the app's origin); **or**
- put a tiny **CORS proxy** next to Ollama that forwards `:11435 → :11434` and adds
  `Access-Control-Allow-Origin: *` — e.g. a one-file `http.server` proxy, or
  `docker run -p 11435:11435 …` (handy when Ollama is the menu-bar app and you don't want to
  change its launch env).

`probeOllama` tries **`:11434` first (direct)** and falls back to **`:11435` (proxy)**, so
either approach works with no change to the app.

## Reconcile algorithm (`convex/lib/reconcile.ts`, pure)

This is where the money decisions are made. The LLM has *proposed* line items; these pure
functions (no DB, no I/O — so they're trivially unit-testable and make the eval
reproducible) recompute the math, match each line to the baselines, and decide the flag.

```
computedExtension = round2(quantity × unitPrice);  mathOk = |computed − claimed| ≤ 0.015
match → PO line then catalog: by sku; else best description token-overlap ≥ 0.40 (FUZZY_MIN)
variance%(base) = (unitPrice − base) / base × 100,  for PO and market
flag: red   if !mathOk, or worst variance > 10% (RED_PCT)
      yellow if no match, or confidence < 0.60, or worst variance > 3% (YELLOW_PCT)
      green  otherwise
recoverableUsd = max(0, unitPrice − min(poUnitPrice, catalogPrice)) × quantity
```

## Evals (`convex/evals.ts`)

`runEval()` scores the engine on a labeled set (`lib/demoData.ts:DEMO_EVAL_LABELS`):
per labeled invoice, predicted = any red line, truth = should-flag → **flag
precision/recall**; plus **math-consistency** = share of lines with `mathOk`. Persisted to
`evalRuns`; shown at `/app/evals`. This is the CI gate before shipping a threshold/prompt/
model change.

## Auth & multi-tenancy

Clerk JWT (`convex` template, `aud=convex`) → `ConvexProviderWithClerk`
(`app/providers.tsx`) → validated by `convex/auth.config.ts` (`CLERK_JWT_ISSUER_DOMAIN`) →
functions derive `orgId` from `ctx.auth.getUserIdentity()`. `middleware.ts` gates `/app(.*)`.
Read queries use an `optionalOrg` helper (return empty instead of throwing while auth
settles) so the client never crashes; the extract action writes idempotently (keyed on the
invoice `_id`) because actions are not auto-retried.

## Code map

```
convex/  schema.ts auth.config.ts invoices.ts extract.ts routing.ts evals.ts diagnostics.ts
         lib/{ llm.ts reconcile.ts parse.ts demoData.ts }
app/     layout.tsx providers.tsx middleware.ts page.tsx(landing)
         app/page.tsx(dashboard·4-step) app/invoices/[id]/page.tsx(review)
         app/settings(routing) app/evals app/diagnostics(traces·log·benchmark) app/about
         components/{ nav.tsx ui.tsx }
```

## Env (`.env.example`)

```
NEXT_PUBLIC_CONVEX_URL            # set by `convex dev`/`deploy`
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY # public
CLERK_SECRET_KEY                  # Next server
CLERK_JWT_ISSUER_DOMAIN           # Convex deployment env (auth.config)
OPENROUTER_API_KEY / OPENROUTER_MODEL   # Convex deployment env (free LLM)
OLLAMA_BASE_URL    / OLLAMA_MODEL        # Convex deployment env (local LLM; set URL to enable)
ANTHROPIC_API_KEY  / ANTHROPIC_MODEL    # Convex deployment env (paid LLM)
```

## Local dev

```bash
npm install
npx convex dev          # dev deployment + codegen + watch
npm run dev             # http://localhost:3000
npx convex env set OPENROUTER_API_KEY …   # the action runs server-side
```

## Deploy

Convex: `npx convex deploy`. Host: Render native Node (`npm install && npm run build` /
`npm run start`) — on Vercel the build command would be
`npx convex deploy --cmd 'npm run build'`. `convex/_generated` is committed so a git-based
build needs no Convex step. Set the Clerk + LLM env on Convex; set `NEXT_PUBLIC_*` on the host.

Part of the [ai-portfolio](https://github.com/MarcBittner/ai-portfolio).
