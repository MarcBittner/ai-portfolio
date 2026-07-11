# flotilla — Glossary

**TL;DR** — flotilla is the operator console for provisioning, refreshing,
and tearing down preview and staging application instances across Vercel + Convex +
Clerk (see `README.md`). This glossary serves two purposes. First, it documents the
**"trueline" design language** — the repository's own UI/UX conventions, which
otherwise live only in code comments (top-nav shape, the glass-table kit, the row
context-menu, the "connecting…" degraded read posture, the pre-paint theme
bootstrap). Second, it defines the **domain and platform vocabulary** — instances,
provision/refresh/teardown, snapshots, PII masking, RBAC, the danger-ack safety
gate, feature flags, observability versus monitoring, and the saga/idempotency
machinery — each grounded in code with a `path:Lnnn` citation. Every entry is cited;
any detail that could not be fully verified is marked ⚠️.

## Table of contents

- [Trueline design-language conventions](#trueline-design-language-conventions)
  - [Horizontal top-nav, never a sidebar](#horizontal-top-nav-never-a-sidebar)
  - [The glass surface](#the-glass-surface)
  - [Glass-table primitives](#glass-table-primitives)
  - [Glass hovercards (portaled)](#glass-hovercards-portaled)
  - [Row context-menu pattern](#row-context-menu-pattern)
  - [Confirm-every-mutation guard](#confirm-every-mutation-guard)
  - [Status pills & signal badges](#status-pills--signal-badges)
  - [The "connecting…" degraded read posture](#the-connecting-degraded-read-posture)
  - [Pre-paint theme bootstrap](#pre-paint-theme-bootstrap)
  - [Operator-tunable appearance](#operator-tunable-appearance)
  - [Canvas charts inherit the theme](#canvas-charts-inherit-the-theme)
- [Domain & platform terms](#domain--platform-terms)

---

## Trueline design-language conventions

"Trueline" is the codebase's name for its house UI style — a dense, operator-first,
glass-panel dashboard aesthetic with a single horizontal nav, no chrome that wraps,
tables as the primary surface, and a read posture that **degrades but never crashes**.
The conventions are enforced by a small shared kit (`app/components/kit.tsx`,
`app/components/nav.tsx`) rather than a spec document, so copying an existing tab is
the way to stay consistent. Each entry below names the convention, defines it,
explains the intent, and cites the code that carries it.

### Horizontal top-nav, never a sidebar

**What** — A single non-wrapping row of tabs across the top of every page; there is
no sidebar. Tab order deliberately mirrors the operator flow: see instances →
manage their data/code/auth/users → test → audit → logs.
`app/components/nav.tsx:10`, tabs list `app/components/nav.tsx:13`.

**Intent** — The nav **must never wrap to a second line**; on narrow viewports it
scrolls horizontally instead. `app/components/nav.tsx:41` (comment) and the
`overflow-x-auto` scroll row `app/components/nav.tsx:43`. The active tab is matched
by prefix (with `/app` exact-matched) and marked via `data-active` + `aria-current`
`app/components/nav.tsx:45`.

### The glass surface

**What** — The signature panel: a translucent, backdrop-blurred `.glass` surface
used for tables, popovers, menus, and modals. Its look is driven by CSS variables
`--glass-alpha` (transparency) and `--glass-blur`, both operator-tunable.
Definition referenced throughout the kit, e.g. the table wrapper
`app/components/kit.tsx:35`; slider bounds and intent `app/components/nav.tsx:98`
(transparency) and `app/components/nav.tsx:103` (blur).

**Intent** — One coherent material for every raised surface, recolored by the theme
accent so the whole app reads as one piece. Note the load-bearing quirk documented
in code: `.glass { position: relative }` in globals.css means any portaled popover
**must** set `position: fixed` inline to escape it — `app/components/kit.tsx:344`.

### Glass-table primitives

**What** — Tables are the primary data surface, built from shared primitives:
`Table` (glass wrapper + horizontal scroll), `Th`, `Td`, and the sortable
`SortTh` + `useSort` engine, plus `EmptyRow` for the full-width empty/loading state.
"table primitives (trueline convention)" `app/components/kit.tsx:32`; `Table`
`app/components/kit.tsx:33`; `useSort` `app/components/kit.tsx:91`; `SortTh`
`app/components/kit.tsx:141`; `EmptyRow` `app/components/kit.tsx:202`.

**Intent** — Every dashboard table sorts, styles, and empties the same way. `useSort`
runs one stable decorate-sort-undecorate over the whole dataset the page holds, so
it composes with upstream filtering and re-sorts automatically when SWR refreshes
`app/components/kit.tsx:114`. Clicking a `SortTh` cycles asc → desc with a ▲/▼
indicator and a faint ⇅ hint on hover `app/components/kit.tsx:174`. There are **no
other editable/bespoke tables** — extend these.

### Glass hovercards (portaled)

**What** — `HoverCard` renders a dotted-underline trigger; on hover a glass popover
of detail (`KV` rows) is portaled to `<body>` and positioned with `position: fixed`,
clamped to stay on-screen. `HoverCard` `app/components/kit.tsx:216`; `KV`
`app/components/kit.tsx:272`.

**Intent** — Progressive disclosure of dense detail without leaving the row.
Portaling to `<body>` is deliberate: the table's `overflow-x-auto` also clips
overflow-y, so an in-flow card would be cut off in a short table
`app/components/kit.tsx:253` (comment). The card uses a near-solid background so it
stays readable even when the transparency slider is set low
`app/components/kit.tsx:257`.

### Row context-menu pattern

**What** — Per-row actions via a `⋯` button **and** native right-click anywhere on
the `<tr>`, both opening the same menu at the pointer (`RowMenu`). Explicitly named
"the trueline row context-menu pattern (plan B-10)" `app/components/kit.tsx:293`;
component `app/components/kit.tsx:289`.

**Intent** — Desktop-operator ergonomics: right-click feels native, the `⋯` affordance
keeps it discoverable, and destructive items are styled with the `bad` tone
`app/components/kit.tsx:359`. Escape / outside-click close it
`app/components/kit.tsx:307`.

### Confirm-every-mutation guard

**What** — A promise-based confirm modal (`useConfirm` → `confirm()` / `dialog`) that
**every mutating action in every tab routes through** before anything touches real
Vercel/Convex/Clerk infra. `app/components/kit.tsx:609` (comment) and
`app/components/kit.tsx:626` (hook). The sibling `Modal` shell
`app/components/kit.tsx:556` shares the same portal-to-body + overlay + glass styling.

**Intent** — No privileged action fires without an explicit operator OK. The dialog
renders `details` KV rows showing the exact target (deployment, branch, backup) and
styles prod/destructive confirms red via `danger` `app/components/kit.tsx:614`
(comment). Enter confirms, Escape cancels `app/components/kit.tsx:645`. This is the
UI half of the [danger-ack](#danger-ack-dangerack) server gate.

### Status pills & signal badges

**What** — A fixed status→tone palette. `Pill` maps a status string
(`ready`/`provisioning`/`failed`/…) to an `ok`/`warn`/`bad`/`accent`/`muted` tone,
pulsing on in-progress states. `Badge` is the generic inline signal in the same
palette, specialized as `MaskedBadge`, `DriftBadge`, and `TTLCountdown`. Tone maps
`app/components/kit.tsx:375`; `Pill` `app/components/kit.tsx:400`; `Badge`
`app/components/kit.tsx:444`; `MaskedBadge` `app/components/kit.tsx:468`; `DriftBadge`
`app/components/kit.tsx:483`; `TTLCountdown` `app/components/kit.tsx:494`.

**Intent** — One shared color language across instance/job/health status so a color
means the same thing everywhere. `provisioning`/`running` animate-pulse to read as
live `app/components/kit.tsx:407`.

### The "connecting…" degraded read posture

**What** — The defining trueline data posture: when a backing store or platform
engine is unreachable, reads return a **200 with an empty payload + a `reason`**
(not an error), and the UI renders an honest "connecting…" empty state instead of
crashing. Server helper `degraded()` `lib/api.ts:19`; the wrapping `safeRead()`
`lib/api.ts:62`; the intent comment "the trueline posture where a page renders
'connecting…' instead of a page crash" `lib/api.ts:8`. Client side: the
`Degradable` type `app/components/kit.tsx:26` and the `DegradedNote` banner
("connecting… data store or platform engine not reachable") `app/components/kit.tsx:187`.

**Intent** — The dashboard is a worktree tool that must build, typecheck, and render
even when Mongo/Clerk/Convex creds are absent. The same posture backs the
provisioning **contract stubs**: when Workstream A's real engine is absent, safe
stubs let the dashboard render "degraded but never crashing (the trueline
'connecting…' posture)" `lib/_contract.ts:5`. Server errors are logged but never
leaked (DB URIs / internal paths) to the client `lib/api.ts:52`.

### Pre-paint theme bootstrap

**What** — An inline `<head>` script runs **before first paint** to read persisted
appearance prefs from `localStorage` and apply them to `<html>`, so there is no
flash of the wrong theme on load or tab switch. `app/layout.tsx:11` (comment,
"trueline convention") and the `THEME_BOOTSTRAP` script `app/layout.tsx:24`.

**Intent** — Zero appearance flash. It applies theme (dark/light/system honoring
`prefers-color-scheme`), accent, background image on/off, glass alpha/blur, and
freeform ink/surface/bg color overrides — all before React hydrates
`app/layout.tsx:24`–`app/layout.tsx:39`. The settings menu lazily reflects this
already-applied DOM state to avoid a hydration mismatch `app/components/nav.tsx:138`.

### Operator-tunable appearance

**What** — A `theme` menu in the nav lets the operator pick dark/light, image vs.
solid background, one of 10 accent hues, panel transparency, panel blur, and
freeform text/glass/background colors — persisted to `localStorage` and applied live.
`SettingsMenu` `app/components/nav.tsx:137`; accent palette `app/components/nav.tsx:85`;
transparency/blur/color controls `app/components/nav.tsx:383`–`app/components/nav.tsx:427`;
Reset-to-defaults `app/components/nav.tsx:253`.

**Intent** — Long-session operator comfort without a settings backend: prefs live
client-side and drive CSS variables that recolor buttons, nav, links, pills, and
glass coherently in both themes `app/components/nav.tsx:80` (comment).

### Canvas charts inherit the theme

**What** — The observability overlay chart is a thin uPlot (canvas) wrapper that
reads the CSS-variable accents (`--color-accent`, `--color-line`, `--color-ink`,
`--color-muted`, + the palette) at mount and on every redraw, so it inherits the
trueline theme + accent switching. `app/app/observability/chart.tsx:14` (comment).

**Intent** — Even the imperative canvas layer stays on-palette. uPlot is chosen for
dense time-series where SVG libraries struggle, and it is loaded only via
`next/dynamic({ssr:false})` so it never enters the main bundle
`app/app/observability/chart.tsx:7`.

---

## Domain & platform terms

Alphabetical. Each term is defined and cited to the code that owns it.

### Backup / snapshot

A captured Convex deployment data export used to seed a fresh instance or refresh
an existing one. The `Backup` shape (`id`, `deployment`, `ref`, `createdAt`,
`sizeBytes`, `source`) is `lib/_contract.ts:113`. Blob payloads live in a
**GitHub-Releases snapshot store, never in Mongo**; `grabSnapshotToStore` grabs any
not-yet-stored snapshot and is idempotent (already-stored snapshots are skipped)
`lib/backupSync.ts:2`, function `lib/backupSync.ts:24`. In practice "snapshot" is the
capture and "backup" the catalog record referencing it.

### Break-glass login

A local, Clerk-independent operator sign-in for when the Clerk gate is unavailable:
a single identity (`BREAKGLASS_EMAIL`) authenticates against a **scrypt hash stored
only in env** (`BREAKGLASS_PASSWORD_HASH`, never plaintext), minting a signed
httpOnly session cookie. `lib/breakglass.ts:8` (intent), `hashPassword`
`lib/breakglass.ts:19`, `verifyPassword` (constant-time, fail-closed)
`lib/breakglass.ts:27`. Route guards accept **either** this cookie or a Clerk
session `lib/auth.ts:6`, and a break-glass session resolves to **super-admin**
`lib/auth.ts:66`.

### Danger-ack (`dangerAck`)

The primary overwrite safety gate: an explicit `dangerAck: true` is required on
**every** write to a pre-existing deployment (one the tool did not create), enforced
in the executor preflight. "SINGLE SOURCE OF TRUTH … the primary overwrite guard is
the explicit `dangerAck`" `lib/deployments.ts:6`; the flag `lib/executor.ts:57`; the
preflight throws when it is absent for a shared Vercel project `lib/executor.ts:160`
and for any pre-existing Convex deployment `lib/executor.ts:172`. It is the server
counterpart of the [confirm-every-mutation](#confirm-every-mutation-guard) UI. Note:
**production is a HARD block no ack can override** — see below.

### Escalation policy / tier

An ordered list of notification tiers an unacknowledged, still-hard-CRIT incident
advances through as `afterMinutes` elapse; with no policy the system does bounded
re-notifies over the monitor's own channels. The escalation sweep
`lib/monitoring/escalate.ts:1`; the `EscalationTier` type + `getPolicy` import
`lib/monitoring/escalate.ts:25`; policies model `lib/models/monitoring/policies.ts`.
Idempotent: each incident carries a **per-tier last-notified cursor** so a double
cron tick cannot double-page `lib/monitoring/escalate.ts:6`. Stored collections:
`monitorPolicies` (ordered tiers) and `monitorIncidents` (open CRITs + escalation
cursor + ack) `lib/mongo.ts:116`.

### Feature flag

A behavior toggle in the `FeatureFlags` schema, resolved with the same
stored ?? env ?? default provenance as editable config. Core principle: **every flag
defaults to today's behavior** — reliability safety nets are pure-additive and
default ON; genuinely new subsystems default OFF. Flipping a flag off never re-opens
a security guard. Schema + rationale `lib/models/config.ts:104`, object
`lib/models/config.ts:114`; env fallbacks (`FLOTILLA_FEATURE_*`) `FEATURE_ENV_KEYS`
`lib/models/config.ts:187`. New subsystems gated here include `observability`,
`monitoring`, `askAi`, `costEstimates`, `aiFailureTriage`, `driftBadges`, and
`scopedShareLinks` `lib/models/config.ts:114`–`lib/models/config.ts:156`.

### Idempotency marker (`idempotencyKey`)

The key that makes provisioning converge instead of duplicating on a double-submit
or retried job. On an instance, `idempotencyKey` makes "New preview" converge
`lib/models/instances.ts:5`. The job queue is idempotent throughout: `enqueue`
converges on `idempotencyKey`, `claimJob` ensures a single runner, and a finished
job re-run no-ops `lib/jobs.ts:39`. The provisioning executor is likewise
idempotent — a fresh Convex deployment is re-claimed by the same previewName
`lib/executor.ts:19`.

### Immutable super-admin

A hardcoded set of super-admin emails whose role resolution **always** overrides any
stored value to `super-admin`, and who can never be demoted or removed — not even by
another super-admin. `IMMUTABLE_SUPERADMINS` `lib/rbac.ts:39`, the intent comment
`lib/rbac.ts:35`, guard helper `isImmutableSuperadmin` `lib/rbac.ts:51`.

### Instance

A managed **preview** or **staging** deployment: a (branch × backup) deployed across
Vercel + Convex + Clerk. Model header `lib/models/instances.ts:4`; `InstanceKind`
enum (`preview` | `staging`) `lib/models/instances.ts:17`; `InstanceStatus`
(`pending`/`provisioning`/`ready`/`failed`/`archived`) and `InstanceHealth`
`lib/models/instances.ts:18`. Two provisioning shapes exist — **FRESH** (tool
provisions a brand-new isolated Convex + Vercel deployment, `createdByTool = true`)
and **EXISTING** (operator targets a pre-existing deployment to refresh,
`createdByTool = false`, danger-flagged) `lib/models/instances.ts:8`.

### Observability vs. monitoring

Two distinct feature-flagged subsystems, easy to conflate:

- **Observability** — a *metrics pipeline*. The worker periodically pulls
  Vercel/Clerk/Atlas and derives internal RED signals, stores them in Mongo, and the
  Observability tab renders a multi-series overlay. Mini-collector modeled on an OTel
  Collector DAG (receivers → processors → exporter) `lib/observability/collect.ts:1`;
  flag description `lib/models/config.ts:141`.
- **Monitoring** — *Nagios-style alerting*. A cron scheduler evaluates closed-registry
  checks (metric thresholds, HTTP reachability, instance status), runs a soft→hard
  state machine, and dispatches rolled-up digests (Slack + Gmail). Flag description
  `lib/models/config.ts:151`; state machine `lib/monitoring/stateMachine.ts:1`.

In short: observability charts *what the numbers are*; monitoring *pages when a
number crosses a line*.

### PII masking / `scrubPII`

Two related, deterministic, idempotent transforms that run **before `convex import`**
so real identity PII never lands on a target instance at all:

- **`lib/scrub.ts`** — an earlier JSON round-trip scrub. Deterministic: each distinct
  person maps to the same scrubbed value across tables and re-runs; intentionally KEEPS
  stable id references and all numeric amounts `lib/scrub.ts:1`.
- **`lib/mask.ts`** — the newer, string-level masker that preserves Convex float encoding
  (`1234.0`) — the round-trip in scrub.ts silently drops it and would corrupt numeric
  rollups `lib/mask.ts:1`. Referentially consistent via `@snaplet/copycat`
  with an HMAC fallback `lib/mask.ts:15`.

`scrubPII` is the caller's "mask PII" flag on `ProvisionOpts` `lib/_contract.ts:34`,
but masking is **forced on** — regardless of the flag — when the snapshot source is
real prod / staging-prod PII (safe-by-default clone) `lib/executor.ts:75`,
`lib/executor.ts:245`. A deployment role of `PRODUCTION` / `staging-prod` likewise
forces masking `lib/deployments.ts:19`. Surfaced in the UI by
[`MaskedBadge`](#status-pills--signal-badges) (`masked`/`raw`/`unknown`).

### Provision / refresh / teardown

The three instance-lifecycle verbs.

- **Provision** — one-shot orchestration that stands up an instance across the
  platforms. Contract `provision()` `lib/_contract.ts:58`; real executor path
  `lib/executor.ts`. Steps: vercel deploy → convex point/import/authreset →
  optional migrations → email-guard → clerk align → smoke test `lib/_contract.ts:65`.
- **Refresh** — modeled on Argo-CD's "Refresh" verb: recompute drift, side-effect-free
  `lib/drift.ts:1`, `lib/drift.ts:157`. The separate scheduled **auto-refresh**
  re-imports a (usually newer) snapshot into a stable instance `lib/jobs.ts:315`.
- **Teardown** — decommission an instance; stamps `updatedAt` so cost estimation stops
  climbing `lib/cost.ts:46`; executor path `lib/executor.ts:323`.

### PROD_CONVEX_DEPLOYMENT / shared deployment

The managed-deployment topology (`lib/deployments.ts` is the single source of truth).
`PROD_CONVEX_DEPLOYMENT` names the **production** deployment — a HARD, non-ackable
write/teardown target: no [danger-ack](#danger-ack-dangerack) can override the block
`lib/deployments.ts:47`, export `lib/deployments.ts:48`. **Shared deployments** are
pre-existing managed deployments (name→role map, e.g. `staging-prod`, `ci`, `dev`)
that are danger-gated and, for prod-roled ones, force PII masking
`lib/deployments.ts:14`, defaults `lib/deployments.ts:18`. Overridable via
`FLOTILLA_PROD_CONVEX_DEPLOYMENT` and `FLOTILLA_SHARED_DEPLOYMENTS` env
`lib/deployments.ts:12`.

### RBAC roles (the four roles)

Four ascending roles: `read-only` → `write` → `admin` → `super-admin`
`lib/rbac.ts:8`, enum `lib/rbac.ts:9`, rank map `lib/rbac.ts:16`. Enforcement is
server-side via `withOperator(fn, minRole)`: no principal → 401, role below `minRole`
→ 403 (audited) `lib/api.ts:29`. Read handlers default to `read-only`; mutating
handlers pass `write` (or `admin`/`super-admin` for role management)
`lib/api.ts:23`. The grant boundary — "super-admins manage admins; admins manage
non-admin users; only a super-admin may promote/demote super-admin" — is
`lib/rbac.ts:57`. Every `Principal` carries a resolved `role` `lib/auth.ts:16`.

### RED metrics

The Rate/Errors/Duration signal family the observability pipeline derives internally
— "the highest-signal, cheapest, always-available metrics," computed straight from
the dashboard's own Mongo (`flotilla_*`) with existing helpers, no external API/token/
rate limit; the "worker falling behind" early-warning the tab exists for. Internal
RED poller `lib/observability/pollers/internal.ts:1`, `source:"derived"`
`lib/observability/pollers/internal.ts:8`. Also surfaced per-job-type on the Queue
tab `app/api/queue/route.ts:38`. ⚠️ The literal expansion "Rate/Errors/Duration" is
inferred from standard usage; the code refers to it only as "RED".

### Rollup

An aggregate roll of child state into a parent summary. Primarily a **monitoring**
concept: contact **groups** expose a member-state `rollup`, and the Monitoring tab's
"tactical rollup" folds monitor states into a fleet health header. Group rollup API
`app/api/monitoring/groups/route.ts:12`; overview/tactical rollup
`app/api/monitoring/overview/route.ts:8`; `GroupRollup` type
`app/app/monitoring/page.tsx:183`. (Here rollup means health aggregation — a fleet-wide
OK/WARN/CRIT summary, not a numeric sum.)

### Saga / compensating step

The provisioning orchestration model: a **linear saga of named steps**, each of which
may register a **compensating action**. On an uncorrectable failure the runner unwinds
executed steps in reverse, running each compensator, so nothing is left behind.
Model comment `lib/provision.ts:6`; `SagaStep` type `lib/provision.ts:63`; `runSaga`
`lib/provision.ts:71`; the executed-stack + reverse compensation `lib/provision.ts:73`.
The contract stub simulates the same unwind for the failure demo/tests
`lib/_contract.ts:82`. `runSaga` is shared with `scripts/refresh-staging.ts`
`lib/provision.ts:62`.

### Preview vs. staging

The two `InstanceKind` values `lib/models/instances.ts:17`. **Preview** is the
default `lib/models/instances.ts:31` — typically a fresh, isolated, tool-owned
deployment per branch. **Staging** instances default to a unique `staging-<rand>`
name (via `randomAlnum`) so they do not collide `lib/models/instances.ts:21`,
`lib/models/instances.ts:126`. Jobs carry the same `kind` enum `lib/models/jobs.ts:43`.

---

*Every `path:Lnnn` citation above corresponds to the working tree; line numbers
shift as code changes, so re-verify before relying on them. The single inferred
detail — the RED acronym expansion — is marked ⚠️.*

---

**Related:** [Docs index](./README.md) · [Architecture](./ARCHITECTURE.md) · [Capability map](./CAPABILITY-MAP.md) · [Getting started](./onboarding/getting-started.md)
