# grimoire — Overview

A technical overview of what grimoire is, the problem it solves, and how it is shaped — grounded in
the code, but above the line-level depth of [`WALKTHROUGH.md`](./WALKTHROUGH.md). For system design
see [`ARCHITECTURE.md`](./ARCHITECTURE.md); for hosting see [`DEPLOYMENT.md`](./DEPLOYMENT.md); for
the callable surface see [`API.md`](./API.md); for the capability→code map see
[`FUNCTIONS.md`](./FUNCTIONS.md).

Status legend: ✅ shipped · ◐ partial · 🔭 planned · ⚠️ caveat.

---

## Contents

- [The problem](#the-problem)
- [Core principles](#core-principles)
- [The four adapters](#the-four-adapters-swap-by-env-never-by-code)
- [How it works, end to end](#how-it-works-end-to-end)
- [The permission model](#the-permission-model)
- [Personal spaces and the guest tier](#personal-spaces-and-the-guest-tier)
- [The data model](#the-data-model)
- [Design decisions worth noting](#design-decisions-worth-noting)
- [Key properties](#key-properties)
- [Code map](#code-map)
- [Stack](#stack)

## The problem

A team wiki has two hard requirements that usually pull against each other. It must be **pleasant to
edit** — WYSIWYG, live preview, no Git ceremony — and it must be **trustworthy and durable**: every
change attributable and reversible, permissions that actually hold, and no vendor lock-in on the
content itself. Most tools pick one side: a database-backed wiki is editable but its history and
access model are bespoke and opaque; a plain Git+Markdown repo is durable and auditable but nobody
non-technical will touch it.

grimoire keeps **Markdown in a Git repository as the source of truth** and puts a fast, reactive,
permission-aware application layer over it. Users get *Save* and a plain version history; underneath,
every save is a canonicalized commit. And because the whole thing is built on swappable adapters with
zero-key fallbacks, it runs on a laptop with no accounts *and* scales to Mongo + GitHub + Clerk + a
paid LLM by setting environment variables.

## Core principles

1. **Markdown-as-source-of-truth; the DB is a rebuildable projection.** The repo (`GitStore`) is
   durable truth; the `docs` collection is an index over it. A full re-index reconstructs app state
   ([`lib/git/indexer.ts`](../lib/git/indexer.ts)). ✅

2. **The client never asserts its own authority.** Identity is resolved server-side; role, groups,
   grants, and space policy are read server-side; the pure resolver decides. A request carries no
   role claim that the server trusts ([`lib/authz.ts`](../lib/authz.ts),
   [`lib/permissions.ts`](../lib/permissions.ts)). ✅

3. **Deny-wins, and unreadable means invisible.** The permission resolver short-circuits Super, then
   any matching *deny* at or above the requested capability wins over any *allow* — at any
   specificity. Listings and search drop what you can't read *before* ranking, so a doc you lack
   access to 404s; it never 403s (no existence leak). ✅

4. **Offline-first; providers are additive.** In-memory store, Clerk shim, local hash embedder, and
   a deterministic offline LLM mean the app boots and works with zero keys. Each external provider is
   an upgrade selected from the environment, never a hard dependency ([`lib/llm.ts`](../lib/llm.ts),
   [`lib/rag/embeddings.ts`](../lib/rag/embeddings.ts)). ✅

## The four adapters (swap by env, never by code)

Everything that touches the outside world sits behind a small interface with a key-free fallback:

| Concern | Interface | Zero-key default | Upgrades (selected by env) |
|---|---|---|---|
| Persistence | `Database` ([`lib/db/types.ts`](../lib/db/types.ts)) | in-memory ([`lib/db/memory.ts`](../lib/db/memory.ts)) | `MONGODB_URI` → Mongo ([`lib/db/mongo.ts`](../lib/db/mongo.ts)) |
| Source of truth | `GitStore` ([`lib/git/types.ts`](../lib/git/types.ts)) | local clone ([`lib/git/local.ts`](../lib/git/local.ts)) | Mongo-backed ([`lib/git/mongo.ts`](../lib/git/mongo.ts)) · GitHub API ([`lib/git/github.ts`](../lib/git/github.ts)) |
| Generation | `complete()` ([`lib/llm.ts`](../lib/llm.ts)) | deterministic offline fn | Anthropic · OpenAI · Ollama · OpenRouter |
| Embeddings | `embed()` ([`lib/rag/embeddings.ts`](../lib/rag/embeddings.ts)) | local hash embedder (256-dim) | Voyage · OpenAI |

The selection logic is one branch each: the DB in [`lib/db/index.ts:17`](../lib/db/index.ts#L17),
the store in [`lib/server/data.ts:32`](../lib/server/data.ts#L32), the LLM chain in
[`lib/llm.ts:38`](../lib/llm.ts#L38), and embeddings in
[`lib/rag/embeddings.ts:48`](../lib/rag/embeddings.ts#L48).

## How it works, end to end

grimoire is a single Next.js app. Server actions and route handlers are the only tier that touches
data; nothing client-side reaches the DB or Git.

1. **Identity.** On each request, [`currentPrincipal`](../lib/server/data.ts) resolves the acting
   user — a signed-in Clerk user when Clerk is configured, a break-glass session if one is active,
   or a dev-seed Super Admin in local zero-key dev (never in a Clerk-enabled production). It upserts
   the user row (seeding Super Admins idempotently, giving first-time users the `guest` default) and
   provisions the user's personal `~` space ([`lib/authz.ts`](../lib/authz.ts)). ✅

2. **Read.** [`listReadableDocs`](../lib/server/data.ts) projects the `docs` index to the fields the
   sidebar needs, filters out other users' personal spaces, and runs `canAccess` per doc — so the
   tree contains exactly what you may read. A single doc is fetched through `getReadableDoc`, which
   returns `null` (→ 404) if you can't read it. ✅

3. **Write.** A server action authorizes `edit` on the path, then
   [`saveDoc`](../lib/git/save.ts) **canonicalizes** the Markdown (stable, low-noise diffs),
   **commits** it through the `GitStore` authored as the user (optimistic-concurrency guarded on the
   blob sha — a stale base raises `ConflictError`, never a silent clobber), and **re-indexes** the
   path (title, headings, body, and the RAG chunks). ✅

4. **Search & Ask.** [`searchReadable`](../lib/search.ts) fuses a keyword signal and a semantic
   (embedding-cosine) signal with Reciprocal Rank Fusion, dropping unreadable docs *before* ranking.
   [`askDocs`](../lib/rag/ask.ts) retrieves the asker's readable chunks and synthesizes an answer
   with `[n]` citations through the LLM chain — degrading to a relevant-docs listing offline. ✅

5. **Two-way sync (optional).** An HMAC-verified GitHub push webhook re-indexes external edits, so
   the repo and the DB index never diverge ([`lib/git/webhook.ts`](../lib/git/webhook.ts)). ◐ (needs
   `GITHUB_WEBHOOK_SECRET`)

## The permission model

Two surfaces, both in [`lib/permissions.ts`](../lib/permissions.ts), both pure (no Clerk/DB imports),
so they're unit-testable in isolation:

- **`canAccess(principal, resource, capability, grants, spacePolicy)`** — read/edit/admin on a
  space/folder/doc. The resolution order ([`lib/permissions.ts:105`](../lib/permissions.ts#L105)):
  1. `super` → allow everything (short-circuit).
  2. Collect grants matching `{role, groups, self} × {resource ∪ ancestors}`.
  3. **Deny wins** — any matching deny at ≥ the requested capability → deny.
  4. Allow — any matching allow at ≥ the requested capability → allow.
  5. Space default (`read` only) → allow; else deny.

  Role grants are *additive by rank*: a `role:read` grant applies to everyone read-or-above, so "all
  users can read" is expressible ([`lib/permissions.ts:64`](../lib/permissions.ts#L64)). Folder
  grants match on a path-segment boundary, so `a/b` does not cover `a/bc`
  ([`lib/permissions.ts:76`](../lib/permissions.ts#L76)).

- **`canGlobal(principal, action)` / `canSetRole(actor, target)`** — org-level actions gated purely
  by role per a fixed matrix ([`lib/permissions.ts:163`](../lib/permissions.ts#L163)): Admins manage
  permissions/groups/scopes and set roles up to Editor and view the audit; only Super assigns
  Admin/Super and edits org config.

Enforcement is centralized in [`authorize`](../lib/authz.ts#L78): it loads the principal + cached
grants + cached space policy and defers to the pure resolver. Grants and space policies come from a
short-TTL, per-database policy cache ([`lib/server/policyCache.ts`](../lib/server/policyCache.ts)),
invalidated on every in-app grant/space write, so decisions stay exact without re-scanning on every
call. ✅

## Personal spaces and the guest tier

**Personal spaces** ([`lib/personalSpace.ts`](../lib/personalSpace.ts)) — each user gets a private
space keyed `~<slug-of-email>`, created with `defaultRole: "none"` plus a single owner-`admin`
grant. The deny-wins resolver gives the owner full control and denies everyone else (no matching
grant + closed default); Super can still reach it by direct access, but a **defense-in-depth listing
filter** ([`isPersonalSpaceVisibleTo`](../lib/personalSpace.ts#L51)) drops *other* users' personal
spaces from every tree — so no one's private docs render in anyone else's sidebar, not even a
Super's. ✅

**Guest tier** — self-signup users land on role `guest` (rank 0, below `read`;
[`lib/authPolicy.ts:34`](../lib/authPolicy.ts#L34), assigned in
[`upsertUserOnLogin`](../lib/authz.ts#L27)). A guest:

- **Reads the curated public library** — every top-level content space is created with
  `defaultRole: "read"` ([`lib/git/indexer.ts:37`](../lib/git/indexer.ts#L37)), and space-default
  read applies to *every* signed-in principal regardless of role, guests included. A guest can't
  satisfy a `role:read` grant, so they get no baseline edit/admin.
- **Edits only their own notes** — their owner-`admin` grant on their `~` space gives them full
  control there and nowhere else.
- **Whose notes expire after 8 hours** — a doc a guest creates is stamped with expiry fields
  ([`guestExpiryFields`](../lib/guest.ts#L32) called from
  [`createDocAction`](../app/actions/docs.ts#L104)): `GUEST_DOC_TTL_MS = 8h`
  ([`lib/guest.ts:12`](../lib/guest.ts#L12)). Non-guest docs carry no expiry and never expire.

Expiry is enforced by three mechanisms ([`lib/reaper.ts`](../lib/reaper.ts)): a **lazy sweep** run
before every read path (`listReadableDocs` / `getReadableDoc` / search), a **defense-in-depth
freshness check** on direct read (an expired doc returns `null`), and — on Mongo — a **TTL index**
on `expiresAtDate` that lets Atlas reap the row server-side
([`lib/db/mongo.ts:41`](../lib/db/mongo.ts#L41)). An idempotent, cron-safe **`POST /api/reaper`**
([`app/api/reaper/route.ts`](../app/api/reaper/route.ts)) is the explicit backstop. A reaped doc's
dependents (chunks, comments, suggestions, favorites, notifications, files, versions, and
doc-scoped grants) are purged too ([`lib/reaper.ts:21`](../lib/reaper.ts#L21)). ✅

> ⚠️ The guest tier is newly landed. Its designed behavior is documented above and matches the code;
> unit coverage specific to the TTL helpers is not yet in place, and two RBAC fixtures in the test
> suite (`ask`/`search`) still assume the pre-guest default and are being updated — so `npm run test`
> is not green on this exact revision. Treated as ◐ pending its own tests.

## The data model

Collections are typed `Repos` over the `Database` adapter
([`lib/repos.ts`](../lib/repos.ts)) — the same interface whether it's in-memory or Mongo:

- **`users`** — email, role, optional Clerk id. **`groups` / `groupMembers`** — group definitions
  and memberships. **`grants`** — the RBAC allow/deny rows (subject × resource × capability ×
  effect). **`spaces`** — key, name, `defaultRole` (`read`/`none`), and an optional `owner` for
  personal spaces.
- **`docs`** — the projection of the repo: path, spaceKey, title, headings, body, blobSha, plus
  metadata (source/status/tags/summary) and the guest-only `expiresAt` / `expiresAtDate`.
- **`chunks`** — RAG vector rows (text + embedding + heading path), permission-filtered at query time.
- **`comments` / `suggestions` / `favorites` / `notifications`** — the collaboration layer.
- **`files` / `versions`** — the Mongo-backed store's durable content + append-only history (so a
  read-only-FS deployment still gets commit-per-change semantics and rollback).
- **`audit`** — append-only actor/action/before/after trail. **`settings`** — singletons (e.g.
  LLM routing).

## Design decisions worth noting

- **Why Markdown-in-Git as truth, with a DB projection?** Durability, attribution, and reversibility
  come free from Git; the DB gives the reactive, permission-filtered, searchable app layer. A
  re-index rebuilds the projection, so the DB is disposable. ✅
- **Why a pure resolver separate from enforcement?** `canAccess`/`canGlobal` have no I/O, so the
  security logic is unit-testable in isolation and identical no matter which store fed it the grants.
  Enforcement (`authorize`) is the only place that reads the world. ✅
- **Why 404-not-403 on unreadable docs?** A 403 confirms a doc exists; grimoire drops unreadable docs
  from listings and returns `null` on read, so absence and no-access are indistinguishable. ✅
- **Why deterministic offline fallbacks everywhere?** The app must run with zero accounts for a
  reviewer, and tests must be offline and reproducible — so the hash embedder and offline LLM
  function are real code paths, not stubs. ✅
- **Limitations (called out, not hidden).** The Mongo TTL monitor runs ~once a minute, so the numeric
  `expiresAt` mirror + lazy sweep give immediate local expiry; the local hash embedder is lexical,
  not semantic, so semantic search is "degraded-but-working" until a real embeddings key is set; and
  the guest-tier tests are still being written (⚠️ above).

## Key properties

- **Offline-first** — boots and works end-to-end with zero keys.
- **Server-enforced RBAC** — pure, deny-wins, Super-short-circuit, 404-no-leak.
- **Durable & attributable** — every save is a canonical commit; history and rollback are first-class.
- **Degrades gracefully** — LLM `paid → local → free → offline`; embeddings `voyage → openai → local`.
- **Private-by-construction personal spaces** and an **ephemeral guest tier**.

## Code map

| Concern | File |
|---|---|
| RBAC resolver (pure) | [`lib/permissions.ts`](../lib/permissions.ts) |
| Enforcement + identity upsert | [`lib/authz.ts`](../lib/authz.ts) |
| Auth policy helpers (pure) | [`lib/authPolicy.ts`](../lib/authPolicy.ts) |
| Personal spaces | [`lib/personalSpace.ts`](../lib/personalSpace.ts) |
| Guest TTL helpers (pure) | [`lib/guest.ts`](../lib/guest.ts) |
| Guest-doc reaper | [`lib/reaper.ts`](../lib/reaper.ts) · [`app/api/reaper/route.ts`](../app/api/reaper/route.ts) |
| Server data wiring (store + identity) | [`lib/server/data.ts`](../lib/server/data.ts) |
| Policy cache | [`lib/server/policyCache.ts`](../lib/server/policyCache.ts) |
| Persistence adapters | [`lib/db/`](../lib/db) |
| GitStore adapters + save/index | [`lib/git/`](../lib/git) |
| Canonical Markdown | [`lib/markdown.ts`](../lib/markdown.ts) |
| Search (keyword + semantic + RRF) | [`lib/search.ts`](../lib/search.ts) |
| RAG (chunk / embed / retrieve / ask) | [`lib/rag/`](../lib/rag) |
| LLM router | [`lib/llm.ts`](../lib/llm.ts) |
| Server actions | [`app/actions/`](../app/actions) |
| Route handlers | [`app/api/`](../app/api) |

## Stack

Next.js 16 (App Router, RSC) + React 19 + Tailwind v4 for the app; Clerk for identity (RBAC is the
app's own); MongoDB and the GitHub Contents API as optional durable backends; TipTap 3 + Yjs for the
editor; remark/unified for canonical Markdown; a configurable LLM + embeddings provider with
deterministic offline fallbacks. Hosted on Render (Docker, Vercel-portable).
