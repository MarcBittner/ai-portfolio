# grimoire — Complete Code Walkthrough

A file-by-file walkthrough of the grimoire application, ordered by execution flow. Each numbered
section covers one file or concept with the key code references, notes, and a summary line.

Companion documents: [`ARCHITECTURE.md`](./ARCHITECTURE.md) (system design), [`API.md`](./API.md)
(the callable surface), [`FUNCTIONS.md`](./FUNCTIONS.md) (capability→code map), and
[`DEPLOYMENT.md`](./DEPLOYMENT.md) (hosting + env).

**Design principle.** The repo (Markdown-in-Git) is the source of truth; the DB is a rebuildable
projection. Authority is computed server-side by a pure deny-wins resolver, never asserted by the
client. Every external dependency is a swappable adapter with a zero-key offline fallback. The
sections below identify where the codebase enforces those boundaries.

**Paths.** All paths are relative to the project root `projects/grimoire/`. This file is in `docs/`,
so `../lib/permissions.ts` refers to the source tree one level up.

Status legend: ✅ shipped · ◐ needs config · ⚠️ caveat.

---

## Summary

The repo is truth and the DB is its index; identity is resolved server-side; a pure deny-wins
resolver decides every access; Markdown is canonicalized on save into clean commits; search and RAG
are permission-filtered before ranking; and every provider (store, Git host, LLM, embeddings, auth)
degrades to a working, testable, zero-key fallback.

## FAQ

