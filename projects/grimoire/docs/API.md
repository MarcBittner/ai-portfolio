# grimoire — API Reference

grimoire's "API" is its **server-side surface**: Next.js **server actions** (typed functions the
client calls directly, checked at compile time) and a handful of **route handlers** (`app/api/*`) for
things that must be plain HTTP — health, export, webhooks, and cron. There is no separate REST API
server and no client-callable data layer.

**Authentication.** Every server action resolves the acting identity server-side via
[`currentPrincipal()`](../lib/server/data.ts) — a signed-in Clerk user, a break-glass session, or (in
local zero-key dev only) a dev-seed Super Admin. The client never supplies its role. Mutations
authorize the specific capability through [`authorize`](../lib/authz.ts) (`canAccess`) or a global
role check ([`canGlobal`/`canSetRole`](../lib/permissions.ts)); reads return **empty/`null`** for
what the caller may not see (a 404-no-leak posture, never a 403 that would confirm existence).

**Route handlers** authenticate differently by purpose: `/api/health` is open; `/api/export` is
permission-filtered by the caller's identity; `/api/ingest` uses a constant-time service-token check;
`/api/webhook/github` verifies an HMAC signature; `/api/breakglass` checks a password; `/api/reaper`
is unauthenticated by design (it only ever removes already-expired rows).

Source: [`app/actions/`](../app/actions), [`app/api/`](../app/api).

---

## Contents

