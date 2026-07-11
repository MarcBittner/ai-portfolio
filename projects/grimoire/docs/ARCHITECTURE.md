# grimoire — Software Architecture

A complete, read-it-once reference for how grimoire works end to end. Pair with
[`DEPLOYMENT.md`](./DEPLOYMENT.md) for the infra/deploy side, [`API.md`](./API.md) for the callable
surface, and [`WALKTHROUGH.md`](./WALKTHROUGH.md) for a file-by-file code tour.

> **One sentence:** a Next.js app puts a reactive, permission-aware layer over **Markdown-in-Git as
> the source of truth** — every save is a canonical commit, every access is decided by a pure
> deny-wins RBAC resolver, and every external dependency (DB, Git host, LLM, embeddings, auth) sits
> behind a swappable adapter with a zero-key offline fallback.

Status legend: ✅ shipped · ◐ partial (needs config) · 🔭 planned · ⚠️ caveat.

---

## Contents

- [1. The thesis](#1-the-thesis-why-its-built-this-way)
- [2. Stack & topology](#2-stack--topology)
- [3. The adapters (swap by env)](#3-the-adapters-swap-by-env)
- [4. Data model](#4-data-model-librepots)
- [5. Request lifecycle (read & write)](#5-request-lifecycle-read--write)
- [6. The RBAC core](#6-the-rbac-core-libpermissionsts)
- [7. Identity, personal spaces, guest tier & TTL](#7-identity-personal-spaces-guest-tier--ttl)
- [8. Canonical Markdown & the editor](#8-canonical-markdown--the-editor)
- [9. Search & RAG](#9-search--rag)
- [10. LLM & embeddings routing](#10-llm--embeddings-routing)
- [11. Security surfaces](#11-security-surfaces)
- [12. App surface](#12-app-surface-app)
- [13. Design decisions & tradeoffs](#13-design-decisions--tradeoffs)
- [14. Future development](#14-future-development)

**Source map — jump to the code:**

| Concept | Source |
|---|---|
| RBAC resolver (pure, deny-wins) | [`lib/permissions.ts`](../lib/permissions.ts) |
| Enforcement + login upsert | [`lib/authz.ts`](../lib/authz.ts) |
| Personal spaces / guest TTL | [`lib/personalSpace.ts`](../lib/personalSpace.ts) · [`lib/guest.ts`](../lib/guest.ts) · [`lib/reaper.ts`](../lib/reaper.ts) |
| Store selection + identity | [`lib/server/data.ts`](../lib/server/data.ts) |
| Persistence adapters | [`lib/db/`](../lib/db) |
| GitStore + save/index | [`lib/git/`](../lib/git) |
| Canonical Markdown | [`lib/markdown.ts`](../lib/markdown.ts) |
| Search + RAG | [`lib/search.ts`](../lib/search.ts) · [`lib/rag/`](../lib/rag) |
| LLM / embeddings routers | [`lib/llm.ts`](../lib/llm.ts) · [`lib/rag/embeddings.ts`](../lib/rag/embeddings.ts) |
| Server actions / route handlers | [`app/actions/`](../app/actions) · [`app/api/`](../app/api) |

---

## 1. The thesis (why it's built this way)

Three commitments drive every structural choice.

**The repo is truth; the DB is a projection.** Content lives as Markdown files in a Git repository
reached through a `GitStore`. The `docs` collection (title, headings, body, chunks) is an *index* of
that content, rebuilt by [`indexAll`](../lib/git/indexer.ts). Lose the DB and a re-index rebuilds it;
the durable, attributable, reversible artifact is always the Git history. ✅

**Authority is computed, never asserted.** The browser sends no trusted role. Identity is resolved
server-side, and role/groups/grants/space-policy are read server-side and handed to a pure resolver.
The security logic ([`lib/permissions.ts`](../lib/permissions.ts)) has no I/O, so it's testable in
isolation and behaves identically regardless of which store produced the grants. ✅

**Zero-key by default; providers are additive.** In-memory store, Clerk shim, local hash embedder,
deterministic offline LLM. Nothing external is required to boot. Each provider self-selects from the
environment and is only ever an *upgrade* — the fallbacks are real code paths the tests exercise. ✅

---

## 2. Stack & topology

| Layer | Tech | Role |
|---|---|---|
| Frontend | **Next.js 16** (App Router, RSC), React 19, Tailwind v4 | public landing + the `/app` workspace |
| Server tier | Next.js **server actions** + **route handlers** | the only tier that touches data |
| Persistence | in-memory **or MongoDB** (adapter) | the `docs` index + app collections |
| Source of truth | **GitStore**: local clone · Mongo-backed · **GitHub Contents API** | Markdown files, commit-per-change |
| Auth | **Clerk** (identity only) · shim when unconfigured · break-glass | who is acting |
| Editor | **TipTap 3** (WYSIWYG) + raw textarea + **Yjs** (optional collab) | the three editing surfaces |
| AI | Anthropic · OpenAI · Ollama · OpenRouter · offline | generation; Voyage/OpenAI/local for embeddings |
| Host | **Render** (Docker; Vercel-portable) | one stateless web service (+ optional collab WS) |

Unlike its portfolio sibling *trueline* (Convex-backed), grimoire is a **single Next.js app** whose
server actions call swappable adapters directly — there is no separate backend service and no
websocket data layer (collaboration is an isolated, optional Yjs service).

```
 Browser
   │  server action / route handler   (the ONLY tier that touches data)
   ▼
 Next.js (server)
   1. currentPrincipal()   identity: break-glass → Clerk (when configured) → dev-seed (local only)
   2. authorize()          canAccess(): role + groups + grants + space policy   ─┐ pure,
   3a. read   repos(db) ──► docs index  (a projection of the repo)               │ server-
   3b. write  saveDoc() ──► canonicalize → GitStore.commit → re-index path       │ enforced
   4. AI      llm.complete()   ·   rag: retrieve (permission-first) → synthesize ─┘
   ▲
 GitHub push webhook ── HMAC-verified ── re-index changed paths  (2-way sync, optional)
```

---

## 3. The adapters (swap by env)

Each interface has a zero-key default and self-selects a stronger backend from the environment. The
selection is a single branch — no build flags, no code change.

| Concern | Interface | Selection (verbatim) |
|---|---|---|
| **Persistence** | `Database` | `MONGODB_URI` set → Mongo, else in-memory ([`lib/db/index.ts:17`](../lib/db/index.ts#L17)) |
| **Source of truth** | `GitStore` | `GITHUB_TOKEN` + `DOCS_REPO` → GitHub API; else `MONGODB_URI` → Mongo store; else local clone ([`lib/server/data.ts:32`](../lib/server/data.ts#L32)) |
| **Generation** | `complete()` | provider available iff its key is set (Ollama iff a probe answers); chained by mode ([`lib/llm.ts:38`](../lib/llm.ts#L38)) |
| **Embeddings** | `embed()` | `voyage → openai → local`, honoring `EMBEDDINGS_PROVIDER` only if its key is present ([`lib/rag/embeddings.ts:48`](../lib/rag/embeddings.ts#L48)) |

The three `GitStore` implementations model **the same contract**: `listMarkdown` / `read` / `write`
(commit-per-change, returns the new blob sha, throws `ConflictError` on a stale `baseSha`) / `remove`
([`lib/git/types.ts`](../lib/git/types.ts)). So the indexer and save engine never depend on *how* the
repo is reached — local dev, a read-only-FS deployment (Mongo store), or production GitHub are one
code path.

---

## 4. Data model ([`lib/repos.ts`](../lib/repos.ts))

The `Database` interface is a minimal Mongo-shaped collection API — `insert`, `findOne`, `find`,
`findProjected`, `update`, `upsert`, `delete`, `count`
([`lib/db/types.ts:29`](../lib/db/types.ts#L29)). `repos(db)` binds the typed collections:

| Collection | Shape (key fields) | Notes |
|---|---|---|
| `users` | `email, role, clerkId?, name?, createdAt` | `role ∈ guest\|read\|editor\|admin\|super` |
| `grants` | `subjectType, subjectId, resourceType, resourcePath, capability, effect` | the RBAC rows; `effect ∈ allow\|deny` |
| `groups` / `groupMembers` | `key, name` / `groupKey, email` | group defs + memberships |
| `spaces` | `key, name, contentRoot, defaultRole, prWorkflow, owner?` | `defaultRole ∈ read\|none`; `owner` set ⇒ personal `~` space |
| `docs` | `path, spaceKey, title, headings[], body, blobSha, updatedAt, …meta, expiresAt?, expiresAtDate?` | the repo projection; guest-only expiry fields |
| `chunks` | `path, spaceKey, headingPath, charStart/End, text, vector[]` | RAG vectors; filtered by path/space at query time |
| `comments` / `suggestions` | doc-scoped collaboration rows | mentions, propose-then-accept edits |
| `favorites` / `notifications` | per-user rows | user-scoped, re-authorized at read time |
| `files` / `versions` | `path, content, sha, version` / append-only snapshots | back the **Mongo GitStore** (durable content + history on a read-only FS) |
| `audit` | `actorEmail, action, targetType, targetId, before?, after?, at` | append-only trail |
| `settings` | `key, value` | singletons (LLM routing) |

The `docs` guest fields are the physical trace of the TTL feature: `expiresAt` (numeric ms, drives
the in-memory sweep — the local store's source of truth) and `expiresAtDate` (BSON `Date`, backs the
Mongo TTL index). Both are **absent on non-guest docs** ([`lib/repos.ts:60`](../lib/repos.ts#L60)).

---

## 5. Request lifecycle (read & write)

### Read

1. `bootstrapIndexIfEmpty()` runs the repo→DB index once if the `docs` collection is empty (a
   process-wide latch avoids a full-collection count on the hot path;
   [`lib/server/data.ts:126`](../lib/server/data.ts#L126)). ✅
2. `reapExpired()` runs the guest sweep, once per request (React `cache`), best-effort — a failed
   sweep never blocks the read ([`lib/server/data.ts:160`](../lib/server/data.ts#L160)). ✅
3. `currentPrincipal()` resolves identity + role + groups.
4. `listReadableDocs()` projects `docs` to `{path, title, spaceKey}`, drops other users' personal
   spaces via [`isPersonalSpaceVisibleTo`](../lib/personalSpace.ts#L51), then runs `canAccess(…,
   "read", …)` per doc against **cached** grants + space policy ([`lib/server/data.ts:171`](../lib/server/data.ts#L171)).
5. A single doc goes through `getReadableDoc(path)` — returns `null` (→ 404) if unreadable or expired.

### Write ([`saveDoc`](../lib/git/save.ts#L29))

1. The server action authorizes `edit` on the path ([`app/actions/docs.ts:34`](../app/actions/docs.ts#L34)).
2. `canonicalize(content)` normalizes the Markdown to one stable form (clean diffs;
   [`lib/markdown.ts:44`](../lib/markdown.ts#L44)).
3. `store.write(path, canonical, { …, baseSha })` commits it authored as the user. If `baseSha`
   no longer matches HEAD, the store raises `ConflictError` — surfaced as a "reload to merge" result,
   never a silent clobber ([`lib/git/types.ts:32`](../lib/git/types.ts#L32)).
4. `indexPath(db, store, path)` re-reads the file, extracts title/headings/body, upserts the `docs`
   row, and re-chunks + re-embeds it ([`reindexDocChunks`](../lib/rag/pipeline.ts#L12)).
5. For a **guest** author, `createDocAction` then stamps the expiry fields — after the index write,
   because indexing is role-agnostic; the upsert merges so they survive later re-indexes
   ([`app/actions/docs.ts:104`](../app/actions/docs.ts#L104)).

Delete is a **soft delete**: the doc is moved under a `_trash/` prefix (still in Git, recoverable)
and de-indexed ([`trashDoc`](../lib/git/save.ts#L82)); "empty trash" is a hard `store.remove`. A
rename **re-keys attachments** — comments, suggestions, favorites, and critically doc-scoped grants —
so a moved doc never orphans a `deny` grant and leaks through the space default
([`migrateDocAttachments`](../lib/git/save.ts#L159)). ✅

---

## 6. The RBAC core ([`lib/permissions.ts`](../lib/permissions.ts))

Pure functions, no I/O. Two surfaces:

**Resource access — `canAccess`** ([`:105`](../lib/permissions.ts#L105)). Ranks: roles
`guest 0 < read 1 < editor 2 < admin 3 < super 4`; capabilities `read 1 < edit 2 < admin 3`.

```
1. super                       → allow (short-circuit)
2. matching = grants where subjectMatches(principal) ∧ resourceMatches(resource ∪ ancestors)
3. deny wins:  any matching deny with cap ≥ requested            → DENY  (most-specific cited)
4. allow:      any matching allow with cap ≥ requested           → ALLOW (most-specific cited)
5. space default:  capability == read ∧ spacePolicy == "read"    → ALLOW
6. otherwise                                                     → DENY  ("no matching grant")
```

- **Subject matching** ([`:64`](../lib/permissions.ts#L64)): `user` by email (case-insensitive),
  `group` by membership, `role` **by rank ≥** — so a `role:read` grant applies to read-and-above.
  This is why a `guest` (rank 0) satisfies **no** `role:read` grant, yet still reads curated spaces
  via the space default.
- **Resource matching** ([`:76`](../lib/permissions.ts#L76)): `space` exact, `doc` exact path,
  `folder` prefix on a **segment boundary** (`a/b` ⊉ `a/bc`).
- Every decision carries an explainable `reason` and the deciding grant.

**Global actions — `canGlobal` / `canSetRole`** ([`:163`](../lib/permissions.ts#L163)): a fixed
minimum-role matrix. `managePermissions`, `manageGroupsScopes`, `manageRolesUpToEditor`, `viewAudit`
→ `admin`; `assignAdmin`, `assignSuperAdmin`, `orgConfig` → `super`. `canSetRole`: Super sets any;
Admin sets up to Editor; nobody else.

**Enforcement** — [`authorize`](../lib/authz.ts#L78) is the single entry point: load principal, read
cached grants + cached space policy, run `canAccess`, return the `Decision`. Callers gate on
`.allowed`. Admin server actions additionally use `canGlobal`/`canSetRole` and restrict a non-Super
Admin to grants within spaces they can already see ([`app/actions/admin.ts:27`](../app/actions/admin.ts#L27)). ✅

**Policy cache** ([`lib/server/policyCache.ts`](../lib/server/policyCache.ts)): `grants` and space
policies are memoized per-`Database` for a short TTL (15s) because they drive nearly every decision
and change rarely. Every in-app write to grants/spaces calls `invalidatePolicyCache`, so a new
grant/deny is exact on the next read; the TTL only bounds staleness for out-of-band edits. The
resolver runs **unchanged** on whatever the cache returns — the cache affects *which rows* it sees,
never *how* it decides. ✅

---

## 7. Identity, personal spaces, guest tier & TTL

**Identity resolution** ([`resolveIdentity`](../lib/server/data.ts#L61), precedence order):

1. **Break-glass** — a signed recovery session (HMAC keyed on the password hash), active only when
   `BREAKGLASS_EMAIL` + `BREAKGLASS_PASSWORD_HASH` are set; the email must be a seed Super Admin
   ([`lib/breakglass.ts`](../lib/breakglass.ts)). ◐
2. **Clerk** — when `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` is set, the signed-in user; the email must
   pass `canSelfSignUp` (verified + on `SIGNUP_ALLOWED_DOMAIN`, or a seed admin), else the request is
   **anonymous read-only** — never auto-provisioned, and never the dev-seed identity. ◐
3. **Dev-seed** — no Clerk configured → the first seed Super Admin, **local only** (null in
   production, so a public URL shows nothing until a real user signs in;
   [`lib/server/data.ts:106`](../lib/server/data.ts#L106)). ✅

`upsertUserOnLogin` ([`lib/authz.ts:18`](../lib/authz.ts#L18)) idempotently seeds Super Admins,
gives first-time users the default role, writes an audit row on any role change, and provisions the
personal space (best-effort — never fails login).

**Personal spaces** ([`lib/personalSpace.ts`](../lib/personalSpace.ts)): key `~<slug-of-email>`,
`defaultRole: "none"`, one owner-`admin` grant. Two layers of privacy: (1) the resolver denies
non-owners (closed default + no matching grant), and (2)
[`isPersonalSpaceVisibleTo`](../lib/personalSpace.ts#L51) filters other users' personal spaces out of
every tree — so not even a Super sees them in the sidebar (they *could* reach one via direct access;
the listing filter is defense-in-depth). Created idempotently; invalidates the policy cache on
insert. ✅

**Guest tier & 8h TTL:**

```
self-signup ── upsertUserOnLogin ── resolveRoleOnLogin ──► role "guest"   (authPolicy.ts:34)
guest creates a doc ── createDocAction ── guestExpiryFields(role, now) ──► stamp {expiresAt, expiresAtDate}
                                                                             (8h = GUEST_DOC_TTL_MS, guest.ts:12)
expiry enforced 3 ways:
  • lazy sweep  reapExpired() → sweepExpiredDocs()   before every read     (reaper.ts:45, data.ts:160)
  • read guard  getReadableDoc → isExpiredGuestDoc → null (404)            (guest.ts:43)
  • Mongo TTL   index ttl_docs_expiresAt on expiresAtDate, expireAfterSeconds:0  (mongo.ts:41)
explicit backstop:  POST|GET /api/reaper  (idempotent, cron-safe, unauthenticated)  (api/reaper/route.ts)
reaped doc → purgeDocDependencies: chunks, comments, suggestions, favorites, notifications,
             files, versions, and doc-scoped grants                        (reaper.ts:21)
```

The numeric `expiresAt` + lazy sweep are the source of truth for the in-memory store and give
*immediate* expiry; the Mongo TTL monitor only runs ~once a minute, so the sweep + `/api/reaper`
keep it prompt there too.

> ⚠️ The guest tier is freshly landed. The behavior above matches the code, but dedicated unit tests
> for the TTL helpers are not yet written, and two pre-existing RBAC fixtures (`ask`/`search`) still
> encode the pre-guest space default and are being updated — so the suite is not green on this exact
> revision (2 failing at time of writing). Marked ◐ pending its own tests.

---

## 8. Canonical Markdown & the editor

[`lib/markdown.ts`](../lib/markdown.ts) is the **single serializer** that makes the WYSIWYG↔source
round-trip safe. `canonicalize(md)` normalizes to one stable, GFM-friendly form via remark/unified
(bullet `-`, emphasis `_`, strong `*`, fenced code, etc.), so parse→serialize is idempotent
([`:44`](../lib/markdown.ts#L44)) — editing in either surface never reflows unrelated lines, which
keeps Git diffs clean. It also carries the index helpers (`extractTitle`, `extractHeadings`,
front-matter read/upsert, `stripFrontmatter`) used by the indexer and importers. Pure, so it runs on
both the client editor and server-side commit/index code. ✅

The editor ([`app/components/editor.tsx`](../app/components/editor.tsx),
[`wysiwyg.tsx`](../app/components/wysiwyg.tsx)) offers three surfaces — WYSIWYG (TipTap 3), raw
Source, and a live Preview — over that one canonical form. Rendering uses `react-markdown` + `remark-gfm`
+ `rehype-sanitize`, so displayed content is sanitized GFM. Live multi-cursor co-editing (Yjs) is
**optional**, activated by `COLLAB_WS_URL` against an isolated WebSocket service so the app stays
stateless ([`app/actions/collab.ts`](../app/actions/collab.ts)). ◐

---

## 9. Search & RAG

**Search** ([`searchReadable`](../lib/search.ts#L130)) fuses two signals with **Reciprocal Rank
Fusion** (RRF, `k≈60`):

- **Keyword** — a lexical score over title (weighted ×2) + body mention count
  ([`keywordScore`](../lib/search.ts#L41)).
- **Semantic** — the best readable chunk's cosine per doc, over the `chunks` vectors. A non-positive
  cosine carries no signal and is dropped (important with the local lexical embedder).

Both are **permission-filtered before ranking** by a shared `readableFilter`
([`:68`](../lib/search.ts#L68)) — the security boundary: an unreadable doc/chunk is dropped *before*
it can be ranked or returned. A doc strong in either signal surfaces; strong in both ranks highest.

**RAG / Ask-the-docs** ([`askDocs`](../lib/rag/ask.ts#L30)): retrieve the asker's top-k readable
chunks ([`retrieveReadableChunks`](../lib/search.ts#L86)), build a numbered context, and synthesize
an answer with inline `[n]` citations through the LLM router. The system prompt constrains the model
to answer *only* from context and say so when the answer isn't there
([`lib/rag/ask.ts:25`](../lib/rag/ask.ts#L25)). With no provider it **degrades to a relevant-docs
listing** rather than fabricating. Permission-first: it never sees or cites a doc the asker can't
read. ✅

**Chunking/embedding** ([`lib/rag/pipeline.ts`](../lib/rag/pipeline.ts)): on every index/save, a doc
is split heading-aware into ~1000-char windows with ~120-char overlap
([`chunkMarkdown`](../lib/rag/chunker.ts#L144)), embedded, and its prior chunks replaced —
deterministic, so re-indexing is diff-stable.

---

## 10. LLM & embeddings routing

**LLM** ([`lib/llm.ts`](../lib/llm.ts)). `complete({prompt, system, offline, mode})` walks a provider
chain for the resolved mode, skips any provider whose key is absent (Ollama: a `/api/tags` probe),
tries each, and returns the first success — **always** terminating in the caller-supplied
deterministic offline function, so the router never rejects.

| `mode` | order |
|---|---|
| `auto` (default) | `anthropic → openai → ollama → openrouter → offline` |
| `paid` | `anthropic → openai → offline` |
| `local` | `ollama → offline` · `free` | `openrouter → offline` · `offline` | offline only |

Transport is plain `fetch` (no SDK): Anthropic `/v1/messages`, OpenAI/OpenRouter
`/v1/chat/completions`, Ollama `/api/generate`. The result records `provider`, `model`, `latencyMs`,
an indicative `costUsd`, and the `fallbacks` it skipped — surfaced on `/api/health` and the settings
pane. Keys are server-side only. ◐ (offline works with zero keys; a real model needs a key)

**Embeddings** ([`lib/rag/embeddings.ts`](../lib/rag/embeddings.ts)) mirror that shape:
`voyage → openai → local`, honoring `EMBEDDINGS_PROVIDER` only when its key is present. The **local**
fallback is a deterministic FNV-1a hashing bag-of-words embedder (256-dim, L2-normalized) — crude
(lexical only) but reproducible, keeping semantic search degraded-but-working and retrieval tests
deterministic. ✅

---

## 11. Security surfaces

- **RBAC** — pure, deny-wins, Super-short-circuit, 404-no-leak; server-enforced on every call (§6). ✅
- **Break-glass** — a scrypt-hashed local Super credential for SSO outages; only the hash lives in
  env, sessions are HMAC-signed and short-lived (2h), all comparisons constant-time
  ([`lib/breakglass.ts`](../lib/breakglass.ts)). ◐
- **GitHub webhook HMAC** — inbound pushes are verified with a constant-time HMAC-SHA256 check on
  `x-hub-signature-256` before any re-index, and only pushes to the tracked branch mutate the
  projection ([`lib/git/webhook.ts:9`](../lib/git/webhook.ts#L9)). ◐
- **Ingest token** — the service ingest endpoint authenticates a *service* via a constant-time
  `x-ingest-token` check and is disabled when `INGEST_TOKEN` is unset
  ([`app/api/ingest/route.ts:49`](../app/api/ingest/route.ts#L49)). ◐
- **Content-safety scanner** — [`lib/safety.ts`](../lib/safety.ts) flags real secret *values*, PII/HR
  data, and contact info at ingest/save time (with redacted snippets), while ignoring docs that merely
  *describe* config (`process.env`, `<ENV_VAR>`, "ask your manager") — surfaced for review, never
  auto-blocking. ✅
- **Path safety** — server actions reject traversal / absolute / non-Markdown paths
  ([`app/actions/docs.ts:12`](../app/actions/docs.ts#L12)). ✅

---

## 12. App surface (`app/`)

- `/` — public landing. `/break-glass` — SSO-recovery login (outside `/app`).
- `/app` — the workspace shell; the sidebar is built from `listReadableDocs()` (permission-scoped).
- `/app/browse` · `/app/doc/[...path]` · `/app/edit/[...path]` · `/app/new` — browse, read, edit,
  create. `/app/search` — hybrid search. `/app/trash` — recover soft-deleted docs.
- `/app/activity` · `/app/health` — audit/activity feed and content-health.
- `/app/import` · `/app/ingest` · `/app/sources` — import/convert, external ingest, source mgmt.
- `/app/settings` — LLM routing + appearance. `/app/about` — what it is.

Route handlers: `GET /api/health`, `GET /api/export` (permission-filtered md/txt/zip),
`POST /api/ingest` (service-token), `POST /api/webhook/github` (HMAC), `POST /api/breakglass`,
`POST|GET /api/reaper`. Full detail in [`API.md`](./API.md).

---

## 13. Design decisions & tradeoffs

- **Single Next.js app over a separate backend** — server actions call adapters directly; no API
  server, no data websocket. Simpler to deploy and reason about; the tradeoff (no built-in realtime
  subscriptions) is why live collaboration is an isolated optional Yjs service. ✅
- **Adapters with zero-key fallbacks over hard dependencies** — the app runs for a reviewer with no
  accounts and the tests are offline/deterministic; the cost is a second (fallback) code path per
  adapter, which is exactly what keeps the tests honest. ✅
- **Pure resolver over inline checks** — one testable security core, reused by `authorize`, search,
  RAG, listings, and the admin pane; the tradeoff is the policy cache needed to keep it cheap. ✅
- **Canonical Markdown over free-form** — clean diffs and a safe WYSIWYG↔source round-trip; the cost
  is that a save normalizes formatting (intended). ✅
- **Limitations** — local hash embedder is lexical, not semantic (⚠️ set an embeddings key for real
  semantics); Mongo TTL runs ~1×/min (mitigated by the numeric mirror + sweep); guest-tier tests are
  in progress (⚠️ §7). Called out, not hidden.

---

## 14. Future development

- **Guest-tier test coverage** — unit tests for `GUEST_DOC_TTL_MS`, `guestExpiryFields`,
  `isExpiredGuestDoc`, and `sweepExpiredDocs`; update the two RBAC fixtures to the curated-public
  default so `npm run test` is green.
- **Scheduled reaper** — wire `POST /api/reaper` to a platform cron (Render Cron / GitHub Action /
  Vercel Cron) so guest docs are reaped even without read traffic; the route already exists.
- **PR workflow** — `spaces.prWorkflow` exists in the schema; route protected-space edits through a
  proposal/merge flow rather than a direct commit.
- **Richer embeddings + reranking** — default to a real embeddings provider and add a rerank pass so
  semantic search stops leaning on the lexical fallback.
- **Conversion sidecar** — a `CONVERSION_SERVICE_URL` (docx/pdf → Markdown) so import accepts binary
  formats, not just `.md`/`.zip`.
- **Realtime app data** — optional subscriptions so the doc tree/search update live across clients
  (today the collab WS covers editor presence only).
