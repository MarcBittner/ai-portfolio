# flotilla — decision records

This is the architecture-decision log for the control plane. Each entry records a
load-bearing choice: why the request path only enqueues, why snapshot blobs live in
GitHub Releases and metrics on a second cluster, why every new subsystem ships flag-off
while safety guards never do, why the production write/teardown block, the AI provider
chain, break-glass, and the super-admin list are shaped as they are, and how the public
demo is made safe by construction. Every claim is grounded in a `path:Lnnn` citation. All
nine decisions below are in effect; the caveats live in their **Consequences (bad)** lines
and in ARCHITECTURE's "Drift & gotchas".

**Status legend:** ✅ shipped · ◐ partial · 🔭 flag-gated / planned · ⚠️ caveat

## Index of ADRs

| # | Decision | Status | Anchor |
|---|---|---|---|
| 1 | Worker off the request path — routes enqueue, a standalone worker runs the saga | ✅ | `lib/jobs.ts:36` |
| 2 | Snapshot blobs in GitHub Release assets, not Mongo | ✅ | `lib/clients/snapshotStore.ts:1` |
| 3 | Feature flags default-off (safety nets on, new features off) | ✅ | `lib/models/config.ts:168` |
| 4 | Env-driven deployment topology with layered guards | ✅ | `lib/deployments.ts:1` |
| 5 | SDK-free direct-fetch AI chain with a deterministic terminal tier | ✅ | `lib/aiRouter.ts:39` |
| 6 | MongoDB (not Axiom) as the metrics store | ✅ | `lib/observability/store.ts:1` |
| 7 | Scrypt break-glass fallback login | ✅ | `lib/breakglass.ts:94` |
| 8 | Immutable super-admins defined in source | ✅ | `lib/rbac.ts:39` |
| 9 | Public-safe by construction — a read-only guest tier below the RBAC floor | ✅ | `lib/api.ts:29` |

---

## ADR-1 — Worker off the request path

**Context.** A provision streams tens of MB of snapshot data and, for PII scrub, needs a
real filesystem (`unzip`/`mask`/`re-zip`) plus, on some paths, Playwright — none of which
fits inside a serverless route handler with its execution-time and ephemeral-fs limits
(`lib/jobs.ts:36`).

**Decision.** Route handlers only **enqueue**: they parse the Zod body, fill omitted
fields from config, write a `queued` job to `flotilla_jobs`, and return
`{jobId, instanceId}` immediately (`lib/jobs.ts:92`). A standalone Node process
(`scripts/worker.ts`) polls the queue and runs the all-HTTP saga engine
(`executeProvision`, `lib/executor.ts:1`). `lib/` is shared by both sides; the split is
runtime, not code. `FLOTILLA_INLINE_WORKER=1` opts a single process into running jobs inline
for local dev (`lib/jobs.ts:541`).

**Consequences (good).** Long work never blocks or times out an HTTP request; the UI tails
a live log while the job runs; the claim is atomic single-winner, so N worker copies are
safe; a double-submit converges on `idempotencyKey` (`lib/jobs.ts:97`).

**Consequences (bad).** An extra always-on process to operate, mitigated by the
inline-worker escape hatch (`lib/jobs.ts:541`). Where the worker runs in production
(host/supervisor) is not declared in the repo (⚠️ ARCHITECTURE "Open questions").

**Status.** ✅ In effect.

---

## ADR-2 — Snapshot blobs in GitHub Release assets, not Mongo

**Context.** Convex snapshot ZIPs are 60–180 MB each. Stored in the old GridFS bucket,
they filled the shared 512 MB cluster and caused an outage
(`lib/clients/snapshotStore.ts:4`).

**Decision.** Persist each snapshot as an asset under one lazily-created release (tag
`blobs`) in a private repo named by `SNAPSHOT_REPO` (`lib/clients/snapshotStore.ts:9`). The
`flotilla_backups` doc carries only a `blobRef` (the numeric asset id); the store is
"configured" only when both `GITHUB_TOKEN` and a valid `owner/name` repo are present, else
callers degrade (`lib/clients/snapshotStore.ts:36`). A provision resolves its source by
store kind — GitHub Releases for new rows, else a live stream from the Convex cloud backup
(`lib/executor.ts:107`).