- [Server actions — reads](#server-actions--reads)
- [Server actions — writes](#server-actions--writes)
- [Server actions — admin & AI](#server-actions--admin--ai)
- [Route handlers (HTTP)](#route-handlers-http)
- [The authorization pattern](#the-authorization-pattern)

---

## Server actions — reads

Reads are permission-filtered: an unreadable doc never appears. Unless noted, they require a
signed-in principal and return an empty result otherwise.

| Action | Args | Returns |
|---|---|---|
| `searchAction` ([search.ts](../app/actions/search.ts)) | `query` | `SearchResult[]` — hybrid keyword+semantic hits, permission-filtered, RRF-ranked. |
| `askAction` ([ask.ts](../app/actions/ask.ts)) | `question` | `{ answer, sources[], provider }` — RAG answer with `[n]` citations over the asker's readable chunks; a relevant-docs listing when no LLM is configured. |
| `getBrowseDocs` ([browse.ts](../app/actions/browse.ts)) | — | `BrowseDoc[]` — readable docs enriched with status/owner/tags/summary. |
| `getBacklinks` ([backlinks.ts](../app/actions/backlinks.ts)) | `path` | `{ path, title }[]` — readable docs linking to `path`. |
| `getDocHistory` ([history.ts](../app/actions/history.ts)) | `path` | `HistoryItem[]` — change timeline (READ-gated). |
| `listVersions` ([versions.ts](../app/actions/versions.ts)) | `path` | version list (READ-gated). |
| `getVersionDiff` ([versions.ts](../app/actions/versions.ts)) | `path, version` | diff vs current, or `null`. |
| `listComments` ([comments.ts](../app/actions/comments.ts)) | `path` | `CommentView[]` (READ-gated). |
| `listSuggestions` / `countOpenSuggestions` ([suggestions.ts](../app/actions/suggestions.ts)) | `path` | proposals on a doc (READ-gated). |
| `listFavorites` / `isFavorite` ([favorites.ts](../app/actions/favorites.ts)) | — / `path` | the caller's favorites, intersected with the currently-readable set. |
| `listNotifications` ([notifications.ts](../app/actions/notifications.ts)) | — | the caller's notifications, re-authorized at read time. |
| `listTrash` ([trash.ts](../app/actions/trash.ts)) | — | soft-deleted docs (EDIT-gated on the original path). |
| `getActivity` ([activity.ts](../app/actions/activity.ts)) | — | recent activity; role/grant changes shown only to managers. |
| `getContentHealth` ([health.ts](../app/actions/health.ts)) | — | stale/orphaned/stub docs from the readable set. |
| `getRoutingConfig` ([routing.ts](../app/actions/routing.ts)) | — | the current LLM routing mode. |

## Server actions — writes

Every mutation authorizes the capability server-side before touching the store. `SaveResult` is
`{ ok: true, sha } | { ok: false, error, conflict? }`.

| Action | Args | Effect / auth |
|---|---|---|
| `createDocAction` ([docs.ts](../app/actions/docs.ts)) | `{ path, content }` | Create a doc (fails if it exists). **EDIT**-gated. For a **guest** author, stamps an 8h expiry ([`guestExpiryFields`](../lib/guest.ts)). |
| `saveDocAction` ([docs.ts](../app/actions/docs.ts)) | `{ path, content, baseSha?, message? }` | Canonicalize → commit → re-index. **EDIT**-gated. Stale `baseSha` → `{ ok:false, conflict:true }`, never a clobber. |
| `moveDocAction` ([docs.ts](../app/actions/docs.ts)) | `{ from, to }` | Rename/move; **EDIT on both** source and destination; migrates comments/suggestions/favorites/**grants** to the new path. |
| `deleteDocAction` ([docs.ts](../app/actions/docs.ts)) | `{ path }` | **Soft delete** (move to `_trash/`, recoverable). **EDIT**-gated. |
| `restoreDocAction` / `purgeDocAction` ([trash.ts](../app/actions/trash.ts)) | `trashPath` | Restore (reversible) / hard-purge. EDIT-gated on the original path. |
| `rollbackToVersion` ([versions.ts](../app/actions/versions.ts)) | `path, version` | Roll back as a **new versioned save** (never destructive). **EDIT**-gated. |
| `addComment` / `resolveComment` / `deleteComment` ([comments.ts](../app/actions/comments.ts)) | `path, body` / `id` | READ to add; EDIT or authorship to resolve/delete. Mentions notify only users who can READ the doc. |
| `submitSuggestion` / `acceptSuggestion` / `rejectSuggestion` ([suggestions.ts](../app/actions/suggestions.ts)) | see file | READ to propose/list; **EDIT to accept** (applies the proposed content as a save); authorship to withdraw. |
| `toggleFavorite` ([favorites.ts](../app/actions/favorites.ts)) | `path` | Toggle the caller's favorite (user-scoped). |
| `markRead` / `markAllRead` ([notifications.ts](../app/actions/notifications.ts)) | `id` / — | Mark the caller's notifications read. |
| `importMarkdownAction` ([import.ts](../app/actions/import.ts)) | `FormData` (`.md`/`.zip`) | Import files; **each file EDIT-authorized on its target path**; optional AI auto-categorization. |
| `collabTicket` ([collab.ts](../app/actions/collab.ts)) | `path` | Mint a Yjs WS ticket; `null` unless configured and the caller has EDIT. |

## Server actions — admin & AI

| Action | Args | Auth |
|---|---|---|
| `getAdminData` ([admin.ts](../app/actions/admin.ts)) | — | `managePermissions` (Admin/Super). |
| `setUserRoleAction` ([admin.ts](../app/actions/admin.ts)) | `email, role` | `canSetRole` — Admin ≤ Editor, Super any; seed Super Admins immutable. |
| `addGrantAction` / `removeGrantAction` ([admin.ts](../app/actions/admin.ts)) | `grant` / `id` | Admin/Super; a non-Super Admin may only manage grants within a space they can already see. |
| `setRoutingConfig` ([routing.ts](../app/actions/routing.ts)) | `cfg` | Admin/Super (read is any signed-in user). |
| `reindexEmbeddings` ([reindex.ts](../app/actions/reindex.ts)) | — | `managePermissions`; re-chunks + re-embeds the corpus. |
| `safetyAudit` ([safety.ts](../app/actions/safety.ts)) | — | Admin/Super; scans the caller's readable set for secrets/PII/etc. |
| `getSources` / `setSources` / `auditCategorization` / `applyRecategorization` ([sources.ts](../app/actions/sources.ts)) | see file | read = any signed-in; write/audit = Admin/Super; proposals are review-only (no auto-apply). |
| `assistAction` ([ai.ts](../app/actions/ai.ts)) | `kind, input` | Any signed-in user. Draft/expand/proofread as a **proposal** — never writes or bypasses permissions. |
| `routingStatus` ([ai.ts](../app/actions/ai.ts)) | — | Which providers are reachable right now (drives the settings pane). |
| `previewIngest` / `commitIngest` ([ingest.ts](../app/actions/ingest.ts)) | `source, raw` / … | Preview = no-save review; commit checks EDIT on the target path. |

## Route handlers (HTTP)

| Route | Method | Auth | Purpose |
|---|---|---|---|
| `/api/health` ([route.ts](../app/api/health/route.ts)) | GET | none | Health check for Render/Vercel → `{ status:"ok", … }`. |
| `/api/export` ([route.ts](../app/api/export/route.ts)) | GET | caller identity | `?path=<doc>&format=md\|txt` → one doc; `?space=<key>&format=md\|txt\|zip` → a bundle. **Permission-filtered** — an unreadable doc can never be exported, even inside a space zip. |
| `/api/ingest` ([route.ts](../app/api/ingest/route.ts)) | POST | `x-ingest-token` (constant-time; disabled if `INGEST_TOKEN` unset) | Service-token content ingest (email/clickup/markdown): clean → categorize → commit as the ingest bot; safety-scans and returns `{ imported, skipped, flagged }`. Destination must be an existing space. |
| `/api/webhook/github` ([route.ts](../app/api/webhook/github/route.ts)) | POST | HMAC `x-hub-signature-256` | Two-way sync: re-index the Markdown paths a push changed. Only the tracked branch mutates the projection. |
| `/api/breakglass` ([route.ts](../app/api/breakglass/route.ts)) | POST / DELETE | password vs `BREAKGLASS_PASSWORD_HASH` | POST verifies the recovery password and sets a signed httpOnly session cookie (2h); DELETE clears it. Disabled unless both break-glass env vars are set. |
| `/api/reaper` ([route.ts](../app/api/reaper/route.ts)) | POST / GET | none (safe) | Sweep expired guest docs + dependents → `{ status:"ok", swept, paths }`. Idempotent and cron-safe: it only ever removes rows already past their own stamped expiry. |

## The authorization pattern

Every mutating server action follows the same shape — resolve identity, authorize the exact
capability on the exact resource, then act:

```ts
const principal = await currentPrincipal();
if (!principal) return { ok: false, error: "Not signed in." };

const decision = await authorize(
  database,
  principal.email,
  { type: "doc", path, spaceKey: spaceKeyOf(path) },
  "edit",                       // "read" | "edit" | "admin"
);
if (!decision.allowed) return { ok: false, error: "No access." };
// … store write …
```

The resource's `spaceKey` is derived from its path ([`spaceKeyOf`](../lib/git/indexer.ts#L23)), and
`authorize` reads role + groups + **cached** grants + **cached** space policy before running the pure
deny-wins resolver. The client's input never includes a role or a grant it wishes it had — those come
from the server-resolved identity and the store. See [`ARCHITECTURE.md` §6](./ARCHITECTURE.md#6-the-rbac-core-libpermissionsts).
