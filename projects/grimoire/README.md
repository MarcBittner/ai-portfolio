# grimoire

[![demo](https://img.shields.io/badge/demo-live-43c98a)](TBD)
[![Next.js](https://img.shields.io/badge/Next.js-16-000?logo=nextdotjs&logoColor=white)](https://nextjs.org)
[![React](https://img.shields.io/badge/React-19-61dafb?logo=react&logoColor=000)](https://react.dev)
[![Clerk](https://img.shields.io/badge/Clerk-auth-6c47ff?logo=clerk&logoColor=white)](https://clerk.com)
[![Tailwind](https://img.shields.io/badge/Tailwind-v4-38bdf8?logo=tailwindcss&logoColor=white)](https://tailwindcss.com)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)

An offline-first, self-hostable knowledge base: a reactive wiki over **Markdown-as-source-of-truth**,
with a **deny-wins RBAC** model, per-user private spaces, a **self-signup guest tier** whose notes
expire after 8 hours, curated public AI content, RAG "ask-the-docs" search, and a TipTap editor.
Every write is a Git commit — but Git stays invisible; users see a *Save* and a plain history.

The whole thing **boots with zero keys**: an in-memory store, a Clerk auth shim, a deterministic
offline embedder, and an offline LLM fallback. Configuration is purely additive — set a Mongo URI,
a GitHub token, Clerk keys, or an LLM key and each layer upgrades in place, no code change.

**Live demo:** TBD · synthetic sample content — the app runs on your own docs too.

---

## What it does

- **Read** — Spaces → a document tree, rendered as sanitized GitHub-Flavored Markdown. Every
  listing is permission-scoped, so an unreadable doc never leaks (it 404s, it doesn't 403).
- **Edit** — create / edit / move / soft-delete across **WYSIWYG · Source · Preview** surfaces
  (TipTap 3 + a raw textarea + live preview) that round-trip losslessly through one canonical
  Markdown serializer.
- **Versioned, invisibly** — each save canonicalizes the Markdown and lands as one commit authored
  as the acting user; optimistic-concurrency guarded, so a stale base raises a conflict instead of a
  silent clobber.
- **RBAC** — five roles (`guest · read · editor · admin · super`), groups, and custom scopes,
  resolved by a pure function that **short-circuits Super, then lets deny win at any depth**, and is
  enforced server-side on every call.
- **Personal spaces** — every user gets a private `~` space nobody else can see, not even in a Super
  Admin's sidebar.
- **Guest tier** — new users self-sign-up as **guests**: read the curated public library and edit
  only their own notes, which **expire 8 hours after creation** and are reaped from every store.
- **Search** — keyword **and** semantic (embedding cosine over chunks), fused with Reciprocal Rank
  Fusion, permission-filtered *before* anything is ranked or returned.
- **Ask-the-docs (RAG)** — retrieval-augmented Q&A with clickable citations, scoped to what the
  asker may read; degrades to a "here are the relevant docs" listing when no LLM is configured.
- **AI authoring assists** — draft / expand / proofread as accept-reject proposals, routed through
  the shared LLM chain.
- **Import / export** — `.md`/`.zip` in, `.md`/`.txt`/`.zip` out, scope-filtered.

## Quickstart

```bash
npm install
npm run dev          # http://localhost:3000
```

**Zero-configuration startup.** With an empty environment the app runs end-to-end on an in-memory
store, the offline (hash) embedder, the deterministic offline LLM fallback, and a dev-seed Super
Admin identity — so you can read, write, and search immediately, offline. Copy `.env.example` to
`.env.local` and fill in only what you want to upgrade.

| Command | Purpose |
|---|---|
| `npm run dev` | Next.js dev server |
| `npm run build` | Production build (`next build`, standalone output) |
| `npm run start` | Serve the production build |
| `npm run lint` / `npm run typecheck` / `npm run test` | Lint · `tsc --noEmit` · Vitest |
| `npm run verify` | lint + typecheck + test + build — the pre-push gate |

## Offline-first, and the providers story

Every external dependency sits behind a small interface that **self-selects from the environment**
and always has a deterministic, key-free fallback. Nothing is required to boot; everything is an
additive upgrade.

| Layer | Zero-key default | Upgrade |
|---|---|---|
| **Persistence** (`lib/db`) | in-memory store | `MONGODB_URI` → MongoDB Atlas |
| **Source of truth** (`lib/git`) | local clone (fs + git CLI) | `MONGODB_URI` → Mongo-backed store · `GITHUB_TOKEN`+`DOCS_REPO` → GitHub Contents API |
| **Auth** (`app/clerk-shim.tsx`) | dev-seed identity (local only) | `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` → real Clerk |
| **Generation** (`lib/llm.ts`) | deterministic offline function | Anthropic / OpenAI · Ollama · OpenRouter, chained `paid → local → free → offline` |
| **Embeddings** (`lib/rag/embeddings.ts`) | local hash embedder (256-dim) | Voyage · OpenAI, chained `voyage → openai → local` |

The chain records which providers it fell back through, so `/api/health` and the settings pane show
exactly where a completion actually ran.

## Stack

Next.js 16 (App Router, RSC) · React 19 · TypeScript 5 · Tailwind v4 · Clerk (identity only — RBAC
is the app's own) · MongoDB (optional) · GitHub Contents API (optional) · TipTap 3 + Yjs · remark /
unified for canonical Markdown · hosted on Render (Docker, Vercel-portable).

## Documentation

| Doc | Covers |
|---|---|
| [docs/OVERVIEW.md](docs/OVERVIEW.md) | What grimoire is, the core principles, end-to-end shape |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System design — adapters, request lifecycle, data model, RBAC, guest TTL |
| [docs/API.md](docs/API.md) | The surface: server actions + route handlers, auth per entry |
| [docs/FUNCTIONS.md](docs/FUNCTIONS.md) | Capability map — each product behavior → the code that does it |
| [docs/WALKTHROUGH.md](docs/WALKTHROUGH.md) | File-by-file code walkthrough, ordered by execution flow |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Docker / Render / Vercel, the env matrix, guest-reaper cron, ops |
| [docs/spec/spec.md](docs/spec/spec.md) · [docs/spec/development-plan.md](docs/spec/development-plan.md) | Specification + build plan |

Part of the [ai-portfolio](https://github.com/MarcBittner/ai-portfolio).