**Consequences (good).** Free, out-of-Mongo blob storage (2 GB/asset) reachable over HTTP
from both the deployed app and the worker; the database holds only metadata; the same
reasoning moved high-volume metrics to a **separate** cluster (see ADR-6).

**Consequences (bad).** ⚠️ A **legacy GridFS** read path survives: old rows with
`storeKind:"gridfs"`/`gridfsId` still resolve via GridFS, so the retrieval branch must stay
dual until those rows age out (`lib/executor.ts:113`). Depends on a GitHub token with
`repo` scope and on Releases as durable storage.

**Status.** ✅ In effect.

---

## ADR-3 — Feature flags default-off

**Context.** Non-core subsystems (observability, monitoring, Ask-AI, AI triage, validated
fix-loop, cost estimates, scoped share links, drift badges, notifications, auto-ingest)
must ship without changing behavior for anyone until deliberately turned on
(`lib/models/config.ts:114`).

**Decision.** Flags live in the config singleton, each resolved
`stored ?? env (FLOTILLA_FEATURE_*) ?? hardcoded` with a provenance marker
(`lib/models/config.ts:187`). Reliability **safety nets** ship **on** — `deadLetterQueue`,
`stalledReclaim`, and `queuePanel` are pure-additive (`lib/models/config.ts:169`);
everything genuinely new ships **off** (`lib/models/config.ts:172`). Flags gate **behavior
and routes only** — flipping one off "never re-opens a guard; it only reverts to the prior
best-effort behaviour" (`lib/models/config.ts:113`).

**Consequences (good).** New subsystems can land dark and be enabled per operator; the
shipped default is always today's behavior; unknown flag names are rejected by the
`.strict()` patch (`lib/models/config.ts:160`).

**Consequences (bad).** Two-key gating adds a subtlety: a feature can read "on" yet still
no-op until its companion is set — for example, `notifications` also needs
`notifyWebhookUrl` before anything sends (`lib/models/config.ts:130`). Security
remediations must **never** be modeled as a flag; the prod/shared guards stay in their own
modules, read-only in Config (`lib/models/config.ts:17`).

**Status.** ✅ In effect.

---

## ADR-4 — Env-driven deployment topology with layered guards

**Context.** The tool holds credentials for real Convex deployments; a misfired write or
teardown against production or a shared env is catastrophic. Guards must be **fail-safe
when unconfigured**, and client components — which cannot read server-only env — still need
to render picker lists (`lib/deployments.ts:1`).

**Decision.** `lib/deployments.ts` is the single source of truth: the prod name and
shared-role map are env-overridable but ship with baked defaults (`PROD_CONVEX_DEPLOYMENT`,
`lib/deployments.ts:48`; `SHARED_DEPLOYMENTS`, `lib/deployments.ts:52`). Defenses layer:

1. **Production hard block** — the prod deployment can never be a write target, and **no
   `dangerAck` overrides it** (`lib/executor.ts:164`); the same holds for teardown
   (`lib/executor.ts:370`).
2. **`dangerAck` on any pre-existing deployment** — the primary overwrite guard,
   independent of the topology table (`lib/executor.ts:172`).
3. **Forced PII masking of prod data** — a snapshot sourced from a production/staging-prod
   deployment forces masking on regardless of the caller's `scrubPII` flag
   (`lib/executor.ts:248`).
4. **Vercel project guards** — never deploy to the production/main-app project; shared
   projects require `dangerAck` (`lib/executor.ts:157`).
5. **Email kill-switch preflight** — refuses any target where `ALLOW_OUTBOUND_EMAIL=true`
   (`lib/executor.ts:198`).
6. **Teardown scope** — only `createdByTool` instances, never prod/shared
   (`lib/executor.ts:366`).

**Consequences (good).** Guards work with zero config; the same table drives both
enforcement and the UI picker; the prod block is absolute (ack-proof).

**Consequences (bad).** The baked prod name is a real deployment id, so
`FLOTILLA_PROD_CONVEX_DEPLOYMENT` **must** be set in every real environment to arm the block
for that fleet (`lib/deployments.ts:10`). `dangerAck` is the operator's own
footgun-with-a-safety — it exists precisely so overwrites remain possible.