**How does the app run with no accounts?** Every adapter self-selects from the environment and falls
back to a key-free path: in-memory store, local-clone GitStore over the committed `docs/`, a Clerk
shim yielding a dev-seed identity (local only), a local hash embedder, and a deterministic offline
LLM ([§3](#3-the-adapters-and-how-they-self-select), [§16](#16-llm-router-libllmts)).

**How is a user prevented from reading what they shouldn't?** The pure resolver denies them, *and*
listings/search drop unreadable docs before ranking, *and* a single-doc read returns `null` → 404 —
so no-access is indistinguishable from not-existing ([§9](#9-the-rbac-resolver-libpermissionsts),
[§7](#7-reading-the-tree-and-one-doc-permission-filtered)).

**How can two editors not silently clobber each other?** Each save carries the blob `baseSha` the
editor loaded; if it no longer matches HEAD the store raises `ConflictError`
([§12](#12-the-save-engine-libgitsavets)).

**How do guest notes disappear after 8 hours?** They're stamped with expiry fields on create and
removed by a lazy sweep on every read, a Mongo TTL index, and an on-demand reaper route
([§11](#11-the-guest-tier-and-ttl-libguestts-libreaperts)).

---

## Source map

**Server tier — [`app/`](../app)** (server actions + route handlers; the only tier that touches data)

| File | What it is | Sections |
|---|---|---|
| [`middleware.ts`](../middleware.ts) | the Clerk gate (passthrough when unconfigured) | §1 |
| [`app/layout.tsx`](../app/layout.tsx) | root shell + no-flash theme bootstrap | §2 |
| [`app/clerk-shim.tsx`](../app/clerk-shim.tsx) | Clerk made optional | §2 |
| [`app/actions/docs.ts`](../app/actions/docs.ts) | create/save/move/delete server actions | §8, §12 |
| [`app/api/reaper/route.ts`](../app/api/reaper/route.ts) | guest-doc reaper endpoint | §11 |
| [`app/api/*`](../app/api) | health, export, ingest, webhook, breakglass | §17 |

**Core — [`lib/`](../lib)**

| File | What it is | Sections |
|---|---|---|
| [`lib/server/data.ts`](../lib/server/data.ts) | store selection + identity + readable listings | §3, §6, §7 |
| [`lib/server/policyCache.ts`](../lib/server/policyCache.ts) | short-TTL grants/policy cache | §10 |
| [`lib/db/`](../lib/db) | persistence adapters (memory/mongo) | §4 |
| [`lib/git/`](../lib/git) | GitStore adapters, save, index, webhook | §5, §12, §13 |
| [`lib/permissions.ts`](../lib/permissions.ts) | the pure RBAC resolver | §9 |
| [`lib/authz.ts`](../lib/authz.ts) · [`lib/authPolicy.ts`](../lib/authPolicy.ts) | enforcement + policy helpers | §6 |
| [`lib/personalSpace.ts`](../lib/personalSpace.ts) | private per-user spaces | §11 |
| [`lib/guest.ts`](../lib/guest.ts) · [`lib/reaper.ts`](../lib/reaper.ts) | guest TTL + reaper | §11 |
| [`lib/markdown.ts`](../lib/markdown.ts) | canonical Markdown serializer | §8 |
| [`lib/search.ts`](../lib/search.ts) | keyword + semantic + RRF | §14 |
| [`lib/rag/`](../lib/rag) | chunk/embed/retrieve/ask | §15, §16 |
| [`lib/llm.ts`](../lib/llm.ts) | provider router | §16 |
| [`lib/breakglass.ts`](../lib/breakglass.ts) · [`lib/safety.ts`](../lib/safety.ts) | recovery + content safety | §17 |

---

## Contents

**Part 1 — Boot & identity**
- [1. `middleware.ts` — the optional Clerk gate](#1-middlewarets--the-optional-clerk-gate)
- [2. The shell and the Clerk shim](#2-the-shell-and-the-clerk-shim)
- [3. The adapters, and how they self-select](#3-the-adapters-and-how-they-self-select)
- [4. Persistence (`lib/db`)](#4-persistence-libdb)
- [5. The GitStore contract (`lib/git/types.ts`)](#5-the-gitstore-contract-libgittypests)
- [6. Resolving identity (`data.ts`, `authz.ts`)](#6-resolving-identity-datats-authzts)

**Part 2 — Reading**
- [7. Reading the tree and one doc (permission-filtered)](#7-reading-the-tree-and-one-doc-permission-filtered)
- [8. Canonical Markdown (`markdown.ts`)](#8-canonical-markdown-markdownts)
- [9. The RBAC resolver (`lib/permissions.ts`)](#9-the-rbac-resolver-libpermissionsts)
- [10. The policy cache (`policyCache.ts`)](#10-the-policy-cache-policycachets)

**Part 3 — Spaces, guests, writing**
- [11. The guest tier and TTL (`lib/guest.ts`, `lib/reaper.ts`)](#11-the-guest-tier-and-ttl-libguestts-libreaperts)
- [12. The save engine (`lib/git/save.ts`)](#12-the-save-engine-libgitsavets)
- [13. The indexer (`lib/git/indexer.ts`)](#13-the-indexer-libgitindexerts)

**Part 4 — Search, RAG, and the edges**
- [14. Search (`lib/search.ts`)](#14-search-libsearchts)
- [15. Chunking & retrieval (`lib/rag`)](#15-chunking--retrieval-librag)
- [16. LLM router (`lib/llm.ts`)](#16-llm-router-libllmts)
- [17. The HTTP edges (`app/api`)](#17-the-http-edges-appapi)
- [18. The whole machine, end to end](#18-the-whole-machine-end-to-end)

---

## 1. `middleware.ts` — the optional Clerk gate

[`middleware.ts`](../middleware.ts) runs before every `/app` and `/api` request. Its whole job is to
be **optional**: if `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` is set it runs `clerkMiddleware()` (which
attaches auth *context* but does **not** force sign-in — `/app` is browsable signed-out as anonymous
read-only); if it's unset it returns a passthrough, so a zero-key boot serves the app instead of
500-ing on missing keys ([`middleware.ts:13`](../middleware.ts#L13)). The matcher deliberately
includes doc paths that end in `.md` ([`:23`](../middleware.ts#L23)) — an earlier "exclude anything
with a dot" matcher skipped doc pages and made every doc 404.

**Summary.** Auth is context, not a wall; and the wall itself is optional.

## 2. The shell and the Clerk shim

[`app/layout.tsx`](../app/layout.tsx) wraps every page and injects a **no-flash theme bootstrap** — a
tiny inline script that reads persisted appearance prefs and applies them to `<html>` *before paint*
([`:23`](../app/layout.tsx#L23)) — then mounts `Providers`. [`app/clerk-shim.tsx`](../app/clerk-shim.tsx)
is the key file: it re-exports Clerk's `SignedIn`/`SignedOut`/`SignInButton`/`UserButton` **only when
a publishable key exists**; otherwise they resolve to safe no-ops (`Passthrough`/`Empty`), so the app
renders the landing and shell with no auth configured ([`clerk-shim.tsx:24`](../app/clerk-shim.tsx#L24)).
Note the comment at [`:22`](../app/clerk-shim.tsx#L22): grimoire uses Clerk for **identity only** —
RBAC is the app's own (DB roles + scopes), no Clerk Organizations.

**Summary.** The UI degrades to a working, unauthenticated shell when Clerk isn't configured.

## 3. The adapters, and how they self-select

[`lib/server/data.ts`](../lib/server/data.ts) is where the app gets its configured store handles and
identity — nothing client-side touches the DB or Git. Two selection functions:

- [`db()`](../lib/server/data.ts#L23) → [`getDatabase`](../lib/db/index.ts#L17): `MONGODB_URI` set →
  Mongo, else in-memory.
- [`store()`](../lib/server/data.ts#L32): **priority** GitHub Contents API (`GITHUB_TOKEN` +
  `DOCS_REPO`) → Mongo-backed store (`MONGODB_URI`; durable + writable on a read-only FS) → local
  clone (headless dev, serving the committed `docs/`).

**Summary.** Swapping a backend is a config change, decided by one branch each.

## 4. Persistence (`lib/db`)

[`lib/db/types.ts`](../lib/db/types.ts) defines a minimal Mongo-shaped `Collection` — `insert`,
`findOne` (with sort), `find`, `findProjected` (include-list projection, so a hot listing skips the
big `body` column), `update`, `upsert`, `delete`, `count` ([`:29`](../lib/db/types.ts#L29)).
[`lib/db/memory.ts`](../lib/db/memory.ts) implements it over Maps;
[`lib/db/mongo.ts`](../lib/db/mongo.ts) over the Mongo driver, and on connect it **ensures indexes** —
including the guest TTL index `ttl_docs_expiresAt` on `expiresAtDate` with `expireAfterSeconds: 0`
([`mongo.ts:41`](../lib/db/mongo.ts#L41)). [`lib/repos.ts`](../lib/repos.ts) binds the typed
collections (`users`, `grants`, `spaces`, `docs`, `chunks`, `comments`, `suggestions`, `favorites`,
`notifications`, `files`, `versions`, `audit`, `settings`) over whichever `Database` is active.

**Summary.** One collection interface; two implementations; the same `Repos` on top.

## 5. The GitStore contract (`lib/git/types.ts`)

[`GitStore`](../lib/git/types.ts#L21) is `listMarkdown` / `read` / `write` / `remove`. `write` is
**commit-per-change**, returns the new blob sha, and throws
[`ConflictError`](../lib/git/types.ts#L32) if the caller's `baseSha` no longer matches HEAD (the
optimistic-concurrency token). Three implementations honor it identically:
[`local.ts`](../lib/git/local.ts) (fs reads + git CLI commits, with a per-store write mutex so
check-then-commit is atomic in-process), [`mongo.ts`](../lib/git/mongo.ts) (content in `files`, an
append-only `versions` log for rollback — the durable "repo" on a read-only FS), and
[`github.ts`](../lib/git/github.ts) (Octokit over the Contents API — the production commit + webhook
path).

**Summary.** The indexer and save engine never know *how* the repo is reached.

## 6. Resolving identity (`data.ts`, `authz.ts`)

[`currentPrincipal`](../lib/server/data.ts#L49) resolves the acting user and upserts them.
[`resolveIdentity`](../lib/server/data.ts#L61) checks, in order: a signed **break-glass** cookie
(SSO-outage recovery), then **Clerk** (`currentUser()`, gated by
[`canSelfSignUp`](../lib/authPolicy.ts#L40) — verified + allowed domain, or a seed admin; else
anonymous read-only, **never** the dev-seed), then the **dev-seed** fallback (local zero-key dev only,
`null` in production; [`:101`](../lib/server/data.ts#L106)).
[`upsertUserOnLogin`](../lib/authz.ts#L18) seeds Super Admins idempotently, assigns the default role
via [`resolveRoleOnLogin`](../lib/authPolicy.ts#L25) (first-timer → `"guest"`,
[`:34`](../lib/authPolicy.ts#L34)), audits role changes, and provisions the personal space.

**Summary.** The server decides who you are and what role you hold; the client asserts nothing.

## 7. Reading the tree and one doc (permission-filtered)

[`listReadableDocs`](../lib/server/data.ts#L171) bootstraps the index if empty
([`bootstrapIndexIfEmpty` :121](../lib/server/data.ts#L126), latched so it doesn't COLLSCAN on the hot
path), sweeps expired guest docs, projects `docs` to `{path,title,spaceKey}`, drops other users'
personal spaces via [`isPersonalSpaceVisibleTo`](../lib/personalSpace.ts#L51), and runs
[`canAccess`](../lib/permissions.ts#L105) per doc against cached grants + policy. A single doc goes
through [`getReadableDoc`](../lib/server/data.ts#L225), which authorizes `read` and applies an expired
guard, returning `null` (→ 404) for anything unreadable or expired.

**Summary.** The tree *is* the permission filter; 404, not 403.

## 8. Canonical Markdown (`markdown.ts`)

[`canonicalize`](../lib/markdown.ts#L44) normalizes Markdown to one stable, GFM-friendly form via
remark/unified and is **idempotent** — parse→serialize is a no-op on already-canonical input, so
editing in either surface never reflows unrelated lines and Git diffs stay minimal. The module also
exports the index helpers the indexer and importers use: `extractTitle` (front-matter `title:`, else
first H1), `extractHeadings`, `frontmatter`/`upsertFrontmatter` (additive — never overwrites author
metadata), `stripFrontmatter`.

**Summary.** One serializer makes WYSIWYG↔source safe and diffs clean.

## 9. The RBAC resolver (`lib/permissions.ts`)

The trust core, pure and I/O-free. [`canAccess`](../lib/permissions.ts#L105):

1. `super` → allow (short-circuit).
2. `matching = grants where` [`subjectMatches`](../lib/permissions.ts#L64) `∧`
   [`resourceMatches`](../lib/permissions.ts#L76). Subjects: `user` by email, `group` by membership,
   `role` **by rank ≥** (a `role:read` grant applies to read-and-above — so a `guest` at rank 0
   satisfies none). Resources: space exact, doc exact path, folder prefix on a **segment boundary**.
3. Any covering **deny** wins ([`:120`](../lib/permissions.ts#L120)) — the most-specific one is cited.
4. Else any covering **allow** ([`:132`](../lib/permissions.ts#L132)).
5. Else `read` + space `defaultRole === "read"` → allow ([`:144`](../lib/permissions.ts#L144)); else
   deny.

[`canGlobal`/`canSetRole`](../lib/permissions.ts#L163) gate org-level actions by a fixed minimum-role
matrix (Admin manages perms/groups/scopes + roles-up-to-Editor + audit; Super assigns Admin/Super +
org config). [`authorize`](../lib/authz.ts#L78) is the one enforcement entry point.

**Summary.** Super short-circuits; deny beats allow at any depth; unlisted-in-a-curated-space is
public-read.

## 10. The policy cache (`policyCache.ts`)

Grants + space policies drive nearly every decision and change rarely, so
[`cachedGrants`](../lib/server/policyCache.ts#L56) / [`cachedSpacePolicy`](../lib/server/policyCache.ts#L70)
memoize them per-`Database` for a short TTL (15s), keyed by a `WeakMap` so a discarded DB (test reset)
is GC'd with its cache. Every in-app grant/space write calls
[`invalidatePolicyCache`](../lib/server/policyCache.ts#L87), so a new grant/deny is exact on the next
read; the TTL only bounds *out-of-band* staleness. The resolver runs **unchanged** on whatever the
cache returns — the cache changes *which rows* it sees, never *how* it decides.

**Summary.** A safe, cheap memo for the two hottest, most-static collections.

## 11. The guest tier and TTL (`lib/guest.ts`, `lib/reaper.ts`)

A self-signup lands on role `guest`. Curated content spaces are created `defaultRole: "read"`
([`ensureSpace` · indexer.ts:37](../lib/git/indexer.ts#L37)), so a guest reads them via the space
default; personal `~` spaces stay `"none"`. When a guest creates a doc,
[`createDocAction`](../app/actions/docs.ts#L104) stamps expiry via
[`guestExpiryFields`](../lib/guest.ts#L32) — `{ expiresAt: <ms>, expiresAtDate: <Date> }`,
`GUEST_DOC_TTL_MS = 8h` ([`guest.ts:12`](../lib/guest.ts#L12)); non-guest docs get nothing and never
expire. Removal happens three ways: the **lazy sweep**
([`sweepExpiredDocs` · reaper.ts:45](../lib/reaper.ts#L45), invoked by
[`reapExpired`](../lib/server/data.ts#L160) before every read), the **read-time guard**
([`isExpiredGuestDoc`](../lib/guest.ts#L43) → `null`), and the **Mongo TTL index**. The on-demand
[`POST|GET /api/reaper`](../app/api/reaper/route.ts) is the cron-safe backstop. A reaped doc's
dependents — chunks, comments, suggestions, favorites, notifications, files, versions, and doc-scoped
grants — are all purged ([`purgeDocDependencies` · reaper.ts:21](../lib/reaper.ts#L21)).

Personal-space privacy ([`personalSpace.ts`](../lib/personalSpace.ts)): each user's `~` space is
`defaultRole: "none"` + one owner-`admin` grant, plus the listing filter that hides *other* users'
personal spaces from every tree.

> ⚠️ The guest tier is freshly landed and matches the code above, but dedicated TTL unit tests aren't
> written yet and two RBAC fixtures (`ask`/`search`) still encode the pre-guest default and are being
> updated — so `npm run test` isn't green on this exact revision.

**Summary.** Guests read the public library and edit only their own ephemeral notes.

## 12. The save engine (`lib/git/save.ts`)

[`saveDoc`](../lib/git/save.ts#L29): canonicalize → `store.write(path, canonical, { baseSha })` →
`indexPath`. The `baseSha` is the optimistic-concurrency token — a stale one throws `ConflictError`,
surfaced to the user as "reload to merge," never a silent clobber. [`trashDoc`](../lib/git/save.ts#L82)
soft-deletes (move under `_trash/`, de-index); [`restoreDoc`](../lib/git/save.ts#L100) inverts it;
[`moveDoc`](../lib/git/save.ts#L128) renames losslessly; and
[`migrateDocAttachments`](../lib/git/save.ts#L159) re-keys comments/suggestions/favorites **and
doc-scoped grants** on a rename, so a moved doc never orphans a `deny` grant (which would let it leak
through the space default).

**Summary.** Commit-per-change, conflict-guarded, with attachments (incl. grants) that follow the doc.

## 13. The indexer (`lib/git/indexer.ts`)

[`indexPath`/`indexAll`](../lib/git/indexer.ts) rebuild the `docs` projection from the store: read the
file, extract title/headings/body/front-matter, upsert the `docs` row, and re-chunk + re-embed via
[`reindexDocChunks`](../lib/rag/pipeline.ts#L12). It derives a doc's **space** from its top-level
folder ([`spaceKeyOf` :23](../lib/git/indexer.ts#L23)), creates a new content space
`defaultRole: "read"` (curated = public-read) — but a personal `~` key is forced to `"none"`
([`:37`](../lib/git/indexer.ts#L37)) — and skips the reserved `_trash/` prefix so trashed docs vanish
from every DB-driven view.

**Summary.** A full re-index reconstructs app state; the DB is disposable.

## 14. Search (`lib/search.ts`)

[`searchReadable`](../lib/search.ts#L130) builds a **keyword** list
([`keywordScore` :41](../lib/search.ts#L41) — title weighted, body mentions counted) and a
**semantic** list (best chunk cosine per doc), each dropped through
[`readableFilter`](../lib/search.ts#L68) *before ranking* (the security boundary), then fuses them
with **Reciprocal Rank Fusion** ([`:180`](../lib/search.ts#L180)). A non-positive cosine is discarded
— important with the local lexical embedder, where it means zero overlap.

**Summary.** Word-match OR meaning-match surfaces; both-match ranks highest; unreadable never shows.

## 15. Chunking & retrieval (`lib/rag`)

[`chunkMarkdown`](../lib/rag/chunker.ts#L144) splits a doc heading-aware into ~1000-char windows with
~120-char overlap, deterministically (diff-stable re-index).
[`reindexDocChunks`](../lib/rag/pipeline.ts#L12) embeds them and replaces the doc's prior chunks.
[`embed`](../lib/rag/embeddings.ts#L155) selects `voyage → openai → local`
([`embeddingProvider` :48](../lib/rag/embeddings.ts#L48)); the **local** fallback is a deterministic
FNV-1a hashing bag-of-words embedder (256-dim, L2-normalized) — lexical only, but reproducible.
[`retrieveReadableChunks`](../lib/search.ts#L86) returns the asker's top-k readable chunks by cosine.
[`askDocs`](../lib/rag/ask.ts#L30) numbers them, builds context, and synthesizes with `[n]` citations
— degrading to a relevant-docs listing offline.

**Summary.** Permission-first retrieval; a real embedder is an upgrade, not a requirement.

## 16. LLM router (`lib/llm.ts`)

[`complete`](../lib/llm.ts#L213) walks the provider chain for the resolved mode
([`CHAIN` :38](../lib/llm.ts#L38): `auto = anthropic → openai → ollama → openrouter → offline`),
skipping any provider whose key is absent (Ollama via a `/api/tags` probe), trying each, and returning
the first success — **always** terminating in the caller's deterministic `offline` function, so the
router never rejects. Transport is plain `fetch` per provider; the result records `provider`, `model`,
`latencyMs`, an indicative `costUsd`, and the `fallbacks` it skipped (surfaced on
[`status`](../lib/llm.ts#L274) → `/api/health` and the settings pane).

**Summary.** One reviewable chain; offline is the last resort, never the design centre.

## 17. The HTTP edges (`app/api`)

Route handlers cover what must be plain HTTP: [`GET /api/health`](../app/api/health/route.ts) (open);
[`GET /api/export`](../app/api/export/route.ts) (permission-filtered md/txt/zip — an unreadable doc
can't leave, even inside a space zip); [`POST /api/ingest`](../app/api/ingest/route.ts) (constant-time
`x-ingest-token` service auth, clean→categorize→commit→safety-scan);
[`POST /api/webhook/github`](../app/api/webhook/github/route.ts) (HMAC-verified re-index of a push);
[`POST/DELETE /api/breakglass`](../app/api/breakglass/route.ts) (scrypt-verified recovery session); and
[`POST/GET /api/reaper`](../app/api/reaper/route.ts) (idempotent guest sweep). The safety scanner
([`scanContent` · safety.ts:60](../lib/safety.ts#L60)) flags real secret *values* and PII while
skipping config-describing lines via its `ALLOW` filter.

**Summary.** Each edge authenticates by purpose: open, identity, service-token, HMAC, password, or safe.

## 18. The whole machine, end to end

A request arrives; [`middleware`](../middleware.ts) attaches Clerk context (or passes through).
[`currentPrincipal`](../lib/server/data.ts#L49) resolves who's acting and upserts them.
A **read** bootstraps + sweeps + projects + filters the tree ([§7](#7-reading-the-tree-and-one-doc-permission-filtered));
a **write** authorizes `edit` ([§9](#9-the-rbac-resolver-libpermissionsts)), canonicalizes, commits
with a `baseSha` guard, and re-indexes + re-embeds ([§12](#12-the-save-engine-libgitsavets),
[§13](#13-the-indexer-libgitindexerts)). **Search** and **Ask** filter by readability before ranking
and degrade to lexical/offline paths ([§14](#14-search-libsearchts)–[§16](#16-llm-router-libllmts)).
Guests read the public library and edit ephemeral notes that the reaper removes
([§11](#11-the-guest-tier-and-ttl-libguestts-libreaperts)). The repo stays truth; the DB stays a
rebuildable index; and every provider has a zero-key fallback the tests exercise.
