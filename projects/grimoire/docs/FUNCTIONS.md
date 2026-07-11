# grimoire — Capability Map (what the app does, how, and where)

This maps every **thing the product does** to the code that does it. Each entry has three parts:
**What happens** (the behavior), **How the code works** (the mechanism), and the linked code
(`file:Lnnn` — the named function is the stable reference). System view:
[`ARCHITECTURE.md`](./ARCHITECTURE.md). Line-by-line narrative: [`WALKTHROUGH.md`](./WALKTHROUGH.md).
Callable surface: [`API.md`](./API.md).

Status legend: ✅ shipped · ◐ needs config · ⚠️ caveat.

## Contents

- [Sign in and resolve identity](#sign-in-and-resolve-identity)
- [Read the permission-scoped doc tree](#read-the-permission-scoped-doc-tree)
- [Read one document](#read-one-document)
- [Create, edit, and version a document](#create-edit-and-version-a-document)
- [Move, soft-delete, and restore](#move-soft-delete-and-restore)
- [Resolve access (the RBAC core)](#resolve-access-the-rbac-core)
- [Private personal spaces](#private-personal-spaces)
- [The guest tier and 8-hour note expiry](#the-guest-tier-and-8-hour-note-expiry)
- [Search (keyword + semantic)](#search-keyword--semantic)
- [Ask the docs (RAG)](#ask-the-docs-rag)
- [AI authoring assists](#ai-authoring-assists)
- [Canonical Markdown and the editor](#canonical-markdown-and-the-editor)
- [Collaborate: comments and suggestions](#collaborate-comments-and-suggestions)
- [Import, export, and ingest](#import-export-and-ingest)
- [Two-way GitHub sync](#two-way-github-sync)
- [Break-glass recovery and content safety](#break-glass-recovery-and-content-safety)
- [Admin: roles, grants, routing](#admin-roles-grants-routing)

---

## Sign in and resolve identity

**What happens:** a visitor is resolved to an acting user — a signed-in Clerk account, a break-glass
recovery session, or (local dev only) a dev-seed Super Admin; a first-time user lands on the guest
tier and gets a private personal space. ✅

**How the code works:** [`currentPrincipal` · lib/server/data.ts:49](../lib/server/data.ts#L49) calls
[`resolveIdentity` · :61](../lib/server/data.ts#L61), which checks a signed break-glass cookie first,
then Clerk's `currentUser()` (gated by [`canSelfSignUp` · lib/authPolicy.ts:40](../lib/authPolicy.ts#L40)),
then the dev-seed fallback (**null in production**). It upserts the user via
[`upsertUserOnLogin` · lib/authz.ts:18](../lib/authz.ts#L18), which seeds Super Admins idempotently,
assigns the default role via [`resolveRoleOnLogin` · lib/authPolicy.ts:25](../lib/authPolicy.ts#L25),
audits any role change, and provisions the personal space.

## Read the permission-scoped doc tree

**What happens:** the sidebar and dashboard show exactly the docs the current user may read — nothing
they can't, and never another user's personal space. ✅

**How the code works:** [`listReadableDocs` · lib/server/data.ts:171](../lib/server/data.ts#L171)
bootstraps the index if empty, runs the guest sweep, projects `docs` to `{path,title,spaceKey}`, drops
other users' personal spaces via [`isPersonalSpaceVisibleTo` · lib/personalSpace.ts:51](../lib/personalSpace.ts#L51),
then runs [`canAccess` · lib/permissions.ts:105](../lib/permissions.ts#L105) per doc against **cached**
grants + space policy. Cached per request so the layout and page share one scan.

## Read one document

**What happens:** opening a doc renders sanitized GFM with an outline; if you can't read it (or it's
an expired guest note), you get a 404, not a 403. ✅

**How the code works:** [`getReadableDoc` · lib/server/data.ts:225](../lib/server/data.ts#L225) sweeps
expired docs, authorizes `read`, and applies a freshness guard
([`isExpiredGuestDoc` · lib/guest.ts:43](../lib/guest.ts#L43)) — returning `null` (→ 404) for
unreadable or expired docs, so absence and no-access are indistinguishable. The page renders via
`react-markdown` + `remark-gfm` + `rehype-sanitize`.

## Create, edit, and version a document

**What happens:** you write in WYSIWYG or raw Markdown and hit *Save*; it lands as a commit authored
as you, and the full history is browsable. A stale edit is caught, never silently overwritten. ✅

**How the code works:** [`createDocAction` · app/actions/docs.ts:70](../app/actions/docs.ts#L70) /
[`saveDocAction` · :24](../app/actions/docs.ts#L24) authorize `edit`, then call
[`saveDoc` · lib/git/save.ts:29](../lib/git/save.ts#L29): [`canonicalize` · lib/markdown.ts:44](../lib/markdown.ts#L44)
→ `store.write(path, canonical, { baseSha })` (optimistic concurrency — a stale `baseSha` throws
[`ConflictError` · lib/git/types.ts:32](../lib/git/types.ts#L32), surfaced as "reload to merge") →
[`indexPath`](../lib/git/indexer.ts) re-projects the doc and re-embeds its chunks. Every write appends
a snapshot to `versions` (rollback via [`rollbackToVersion` · app/actions/versions.ts:111](../app/actions/versions.ts#L111)).

## Move, soft-delete, and restore

**What happens:** delete moves a doc to trash (recoverable), rename moves it losslessly, and both keep
attached data — comments, suggestions, favorites, and access grants — pointing at the doc. ✅

**How the code works:** [`deleteDocAction` · app/actions/docs.ts:191](../app/actions/docs.ts#L191) →
[`trashDoc` · lib/git/save.ts:82](../lib/git/save.ts#L82) moves the file under `_trash/` and
de-indexes it; [`restoreDoc` · :100](../lib/git/save.ts#L100) inverts it. Rename
([`moveDocAction` · app/actions/docs.ts:137](../app/actions/docs.ts#L137) → [`moveDoc` · lib/git/save.ts:128](../lib/git/save.ts#L128))
requires `edit` on **both** paths and calls [`migrateDocAttachments` · :159](../lib/git/save.ts#L159)
so a moved doc never orphans a `deny` grant and leaks through the space default.

## Resolve access (the RBAC core)

**What happens:** every read/edit/admin is decided by one rule — Super sees all, deny beats allow at
any depth, and unlisted-in-a-curated-space means public-read. *This is the product's trust story.* ✅

**How the code works:** [`canAccess` · lib/permissions.ts:105](../lib/permissions.ts#L105) is pure:
Super short-circuits; it collects grants matching `{role≥rank, groups, self} × {resource ∪ ancestors}`
([`subjectMatches` · :64](../lib/permissions.ts#L64), [`resourceMatches` · :76](../lib/permissions.ts#L76));
any covering **deny** wins ([:120](../lib/permissions.ts#L120)); else a covering **allow**
([:132](../lib/permissions.ts#L132)); else space-default read ([:144](../lib/permissions.ts#L144)).
Org-level actions go through [`canGlobal`/`canSetRole` · :173](../lib/permissions.ts#L173).
[`authorize` · lib/authz.ts:78](../lib/authz.ts#L78) is the single enforcement entry point, feeding
the resolver from the [policy cache](../lib/server/policyCache.ts).

## Private personal spaces

**What happens:** every user gets a `~` space only they (and, by direct access, Super) can reach — and
nobody else even sees it in their tree. ✅

**How the code works:** [`ensurePersonalSpace` · lib/personalSpace.ts:62](../lib/personalSpace.ts#L62)
creates the space `defaultRole: "none"` with one owner-`admin` grant (idempotent; invalidates the
policy cache). The resolver denies non-owners; on top of that
[`isPersonalSpaceVisibleTo` · :51](../lib/personalSpace.ts#L51) filters other users' personal spaces
out of every listing and search — defense-in-depth so not even a Super sees them in the sidebar.

## The guest tier and 8-hour note expiry

**What happens:** a new self-signup is a **guest** — reads the curated public library, edits only
their own notes, and every note they create disappears 8 hours later. ✅ ⚠️ (see caveat)

**How the code works:** [`resolveRoleOnLogin` · lib/authPolicy.ts:34](../lib/authPolicy.ts#L34) defaults
a first-time user to `"guest"` (rank 0). Curated spaces are created `defaultRole: "read"`
([`ensureSpace` · lib/git/indexer.ts:37](../lib/git/indexer.ts#L37)), and space-default read applies
to every principal — so a guest reads them, but can't satisfy a `role:read` grant, so gets no
baseline edit. On create, [`createDocAction` · app/actions/docs.ts:104](../app/actions/docs.ts#L104)
stamps expiry via [`guestExpiryFields` · lib/guest.ts:32](../lib/guest.ts#L32)
(`GUEST_DOC_TTL_MS = 8h`, [:12](../lib/guest.ts#L12)). Expiry is enforced by the lazy sweep
([`sweepExpiredDocs` · lib/reaper.ts:45](../lib/reaper.ts#L45), invoked before every read via
[`reapExpired` · lib/server/data.ts:160](../lib/server/data.ts#L160)), a read-time freshness guard,
the Mongo TTL index ([`lib/db/mongo.ts:41`](../lib/db/mongo.ts#L41)), and the on-demand
[`POST /api/reaper` · app/api/reaper/route.ts](../app/api/reaper/route.ts). A reaped doc's dependents
are purged ([`purgeDocDependencies` · lib/reaper.ts:21](../lib/reaper.ts#L21)).

> ⚠️ Newly landed. The behavior above matches the code; dedicated TTL unit tests aren't written yet,
> and two RBAC fixtures (`ask`/`search`) still assume the pre-guest default and are being updated —
> so the suite isn't green on this revision.

## Search (keyword + semantic)

**What happens:** one search box returns a doc if it matches by words **or** by meaning, ranks
best-of-both highest, and never returns a doc you can't read. ✅

**How the code works:** [`searchReadable` · lib/search.ts:130](../lib/search.ts#L130) builds a keyword
list ([`keywordScore` · :41](../lib/search.ts#L41)) and a semantic list (best chunk cosine per doc),
each **permission-filtered before ranking** by [`readableFilter` · :68](../lib/search.ts#L68), then
fuses them with Reciprocal Rank Fusion ([:180](../lib/search.ts#L180)). A non-positive cosine is
dropped (matters with the local lexical embedder).

## Ask the docs (RAG)

**What happens:** you ask a question and get a synthesized answer with clickable `[n]` citations,
drawn only from docs you may read; with no LLM configured it lists the relevant docs instead of
guessing. ✅ ◐

**How the code works:** [`askAction` · app/actions/ask.ts:10](../app/actions/ask.ts#L10) →
[`askDocs` · lib/rag/ask.ts:30](../lib/rag/ask.ts#L30) retrieves the asker's top-k readable chunks
([`retrieveReadableChunks` · lib/search.ts:86](../lib/search.ts#L86)), builds a numbered context, and
synthesizes via [`complete` · lib/llm.ts:213](../lib/llm.ts#L213) under a strict "answer only from
context" system prompt ([lib/rag/ask.ts:25](../lib/rag/ask.ts#L25)); the offline path returns a
relevant-docs listing.

## AI authoring assists

**What happens:** draft / expand / proofread suggestions arrive as accept-reject proposals — the model
never writes to a doc or bypasses permissions. ✅ ◐

**How the code works:** [`assistAction` · app/actions/ai.ts:22](../app/actions/ai.ts#L22) routes through
the shared [`complete`](../lib/llm.ts#L213) chain and returns text for the user to accept; a save only
happens if the user then triggers `saveDocAction` (which re-authorizes `edit`).

## Canonical Markdown and the editor

**What happens:** WYSIWYG and raw Markdown round-trip losslessly, and saves produce clean, minimal Git
diffs. ✅

**How the code works:** [`canonicalize` · lib/markdown.ts:44](../lib/markdown.ts#L44) (remark/unified,
idempotent) is the single serializer both editing surfaces and the server share. The editor
([`app/components/editor.tsx`](../app/components/editor.tsx), [`wysiwyg.tsx`](../app/components/wysiwyg.tsx))
offers WYSIWYG (TipTap 3) · Source · Preview; optional Yjs collab activates with `COLLAB_WS_URL`.

## Collaborate: comments and suggestions

**What happens:** readers can comment (with @mentions) and propose edits; an editor accepts a proposal
to apply it as a save. Notifications reach only users who can read the doc. ✅

**How the code works:** [`addComment` · app/actions/comments.ts:63](../app/actions/comments.ts#L63)
(READ-gated; mentions gated on the mentioned user's READ access);
[`submitSuggestion`/`acceptSuggestion` · app/actions/suggestions.ts:71](../app/actions/suggestions.ts#L71)
(READ to propose, **EDIT to accept** → applies the proposed content through the save path).

## Import, export, and ingest

**What happens:** bring docs in as `.md`/`.zip`, take them out as `.md`/`.txt`/`.zip` (scope-filtered),
or push external content in over a service token. ✅ ◐

**How the code works:** [`importMarkdownAction` · app/actions/import.ts:77](../app/actions/import.ts#L77)
authorizes `edit` per file. [`GET /api/export`](../app/api/export/route.ts) serves only docs the caller
may read — even inside a space zip. [`POST /api/ingest`](../app/api/ingest/route.ts) authenticates a
service via a constant-time [`x-ingest-token`](../app/api/ingest/route.ts#L49) check, cleans +
categorizes each item, commits it as the ingest bot, and safety-scans it.

## Two-way GitHub sync

**What happens:** an edit made directly in the GitHub repo re-indexes into the app, so the repo and
the app's index never diverge. ◐ (needs `GITHUB_WEBHOOK_SECRET`)

**How the code works:** [`POST /api/webhook/github`](../app/api/webhook/github/route.ts) verifies the
payload with [`verifyGitHubSignature` · lib/git/webhook.ts:9](../lib/git/webhook.ts#L9) (constant-time
HMAC), ignores non-tracked branches ([`isTrackedBranch` · :36](../lib/git/webhook.ts#L36)), and
re-indexes the changed Markdown paths ([`changedMarkdownPaths` · :50](../lib/git/webhook.ts#L50)).

## Break-glass recovery and content safety

**What happens:** an SSO outage doesn't lock out admins (a scrypt-hashed recovery login), and ingest/
save flags real leaked secrets or PII for review without blocking legit config docs. ✅ ◐

**How the code works:** [`/api/breakglass`](../app/api/breakglass/route.ts) verifies a password against
[`verifyPassword` · lib/breakglass.ts:67](../lib/breakglass.ts#L67) and issues an HMAC-signed 2h
session ([`signBreakglassSession` · :25](../lib/breakglass.ts#L25)). [`scanContent` · lib/safety.ts:60](../lib/safety.ts#L60)
matches secret-value/PII/contact patterns, redacts snippets, and skips config-describing lines via the
`ALLOW` filter ([:46](../lib/safety.ts#L46)).

## Admin: roles, grants, routing

**What happens:** admins manage users' roles, permission grants, and the LLM routing mode — within the
bounds of the §6 matrix, and only within spaces they can already see. ✅

**How the code works:** [`getAdminData` · app/actions/admin.ts:47](../app/actions/admin.ts#L47) (gated
by `managePermissions`), [`setUserRoleAction` · :61](../app/actions/admin.ts#L61) (via `canSetRole`),
[`addGrantAction`/`removeGrantAction` · :83](../app/actions/admin.ts#L83) (a non-Super Admin restricted
to visible spaces by [`canManageResource` · :27](../app/actions/admin.ts#L27)), and
[`setRoutingConfig` · app/actions/routing.ts:33](../app/actions/routing.ts#L33). Every grant/space
write invalidates the policy cache so the change is immediate.