**Status.** ✅ In effect.

---

## ADR-5 — SDK-free direct-fetch AI chain with a deterministic terminal tier

**Context.** Every AI surface makes one call shape (a forced-tool request). An
Anthropic/OpenAI SDK would add a dependency and bundle weight for no benefit, and Ask-AI
must never hard-fail even with no key or no network (`lib/aiRouter.ts:5`).

**Decision.** All AI is **SDK-free direct `fetch`**. Ask-AI is an ordered fallback
**chain** `anthropic → openai → ollama → free → deterministic`, walked from the top on
`auto` or from an explicit start point (`lib/aiRouter.ts:39`); the first configured
provider that succeeds answers, each failover is recorded (`fellBackFrom`), and the
terminal `deterministic` tier is a **non-AI keyword map** that always returns
(`lib/aiRouter.ts:447`, `lib/aiRouter.ts:521`). Keys are read from env inside each
provider, sent only as the documented auth header, and never logged or returned
(`lib/aiRouter.ts:17`).

**Consequences (good).** No heavy SDK deps; a useful answer with zero configuration; every
degradation is observable rather than a silent failure; liveness probing is split by
reachability (cloud server-side, Ollama client-side).

**Consequences (bad).** ⚠️ Hand-rolled provider calls mean each provider's request shape is
maintained by hand rather than by a vendored SDK. The whole surface is 🔭 flag-gated
(`askAi`, `aiFailureTriage`, `aiValidatedFixLoop`) and read-only by posture — "the model
proposes; nothing here disposes."

**Status.** ✅ In effect.

---

## ADR-6 — MongoDB (not Axiom) as the metrics store

**Context.** The Observability tab needs a time-series store. Axiom was the original
target, but its dataset-creation API 500s server-side, and the app already runs on MongoDB
with a live `MONGODB_URI` (`lib/observability/store.ts:2`).

**Decision.** Persist and query metrics in MongoDB: one document per MetricPoint, keyed for
idempotency on `bucketKey` `(provider,metric,labelsKey,minute)` so re-polling a 60 s window
converges to one sample; labels are hoisted to columns to mirror the old Axiom event shape,
so nothing downstream changed vocabulary (`lib/observability/store.ts:1`). Because metrics
are high-volume, they live on a **separate** cluster (`FLOTILLA_METRICS_MONGODB_URI`), falling
back to the main URI for single-cluster dev (`lib/mongo.ts:32`). Retention is a TTL index on
an `expireAt` Date mirror, default 30 days.

**Consequences (good).** Reuses existing infra with no new vendor; degrades cleanly to an
honest empty state when the store is absent; the separate cluster keeps metric write volume
off the primary cluster, which filled its 512 MB cap once.

**Consequences (bad).** ⚠️ **Axiom is dormant**: `lib/clients/axiom.ts` and every `AXIOM_*`
env var are unwired unless the client is revived (`lib/clients/axiom.ts:3`). ⚠️ The TTL
index caps history depth — points past `FLOTILLA_METRICS_TTL_DAYS` are reaped
(`lib/observability/store.ts:14`).

**Status.** ✅ In effect.

---

## ADR-7 — Scrypt break-glass fallback login

**Context.** The dashboard must remain operable when the Clerk auth gate is unavailable,
without shipping a plaintext password or a second full identity provider
(`lib/breakglass.ts:8`).

**Decision.** A single `BREAKGLASS_EMAIL` identity signs in against a scrypt hash in env
(`BREAKGLASS_PASSWORD_HASH`, stored `salt:hashHex`, never plaintext) with constant-time,
fail-closed verification (`lib/breakglass.ts:27`, `lib/breakglass.ts:94`). Success mints a
signed, httpOnly session cookie whose HMAC key is derived from the password hash itself, so
it never appears in client-visible config (`lib/breakglass.ts:48`). Route auth checks the
break-glass cookie **first**, then Clerk, and a break-glass principal resolves to
super-admin (`lib/auth.ts:65`). The login is rate-limited by a Mongo sliding window
(8 failures / 15 min per IP, `lib/ratelimit.ts:10`).

