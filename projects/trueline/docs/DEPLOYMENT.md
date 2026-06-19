# trueline — Infrastructure & Deployment

How trueline is deployed, what every environment variable is and **which plane it
lives in**, and how to stand the whole thing up from scratch. Pair with
[`ARCHITECTURE.md`](./ARCHITECTURE.md).

---

## Contents

- [1. Topology — three managed planes](#1-topology--three-managed-planes)
- [2. Environment variable matrix (which var, which plane)](#2-environment-variable-matrix-which-var-which-plane)
- [3. Stand it up from scratch](#3-stand-it-up-from-scratch)
- [4. The browser→host Ollama path (live-demo "real model, free")](#4-the-browserhost-ollama-path-live-demo-real-model-free)
- [5. CI, build notes, ops](#5-ci-build-notes-ops)
- [6. Verification checklist (is it in "perfect shape"?)](#6-verification-checklist-is-it-in-perfect-shape)

## 1. Topology — three managed planes

trueline is **not** one server. It's three independently-deployed planes that talk
over signed JWTs and a websocket:

```
                         ┌─────────────────────────────┐
   Browser ─────────────►│  Next.js on RENDER           │   marketing + /app UI
        ▲  Clerk JS SDK   │  (Node web service)          │   build: npm install && npm run build
        │                 │  start: npm run start         │   start: next start  (port $PORT)
        │                 └──────────────┬───────────────┘
        │ Clerk session JWT              │ NEXT_PUBLIC_CONVEX_URL  (+ Clerk JWT attached per call)
        │ ("convex" template)            ▼
 ┌──────┴───────┐        ┌─────────────────────────────┐
 │ CLERK CLOUD  │◄──────►│  CONVEX CLOUD                │   DB + functions + realtime + scheduler
 │ auth + orgs  │ verify │  validates the Clerk JWT      │   LLM keys live HERE (server-side)
 │ + JWT issuer │ issuer │  (CLERK_JWT_ISSUER_DOMAIN)   │   convex deploy
 └──────────────┘        └──────────────┬───────────────┘
                                         │ server-side fetch
                                         ▼  Anthropic · OpenRouter (free) · (Ollama autodetect)
```

- **Render** runs the Next.js app (SSR/RSC + the client bundle). It holds only the
  *public* Convex URL and the Clerk keys. It never holds an LLM key.
- **Convex Cloud** runs the database + all functions + the LLM extraction. **All
  model keys live here**, because that's where the `extract` action runs.
- **Clerk Cloud** runs auth + organizations and issues the JWT that Convex trusts.

The single most common mistake is putting an LLM key on Render — it does nothing
there. **LLM keys go on Convex.**

---

## 2. Environment variable matrix (which var, which plane)

| Variable | Render (Next) | Convex | Clerk dashboard | What it is |
|---|:--:|:--:|:--:|---|
| `NEXT_PUBLIC_CONVEX_URL` | ✅ | — | — | the deployment's public Convex URL (browser connects here) |
| `CONVEX_DEPLOYMENT` | (build) | set by CLI | — | the Convex deployment id; written by `convex deploy` |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | ✅ | — | (source) | Clerk publishable key (browser) |
| `CLERK_SECRET_KEY` | ✅ | — | (source) | Clerk secret key (Next server / middleware) |
| `CLERK_JWT_ISSUER_DOMAIN` | — | ✅ | (source) | your Clerk Frontend API URL, e.g. `https://<slug>.clerk.accounts.dev`; Convex validates JWTs against it |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` | — | ✅ | — | paid extraction path (optional) |
| `OPENROUTER_API_KEY` / `OPENROUTER_MODEL` | — | ✅ | — | free extraction path — **the public demo's default** (`google/gemma-4-31b-it:free`) |
| `OLLAMA_BASE_URL` / `OLLAMA_MODEL` | — | ✅ (opt) | — | local model, autodetected; only relevant for a self-/co-hosted Convex |

With **no** LLM key set anywhere, extraction falls back to the deterministic mock — the app still runs end to end, zero cost. The public demo sets `OPENROUTER_API_KEY` on Convex so it extracts with a real free model.

---

## 3. Stand it up from scratch

### Step 1 — Clerk (auth plane)
1. Create an application at dashboard.clerk.com; enable **Email** and **Organizations**.
2. **JWT Templates → New → Convex** (one click). This creates the `convex` template the app expects (`applicationID: "convex"` in `convex/auth.config.ts`).
3. Copy: the **Publishable key**, the **Secret key**, and your **Frontend API URL** (the issuer, `https://<slug>.clerk.accounts.dev`).

### Step 2 — Convex (backend plane)
```sh
npm install
npx convex deploy            # creates/links the deployment; writes CONVEX_DEPLOYMENT + NEXT_PUBLIC_CONVEX_URL
# set the server-side env on the Convex deployment:
npx convex env set CLERK_JWT_ISSUER_DOMAIN https://<your-slug>.clerk.accounts.dev
npx convex env set OPENROUTER_API_KEY sk-or-v1-...      # free demo path
npx convex env set OPENROUTER_MODEL google/gemma-4-31b-it:free
# optional paid path:
# npx convex env set ANTHROPIC_API_KEY sk-ant-...
```
`convex deploy` pushes the schema + functions and prints the `NEXT_PUBLIC_CONVEX_URL` to provide to Render.

### Step 3 — Render (web plane)
Create a **Web Service** from the repo (root dir `projects/trueline`), runtime **Node**:
- **Build command:** `npm install && npm run build`
- **Start command:** `npm run start`
- **Env vars:** `NEXT_PUBLIC_CONVEX_URL` (from step 2), `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` (from step 1).
- Health: the marketing `/` route returns 200 once up.

### Step 4 — verify
1. `https://<your-app>/` (marketing) → 200.
2. Sign in → you land in `/app`; the workspace auto-seeds a demo PO + invoices on first load (`seedIfEmpty`).
3. Upload an invoice → it extracts (watch the provider on the Diagnostics tab — `openrouter`/`anthropic`/`ollama`/`mock`) → lines reconcile → red/yellow/green flags + recoverable $ appear **live**.

---

## 4. The browser→host Ollama path (live-demo "real model, free")

Because the **Convex action runs in the cloud, it cannot reach a reviewer's
`localhost:11434`** — but the *browser* can. So for the live demo:

- `createInvoiceFromText({deferServer:true})` skips the server action; `app/lib/ollama.ts` calls the host's Ollama from the browser and posts results via `submitExtraction`. If the host isn't reachable, the client calls `scheduleExtract` and the server path (Anthropic→OpenRouter→mock) takes over.
- Requirements: **Chrome**, host Ollama running, and CORS allowed — either run Ollama with `OLLAMA_ORIGINS=*` or the `:11435` CORS proxy the portfolio uses. The Settings tab has a model picker populated from the host's `/api/tags`.
- The server still does **all** the deterministic reconcile; only the *read* runs on the user's machine.

---

## 5. CI, build notes, ops

- **Build:** `npm run build` (Next 16 production build). `next.config.ts` sets `eslint.ignoreDuringBuilds` so a style nit can't block a deploy; lint runs separately. **Typecheck:** `npm run typecheck` (= `tsc --noEmit`). **Verify both at once:** `npm run verify`.
- **Lint:** `npm run lint` (= `eslint .`) against the ESLint 9 flat config in `eslint.config.mjs`, which loads `eslint-config-next`'s `core-web-vitals` + `typescript` rules. (Next 16 removed `next lint`, so ESLint runs directly.)
- **Cold start:** Render free tier sleeps after ~15 min idle; first hit cold-starts ~30–60s. Open the URL a minute before demoing.
- **Cost:** all free tiers — Render free web service, Convex free plan, Clerk free plan, OpenRouter free model. $0 to run.
- **Push behaviour:** the repo's services auto-deploy on push to `main` (and a local ArgoCD cluster reconciles) — batch commits to avoid rebuild storms.

---

## 6. Verification checklist (is it in "perfect shape"?)

- [ ] `npx tsc --noEmit` clean
- [ ] `https://trueline-moys.onrender.com/` returns 200 (warm)
- [ ] sign-in works and `/app` seeds demo data
- [ ] uploading an invoice shows the **real provider** on Diagnostics (not `mock`) → confirms `OPENROUTER_API_KEY` is set **on Convex**
- [ ] red/yellow/green flags + recoverable $ render, and update **live** without refresh (confirms Convex realtime + Clerk JWT round-trip)
- [ ] a second org sees none of the first org's data (confirms `orgId` isolation)

If extraction shows `mock`, the fix is almost always: **set `OPENROUTER_API_KEY` on the Convex deployment** (`npx convex env set …`), not on Render.
