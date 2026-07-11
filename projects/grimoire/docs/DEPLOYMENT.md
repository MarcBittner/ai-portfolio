# grimoire — Infrastructure & Deployment

How grimoire is deployed, what every environment variable does and **which layer it upgrades**, and
how to stand it up from nothing — first with zero keys, then production. Pair with
[`ARCHITECTURE.md`](./ARCHITECTURE.md).

Status legend: ✅ works with zero keys · ◐ needs config · ⚠️ caveat.

---

## Contents

- [1. Topology — one stateless app](#1-topology--one-stateless-app)
- [2. The upgrade ladder (zero keys → production)](#2-the-upgrade-ladder-zero-keys--production)
- [3. Environment variable matrix](#3-environment-variable-matrix)
- [4. Docker (self-hostable, Vercel-portable)](#4-docker-self-hostable-vercel-portable)
- [5. Render blueprint](#5-render-blueprint)
- [6. Stand it up from scratch](#6-stand-it-up-from-scratch)
- [7. The guest-doc reaper (TTL cron)](#7-the-guest-doc-reaper-ttl-cron)
- [8. CI, build notes, ops](#8-ci-build-notes-ops)
- [9. Verification checklist](#9-verification-checklist)

## 1. Topology — one stateless app

grimoire deploys as **one stateless Next.js web service** (standalone output, a Docker image). It is
not three planes like its Convex-based sibling: the app *is* the server tier, and it reaches whatever
backends the environment points it at.

```
                    ┌───────────────────────────────────────────┐
  Browser ─────────►│  Next.js (standalone) — one web service    │
       ▲            │  server actions + route handlers            │
       │  Clerk JS  │  ── in-memory  OR  MongoDB (persistence)    │
       │ (optional) │  ── local  OR  Mongo  OR  GitHub (GitStore) │
       │            │  ── offline OR Anthropic/OpenAI/Ollama/OR   │  (LLM keys server-side)
       │            └───────────────┬───────────────┬────────────┘
       │  (optional)                │ (optional)     │ (optional)
  ┌────┴─────┐              ┌────────┴──────┐  ┌──────┴────────────┐
  │  CLERK   │              │ MongoDB Atlas │  │ GitHub Contents   │◄── HMAC push webhook
  │ identity │              │  (durable DB) │  │ API (repo = truth)│    (2-way sync)
  └──────────┘              └───────────────┘  └───────────────────┘
```

An **optional** second service (`services/collab`) is a dedicated Yjs WebSocket for live co-editing,
isolated behind `COLLAB_WS_URL` so the main app stays stateless. ◐

## 2. The upgrade ladder (zero keys → production)

Configuration is **purely additive** — each variable upgrades one adapter in place, no code change.

| Set this… | …and this happens |
|---|---|
| *(nothing)* | ✅ in-memory store, local-clone GitStore (serves the committed `docs/`), Clerk shim (dev-seed Super, **local only**), offline LLM, local hash embedder. Full read/write/search, offline. |
| `MONGODB_URI` | ◐ persistence → Mongo Atlas; the GitStore also switches to the **Mongo-backed** store (durable content + history on a read-only FS). |
| `GITHUB_TOKEN` + `DOCS_REPO` | ◐ source of truth → **GitHub Contents API** (app-authored commits; the repo is durable truth). Takes priority over the Mongo store. |
| `GITHUB_WEBHOOK_SECRET` | ◐ inbound GitHub pushes re-index external edits (two-way sync). |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` + `CLERK_SECRET_KEY` | ◐ real Clerk auth; the dev-seed identity is **disabled** (a signed-out request is anonymous read-only). |
| `SEED_SUPER_ADMINS` / `SIGNUP_ALLOWED_DOMAIN` | ◐ who is elevated to Super on login / which domain may self-sign-up (others land on the guest tier or are anonymous). |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `OLLAMA_BASE_URL` / `OPENROUTER_API_KEY` | ◐ real generation, chained `paid → local → free → offline`. |
| `VOYAGE_API_KEY` / `OPENAI_API_KEY` | ◐ real embeddings (`voyage → openai → local`); semantic search stops leaning on the lexical fallback. |
| `BREAKGLASS_EMAIL` + `BREAKGLASS_PASSWORD_HASH` | ◐ an SSO-outage recovery Super login at `/break-glass`. |
| `INGEST_TOKEN` | ◐ the service ingest endpoint (`/api/ingest`) is enabled. |
| `COLLAB_WS_URL` | ◐ live multi-cursor co-editing against the collab WS service. |

## 3. Environment variable matrix

**LLM/embeddings keys are server-side only** — never in the browser bundle. Only `NEXT_PUBLIC_*`
variables are inlined into the client at build time.

| Variable | Layer | What it is |
|---|---|---|
| `MONGODB_URI` / `MONGODB_DB` | persistence + Mongo GitStore | Atlas connection; unset → in-memory. |
| `GITHUB_TOKEN` / `DOCS_REPO` / `DOCS_BRANCH` / `DOCS_CONTENT_ROOT` | source of truth | GitHub Contents API store (owner/repo, branch, content dir). |
| `GITHUB_WEBHOOK_SECRET` | sync | HMAC secret verifying inbound push webhooks. |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | auth (browser) | Clerk publishable key — **build arg** (inlined). |
| `CLERK_SECRET_KEY` | auth (server) | Clerk secret key. |
| `SEED_SUPER_ADMINS` | RBAC | comma/space-separated emails auto-elevated to Super on login. |
| `SIGNUP_ALLOWED_DOMAIN` | RBAC | domain permitted to self-sign-up (others are anonymous/invite). |
| `BREAKGLASS_EMAIL` / `BREAKGLASS_PASSWORD_HASH` | recovery | SSO-outage Super login; only the scrypt **hash** is stored. |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` | LLM | paid provider (default `claude-haiku-4-5-20251001`). |
| `OPENAI_API_KEY` / `OPENAI_MODEL` | LLM | paid provider (default `gpt-4o-mini`). |
| `OPENROUTER_API_KEY` / `OPENROUTER_MODEL` | LLM | free provider (default `google/gemma-4-31b-it:free`). |
| `OLLAMA_BASE_URL` / `OLLAMA_MODEL` | LLM | local provider (probe on `/api/tags`; default `http://localhost:11434`, `llama3.1:8b`). |
| `EMBEDDINGS_PROVIDER` / `VOYAGE_API_KEY` / `VOYAGE_MODEL` / `OPENAI_EMBED_MODEL` | embeddings | remote embedder; unset → local 256-dim hash embedder. |
| `INGEST_TOKEN` / `INGEST_BOT_EMAIL` | ingest | service-token for `/api/ingest`; commit author for ingested docs. |
| `COLLAB_WS_URL` / `COLLAB_TOKEN` | collab | Yjs WS service URL + optional shared secret. |
| `CONVERSION_SERVICE_URL` | import | 🔭 docx/pdf→Markdown sidecar (planned). |

With **no** variable set, everything degrades to the in-memory + offline path — the app runs end to
end, zero cost, zero accounts. ✅

## 4. Docker (self-hostable, Vercel-portable)

The [`Dockerfile`](../Dockerfile) builds Next's **standalone** output — a stock, stateless Next image
that runs anywhere:

- Build stage: `npm ci && npm run build`. `NEXT_PUBLIC_*` are **build ARGs** (inlined into the client
  bundle); server-only secrets are read at **runtime** from the service env, never baked in.
- Runtime stage: copies the standalone bundle + `.next/static` + `public/` + the committed `docs/`
  (so the local-clone GitStore works out-of-the-box), runs as a non-root user, `CMD ["node", "server.js"]`.

```bash
docker build -t grimoire .
docker run -p 8080:8080 grimoire                 # zero-key: in-memory + offline, serves docs/
docker run -p 8080:8080 -e MONGODB_URI=… -e GITHUB_TOKEN=… -e DOCS_REPO=owner/repo grimoire
```

Because it's stock Next standalone, it deploys identically on **Vercel** (the canonical host for this
stack) — the build command there is `npm run build`; set `NEXT_PUBLIC_*` as build-time env and the
rest as runtime env.

## 5. Render blueprint

[`render.yaml`](../render.yaml) declares a Docker web service (free tier, health check `/api/health`,
`autoDeploy`). Non-secret config (`MONGODB_DB`, `SEED_SUPER_ADMINS`, `SIGNUP_ALLOWED_DOMAIN`,
`DOCS_REPO`, `DOCS_BRANCH`, `DOCS_CONTENT_ROOT`) is in the blueprint; **secrets are `sync: false`**
and set in the dashboard, never committed. `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` must also be provided
as a Docker **build arg** (Render maps a matching env var to the build arg) so it's inlined into the
client bundle. The optional collab WS is a second service from `services/collab`.

> ⚠️ Render free tier sleeps after ~15 min idle and cold-starts in ~30–60s. Open the URL a minute
> before demoing.

## 6. Stand it up from scratch

**Local, zero keys** ✅

```bash
npm install
npm run dev            # http://localhost:3000 — in-memory store, offline AI, dev-seed Super
```

You can read, create, edit, search, and Ask-the-docs immediately, entirely offline.

**Production (Render/Docker + Mongo + GitHub + Clerk)** ◐

1. **Auth (Clerk).** Create an app at dashboard.clerk.com; enable Email (and Google if desired). Copy
   the **Publishable** and **Secret** keys. grimoire uses Clerk for **identity only** — do *not* rely
   on Clerk Organizations; RBAC is the app's own.
2. **Persistence (Mongo).** Create an Atlas cluster; set `MONGODB_URI` (+ `MONGODB_DB`). On connect,
   the app ensures its indexes, including the **guest-doc TTL index** (`ttl_docs_expiresAt` on
   `expiresAtDate`).
3. **Source of truth (GitHub).** Point `DOCS_REPO` at your Markdown repo, set `GITHUB_TOKEN` (with
   commit access) and optionally `GITHUB_WEBHOOK_SECRET` for two-way sync.
4. **RBAC.** Set `SEED_SUPER_ADMINS` (your email) and `SIGNUP_ALLOWED_DOMAIN`.
5. **AI (optional).** Set an LLM key (`ANTHROPIC_API_KEY` / `OPENROUTER_API_KEY` / …) and an
   embeddings key (`VOYAGE_API_KEY`) if you want real generation and semantic search.
6. **Deploy.** Push to the repo Render/Vercel builds; set the env above; the `/` landing and
   `/api/health` return 200 once up. Sign in → you land in `/app` with the indexed docs.

## 7. The guest-doc reaper (TTL cron)

Guest-authored docs expire 8h after creation (see [`ARCHITECTURE.md` §7](./ARCHITECTURE.md#7-identity-personal-spaces-guest-tier--ttl)).
Three mechanisms remove them:

1. **Lazy sweep** — every read path sweeps expired docs first ([`lib/reaper.ts`](../lib/reaper.ts)). ✅
2. **Mongo TTL index** — on Atlas, `expiresAtDate` reaps the row server-side (~1×/min). ✅
3. **`POST|GET /api/reaper`** — an idempotent, unauthenticated-safe endpoint that runs the sweep on
   demand ([`app/api/reaper/route.ts`](../app/api/reaper/route.ts)). ✅

For a deployment with **no Mongo and low read traffic**, wire `/api/reaper` to a platform cron so
guest docs are reaped even when nobody is reading:

```
# Render Cron / GitHub Action / Vercel Cron — hit the endpoint on a schedule
*/15 * * * *   curl -fsS https://<your-app>/api/reaper
```

> ⚠️ A scheduled cron is **not** wired in the blueprint yet — the route exists and is cron-safe, but
> you must add the cron job (Render Cron job, a `schedule`d GitHub Action, or `vercel.json` `crons`)
> for your host. On Mongo the TTL index already covers server-side reaping; the endpoint is the
> backstop for the FS/in-memory story. 🔭 (planned to be added to the blueprint)

## 8. CI, build notes, ops

- **Build:** `npm run build` (Next 16 production build, standalone output). **Typecheck:**
  `npm run typecheck` (`tsc --noEmit`). **Lint:** `npm run lint` (`eslint .`). **Test:**
  `npm run test` (Vitest — offline, deterministic; no external services or keys). **Gate:**
  `npm run verify` = lint + typecheck + test + build.
- **Tests are offline by design** — the in-memory store, local hash embedder, and offline LLM mean
  the whole suite runs with zero credentials, and Mongo integration tests use `mongodb-memory-server`.
- ⚠️ On this exact revision the suite has **2 failing RBAC fixtures** (`ask`/`search`) that still
  assume the pre-guest space default; they're being updated for the newly-landed guest tier. Treat
  the guest tier as ◐ pending its own tests.
- **Secrets** never live in the repo; on Render they're `sync: false`. `NEXT_PUBLIC_*` are the only
  values inlined into the client.
- **Cost:** the zero-key path is $0; Mongo/GitHub/Clerk/LLM add their own free or paid tiers.

## 9. Verification checklist

- [ ] `npm run build` succeeds; `npm run typecheck` clean.
- [ ] Local zero-key: `npm run dev` → `/app` lists the committed `docs/`, search + Ask work offline.
- [ ] `/api/health` returns `{ status:"ok" }`.
- [ ] With Clerk set: signed-out `/app` is anonymous read-only (no dev-seed Super leaks into prod).
- [ ] With Mongo set: the app boots, the `docs` index bootstraps, and the `ttl_docs_expiresAt` index
      exists on `docs`.
- [ ] A second user cannot see another user's personal `~` space in the sidebar or search.
- [ ] A guest can read curated spaces and edit only their own notes; a guest note vanishes after 8h
      (or immediately after `POST /api/reaper`).