**Consequences (good).** An offline/no-Clerk operator path with no extra vendor; the hash
lives only in env; the HMAC key is bootstrapped from a secret already present; constant-time
compares resist timing attacks.

**Consequences (bad).** ⚠️ The rate limiter **fails open** on a store error: it favors
availability over lockout, acceptable because scrypt still slows guessing
(`lib/ratelimit.ts:41`). Any principal holding this cookie is super-admin, so the env secret
is maximally sensitive. Without a configured hash (pure dev), sessions use a per-process
random key and do not survive a restart (`lib/breakglass.ts:50`).

**Status.** ✅ In effect.

---

## ADR-8 — Immutable super-admins defined in source

**Context.** RBAC is the security floor for a tool that holds production credentials. There
must be a set of principals that can never be locked out or demoted — even by another
super-admin — and the rule must be shareable between client and server without any
server-only imports (`lib/rbac.ts:1`).

**Decision.** A hardcoded `IMMUTABLE_SUPERADMINS` list lives in source (`lib/rbac.ts:39`).
Role resolution always overrides any stored role for these to super-admin, and every
mutation targeting them (set-role / disable / remove) is rejected in code, so they can never
be demoted or removed (`lib/rbac.ts:51`). Around them, four ascending roles
`read-only → write → admin → super-admin` are kept as rank-ordered data (`lib/rbac.ts:13`),
and a grant boundary (`canManageRole` / `canTransitionRole`) governs who may change whom:
super-admins manage admins, admins manage only non-admin users (`lib/rbac.ts:63`). The module
has no Mongo/Clerk/`next/headers` imports, so the Access page enforces the same predicate the
server does.

**Consequences (good).** A permanent way back in — the founding operators can never be
locked out; one source of truth for roles across client and server;
lockout-by-misconfiguration is impossible for the listed identities.

**Consequences (bad).** The list is source-controlled, so changing it is a code change and
deploy, not a runtime operation — deliberate, since a runtime knob over it would be exactly
the remediation-relaxing lever ADR-3 forbids.

**Status.** ✅ In effect.

---

## ADR-9 — Public-safe by construction (a read-only guest tier)

**Context.** flotilla is worth showing publicly as a portfolio piece, but it is an ops tool
that drives real infrastructure. A public demo therefore has a hard requirement: a stranger
must be able to explore the *entire* console and be **structurally incapable of touching
anything.** Hiding buttons in the UI is not a security boundary — the guarantee has to be
server-side (`lib/api.ts:29`).

**Decision.** Reuse the existing four-role floor rather than inventing a demo-only code
path. Principal resolution is extended so an *unauthenticated* request resolves to a
**guest** ranked *below* `read-only`. Every route already passes through one gate,
`withOperator(handler, minRole)`, before its body runs: GET routes default to
`minRole = "read-only"` (a guest satisfies that), and every mutating route declares
`write`/`admin`/`super-admin` (a guest ranks below all of them → `403`). The mutation never
parses a body, never calls `enqueue*()`, and never reaches the credential-bearing worker.
Reads stay masked and errors scrubbed on the way back (`lib/api.ts:54`), so a guest sees no
secret or stack trace.

**Consequences (good).** The demo is safe **because the same RBAC floor that protects the
real tool protects the demo** — there is no separate, weaker demo authorization surface to
get wrong. A hand-crafted `POST` from the network tab still `403`s. It composes with ADR-4:
even an authenticated operator cannot write to production, so a demo fleet is doubly fenced.
Adding the tier relaxes nothing; it only adds a rung that can read but never write.

**Consequences (bad).** Read routes must never leak a secret in a *read* payload, since a
guest can hit all of them — which is why config secrets are masked on read and errors are
scrubbed (SECURITY "Sensitive data"). The guest tier is a deployment-mode surface: a private
operator install simply doesn't resolve unauthenticated requests to a guest, and the same
gate then denies them outright.

**Status.** ✅ In effect.

---

**Related:** [Docs index](./README.md) · [Architecture](./ARCHITECTURE.md) · [Security](./SECURITY.md)
